"""S3 world frame: ViPE's arbitrary frame -> meters, +Y up, floor at y = 0, wearer starting at the origin
looking down -Z (three.js forward). Writes world/world.json and world/cameras.json (keyframes)."""
from __future__ import annotations

import os

import json
from pathlib import Path

import numpy as np

from .handoff import CameraFrame, Cameras, CaptureInfo, FramesInfo, WorldInfo
from .vipe_io import Vipe, backproject, depth_edges, dilate, transform

MAX_DEPTH = 6.0          # m; farther depth is too noisy to place the floor with
SAMPLE_FRAMES = 80       # frames used for the floor fit
DEFAULT_CAMERA_HEIGHT = 1.45


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def static_points(v: Vipe, frame_ids: np.ndarray, stride: int = 6, max_depth: float = MAX_DEPTH,
                  to_world: "WorldPoses | None" = None) -> np.ndarray:
    """Static-scene points from the given frames, in ViPE's frame (or the final world frame with to_world)."""
    out = []
    for idx in frame_ids:
        if to_world is not None and not to_world.good(int(idx)):
            continue
        d = v.depth(int(idx)) * (to_world.depth_scale(int(idx)) if to_world is not None else 1.0)
        sel = (d < max_depth) & ~depth_edges(d)
        st = v.static_mask(int(idx), d, margin_px=4)
        if st is not None:
            sel &= st
        p, _, _ = backproject(d, v.K(int(idx)), sel, stride=stride)
        out.append(transform(to_world.c2w(int(idx)) if to_world is not None else v.c2w(int(idx)), p))
    return np.concatenate(out) if out else np.zeros((0, 3))


def horizontal_planes(P: np.ndarray, up: np.ndarray, max_tilt_deg: float = 30.0, thresh: float = 0.03,
                      n_planes: int = 5, iters: int = 1500, seed: int = 0) -> list[dict]:
    """Sequential RANSAC for planes whose normal is within max_tilt of `up`. Returns [{n, d, count, rms}]
    with n oriented along `up` and the plane n.x = d (d = height along up)."""
    rng = np.random.default_rng(seed)
    cos_max = np.cos(np.radians(max_tilt_deg))
    rest = P
    planes = []
    for _ in range(n_planes):
        if len(rest) < 500:
            break
        best, best_cnt = None, 0
        tri = rest[rng.integers(0, len(rest), size=(iters, 3))]
        normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        norms = np.linalg.norm(normals, axis=1)
        ok = norms > 1e-9
        normals[ok] /= norms[ok, None]
        normals *= np.sign(normals @ up)[:, None]
        ok &= normals @ up > cos_max
        sub = rest[rng.integers(0, len(rest), size=min(len(rest), 20000))]
        for n, p0 in zip(normals[ok], tri[ok, 0]):
            cnt = int(np.sum(np.abs(sub @ n - n @ p0) < thresh))
            if cnt > best_cnt:
                best_cnt, best = cnt, (n, n @ p0)
        if best is None:
            break
        n, d = best
        inl = np.abs(rest @ n - d) < thresh
        Q = rest[inl]
        c = Q.mean(0)                                            # refine with SVD on the inliers
        n2 = np.linalg.svd(Q - c, full_matrices=False)[2][-1]
        n2 = n2 * np.sign(n2 @ up)
        if n2 @ up > cos_max:
            n, d = n2, n2 @ c
            inl = np.abs(rest @ n - d) < thresh
        resid = rest[inl] @ n - d
        planes.append({"n": n, "d": float(d), "count": int(inl.sum()), "rms": float(np.sqrt(np.mean(resid ** 2)))})
        rest = rest[~inl]
    return planes


def choose_floor(planes: list[dict], cam_pos: np.ndarray, P: np.ndarray | None = None,
                 up_prior: np.ndarray | None = None, expected_h: float | None = None) -> dict | None:
    """Horizontal surfaces (floor, tables, seats) share one normal. Group the planes by normal (8 deg) and try the
    groups by total support; in a group take the lowest plane with real support that leaves the cameras 0.4-2.6 m
    above it and has almost nothing below it: at most 10 % of all points more than 0.1 m below (depth noise, the
    road below a kerb), or up to 25 % if the plane agrees with the camera-based up to 12 deg. A bed or desk top has
    a quarter of the room below it and, in our hotel room, sat 18 deg off the camera up; it must not win.
    None when no plane qualifies: the caller then assumes the camera was held at the expected height."""
    if not planes:
        return None

    def floor_like(p: dict) -> bool:
        p["below_frac"] = float(np.mean(P @ p["n"] - p["d"] < -0.10)) if P is not None else 0.0
        tilt = float(np.degrees(np.arccos(np.clip(p["n"] @ up_prior, -1, 1)))) if up_prior is not None else 0.0
        return p["below_frac"] <= 0.10 or (p["below_frac"] <= 0.25 and tilt <= 12.0)

    # With a known camera height (the device's eye height), prefer the lowest floor-like plane that puts the camera
    # within 0.6-1.6x of it: a stage top or a seat has the right normal and little below it, but leaves the camera
    # far too low (the stage clip: 1.13 m seen vs 1.75 m expected).
    if expected_h is not None:
        top = max(p["count"] for p in planes)
        dom = max(planes, key=lambda p: p["count"])["n"]
        pref = []
        for p in planes:
            h = float(np.median(cam_pos @ p["n"] - p["d"]))
            level = p["n"] @ dom > np.cos(np.radians(8)) or (up_prior is not None and p["n"] @ up_prior > np.cos(np.radians(12)))
            fl = floor_like(p)
            print(f"[world] floor candidate h={p['d']:+.2f} n={p['count']} cam_above={h:.2f} ratio={expected_h / h:.2f} "
                  f"level={bool(level)} floor_like={fl} below={p['below_frac']:.2f}")
            if level and p["count"] >= max(800, 0.2 * top) and 0.4 < h < 2.6 and fl and 0.6 <= expected_h / h <= 1.6:
                pref.append((p["d"], p))
        if pref:
            return min(pref, key=lambda x: x[0])[1]
    groups: list[list[dict]] = []
    for p in sorted(planes, key=lambda p: -p["count"]):
        for g in groups:
            if p["n"] @ g[0]["n"] > np.cos(np.radians(8)):
                g.append(p)
                break
        else:
            groups.append([p])
    for g in sorted(groups, key=lambda g: -sum(p["count"] for p in g)):
        top = max(p["count"] for p in g)
        ok = []
        for p in g:
            h = np.median(cam_pos @ p["n"] - p["d"])
            p["below_frac"] = float(np.mean(P @ p["n"] - p["d"] < -0.10)) if P is not None else 0.0
            tilt = float(np.degrees(np.arccos(np.clip(p["n"] @ up_prior, -1, 1)))) if up_prior is not None else 0.0
            floor_like = p["below_frac"] <= 0.10 or (p["below_frac"] <= 0.25 and tilt <= 12.0)
            if p["count"] >= max(800, 0.08 * top) and 0.4 < h < 2.6 and floor_like:
                ok.append((p["d"], p))
        if ok:
            return min(ok, key=lambda x: x[0])[1]
    return None


def up_prior(C: np.ndarray) -> tuple[np.ndarray, dict]:
    """Gravity 'up' from the cameras. A hand-held camera barely rolls, so its right axis (+x, OpenCV) stays
    horizontal: up is the direction most perpendicular to all right axes, whatever the pitch. That needs the
    camera to turn a little (yaw); otherwise fall back to the average camera up (-y), which pitch biases."""
    x = C[:, :3, 0]
    up_avg = _unit(np.mean(-C[:, :3, 1], axis=0))
    w, V = np.linalg.eigh(x.T @ x / len(x))                   # ascending eigenvalues
    u = V[:, 0] * np.sign(V[:, 0] @ up_avg)
    gap = float(w[1] / max(w[0], 1e-9))
    # With little yaw but some roll, the right axes move toward up and never toward forward, so the smallest
    # eigenvector is the forward axis. Real up is never far from the (pitch-biased) average camera up.
    use_right = gap > 4.0 and float(u @ up_avg) > np.cos(np.radians(50))
    return (u if use_right else up_avg), {"up_from": "camera right axes" if use_right else "camera up average",
                                          "right_axis_eigen_gap": gap,
                                          "avg_up_vs_right_up_deg": float(np.degrees(np.arccos(np.clip(u @ up_avg, -1, 1))))}


def rotation_to(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rotation matrix taking unit vector a onto unit vector b."""
    v = np.cross(a, b)
    c = float(a @ b)
    if c < -0.999999:
        axis = _unit(np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]))
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


# Per-frame depth-scale alignment: off. On our clips ViPE's pose errors leak into the depth ratios, and both
# a map-based and a pairwise version made reprojection worse (room clip 11 -> 17-20, see the write-up).
ALIGN_DEPTH = False
# Per-frame re-levelling against the floor seen below: fixes the stacked floors ViPE's drift leaves on long walks
# (the corridor path dipped 2 m). In a hotel room it once took the bed for the floor and moved frames by 0.78 m,
# because the floor fit itself had picked the bed (choose_floor now rejects planes with a third of the room below
# them) and the gate compared samples with their own median; both are fixed. gsplat's pose refinement then
# corrects what is left, and refine_poses exports the result for playback.
LEVEL_FRAMES = os.environ.get("MEMREPLAY_LEVEL_FRAMES", "1") == "1"   # export MEMREPLAY_LEVEL_FRAMES=0 to turn off
POSE_JUMP_M = 0.15       # a pose this far off the smoothed path is a tracking glitch
POSE_TURN_DEG = 20.0     # or a frame-to-frame turn this sharp (at 30 fps)


def pose_glitches(Cw: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Frames where ViPE's pose jumps off the smooth path. Returns (bad mask, smoothed positions)."""
    from scipy.ndimage import binary_dilation, median_filter

    P = Cw[:, :3, 3]
    Ps = median_filter(P, size=(15, 1), mode="nearest")
    bad = np.linalg.norm(P - Ps, axis=1) > POSE_JUMP_M
    R = Cw[:, :3, :3] / np.linalg.norm(Cw[:, :3, 0], axis=1)[:, None, None]
    tr = np.einsum("nij,nij->n", R[:-1], R[1:])
    turn = np.degrees(np.arccos(np.clip((tr - 1) / 2, -1, 1)))
    bad[1:] |= turn > POSE_TURN_DEG
    bad[:-1] |= turn > POSE_TURN_DEG
    return binary_dilation(bad, iterations=2), Ps


def floor_samples(v: Vipe, inds: np.ndarray, Cw: np.ndarray, good: np.ndarray, step: int = 15,
                  ds: np.ndarray | None = None) -> list[tuple[int, float]]:
    """(row, floor height) every `step` frames: the lowest dense layer of static points at least 0.6 m below
    the camera and within 5 m of it horizontally."""
    out = []
    for k in range(0, len(inds), step):
        if not good[k]:
            continue
        idx = int(inds[k])
        d = v.depth(idx) * (ds[k] if ds is not None else 1.0)
        st = v.static_mask(idx, d, 4)
        sel = (d < 6) & ~depth_edges(d) & (st if st is not None else True)
        p, _, _ = backproject(d, v.K(idx), sel, stride=6)
        pw = transform(Cw[k], p)
        cam = Cw[k, :3, 3]
        near = np.linalg.norm(pw[:, [0, 2]] - cam[[0, 2]], axis=1) < 5.0
        y = pw[near & (pw[:, 1] < cam[1] - 0.6), 1]
        if len(y) < 300:
            continue
        hist, e = np.histogram(y, bins=np.arange(y.min(), y.max() + 0.03, 0.03))
        if len(hist) < 3:
            continue
        hist = np.convolve(hist, [1, 2, 1], "same")
        b = int(np.flatnonzero(hist >= 0.35 * hist.max())[0])
        while b + 1 < len(hist) and hist[b + 1] > hist[b]:
            b += 1
        out.append((k, float(e[b] + 0.015)))
    return out


def align_depth_scales(v: Vipe, inds: np.ndarray, Cw: np.ndarray, good: np.ndarray, ds: np.ndarray,
                       step: int = 6, gaps: tuple[int, ...] = (6, 15, 30)) -> np.ndarray:
    """Per-frame depth scale from pairwise agreement. Static points of frame a, projected into frame b
    (0.2-1 s later), should have the depth b's own (dense) depth map gives there: s_b d_b = s_a z_ab.
    Each pair gives log s_b - log s_a = log(z_ab / d_b); solve all pairs in least squares with a weak
    smoothness term and the mean log-scale held at 0 (SLAM's metric scale). Unbiased by occlusions in
    sparse maps, since d_b is dense; nearby frames see nearly the same surfaces."""
    rows = [k for k in range(0, len(inds), step) if good[k]]
    if len(rows) < 6:
        return ds
    pos = {k: i for i, k in enumerate(rows)}
    eqs, rhs, wts = [], [], []
    cache = {}

    def frame(k):
        if k not in cache:
            idx = int(inds[k])
            d = v.depth(idx) * ds[k]
            st = v.static_mask(idx, d, 3)
            sel = (d < MAX_DEPTH) & ~depth_edges(d) & (st if st is not None else True)
            cache[k] = (d, sel, v.K(idx))
        return cache[k]

    for k in rows:
        da, sa, Ka = frame(k)
        p, _, _ = backproject(da, Ka, sa, stride=8)
        if len(p) < 300:
            continue
        pw = transform(Cw[k], p)
        for g in gaps:
            kb = k + g
            if kb not in pos:
                continue
            db, sb, Kb = frame(kb)
            w2c = np.linalg.inv(Cw[kb])
            pc = pw @ w2c[:3, :3].T + w2c[:3, 3]
            z = pc[:, 2]
            ok = z > 0.1
            u = np.round(Kb[0, 0] * pc[ok, 0] / z[ok] + Kb[0, 2]).astype(int)
            vv = np.round(Kb[1, 1] * pc[ok, 1] / z[ok] + Kb[1, 2]).astype(int)
            h, w = db.shape
            inb = (u >= 0) & (u < w) & (vv >= 0) & (vv < h)
            u, vv, zz = u[inb], vv[inb], z[ok][inb]
            keep = sb[vv, u]
            r = zz[keep] / db[vv[keep], u[keep]]
            r = r[(r > 0.6) & (r < 1.6)]
            if len(r) > 200:
                eqs.append((pos[k], pos[kb]))
                rhs.append(float(np.log(np.median(r))))
                wts.append(min(1.0, len(r) / 2000))
    if len(eqs) < len(rows) // 2:
        return ds
    n = len(rows)
    A, bvec = [], []
    for (i, j), r, wt in zip(eqs, rhs, wts):
        row = np.zeros(n)
        row[j], row[i] = wt, -wt
        A.append(row)
        bvec.append(wt * r)
    for i in range(n - 1):                                   # weak smoothness
        row = np.zeros(n)
        row[i + 1], row[i] = 0.3, -0.3
        A.append(row)
        bvec.append(0.0)
    A.append(np.full(n, 10.0 / n))                           # mean log-scale = 0
    bvec.append(0.0)
    x = np.linalg.lstsq(np.array(A), np.array(bvec), rcond=None)[0]
    s = np.exp(np.clip(x, np.log(0.8), np.log(1.25)))
    return ds * np.interp(np.arange(len(inds)), rows, s)


def run(work: Path) -> WorldInfo:
    from scipy.ndimage import median_filter

    work = Path(work)
    v = Vipe(work / "vipe")
    frames = FramesInfo.model_validate_json((work / "input" / "frames.json").read_text())
    cap = CaptureInfo.model_validate_json((work / "capture.json").read_text()) if (work / "capture.json").exists() else None
    expected_h = cap.eye_height_m if cap else DEFAULT_CAMERA_HEIGHT
    inds, C = v.poses
    cam_pos = C[:, :3, 3]
    up_cam, diag = up_prior(C)

    # 1. global frame: floor plane -> up and floor height; first camera -> origin and heading
    sample = inds[np.linspace(0, len(inds) - 1, min(SAMPLE_FRAMES, len(inds))).astype(int)]
    P = static_points(v, sample)
    rng = np.random.default_rng(0)
    if len(P) > 300_000:
        P = P[rng.choice(len(P), 300_000, replace=False)]
    planes = horizontal_planes(P, up_cam, max_tilt_deg=40.0, n_planes=10)
    floor = choose_floor(planes, cam_pos, P, up_cam, expected_h if cap else None)
    diag["planes"] = [{"height": p["d"], "count": p["count"], "rms": p["rms"], "below_frac": p.get("below_frac"),
                       "tilt_from_prior_deg": float(np.degrees(np.arccos(np.clip(p["n"] @ up_cam, -1, 1))))}
                      for p in planes]
    if floor is not None:
        up, floor_d = floor["n"], floor["d"]
        diag.update(floor_found=True, floor_rms_m=floor["rms"], floor_points=floor["count"])
    else:   # never saw the floor: put it one camera height below the median camera
        up = up_cam
        floor_d = float(np.median(cam_pos @ up)) - expected_h
        diag.update(floor_found=False)
        print("[world] warning: no floor plane found; assuming the camera was held at the expected height")
    R = rotation_to(up, np.array([0.0, 1.0, 0.0]))
    f = R @ C[0, :3, 2]                                              # first camera's forward (+z) on the floor -> -Z
    f[1] = 0
    if np.linalg.norm(f) < 1e-3:
        f = R @ -C[0, :3, 1]
        f[1] = 0
    f = _unit(f)
    yaw = np.arctan2(f[0], -f[2])                                   # Ry(yaw) @ f = (0, 0, -1)
    cy, sy = np.cos(yaw), np.sin(yaw)
    R = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]) @ R
    o = cam_pos[0] - (cam_pos[0] @ up - floor_d) * up                # first camera, dropped onto the floor
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = -R @ o
    Cw = np.einsum("ij,njk->nik", T, C)

    # 2. tracking glitches: leave those frames out of all geometry
    bad, Ps = pose_glitches(Cw)
    good = ~bad
    diag["bad_pose_frames"] = int(bad.sum())
    diag["bad_pose_frac"] = float(bad.mean())

    # 3. re-level: measure the floor every 0.5 s and shift each frame so the floor stays at y = 0
    def level(ds):
        # (an extra |y| < 0.3 m gate looked safe but dropped real floor samples on long, drifting walks; the
        # camera-height test below already rejects seats and tables)
        fs = floor_samples(v, inds, Cw, good, ds=ds)
        if len(fs) >= 3:
            # A hand-held camera stays at about the same height above the floor. A sample that would put the
            # camera > 0.2 m off its typical height saw a seat or table, not the floor (the floor was out of view).
            h = np.array([Cw[k, 1, 3] - y for k, y in fs])
            # ...measured against the camera height the floor fit gave (or, with no floor, the expected height):
            # the median of the samples themselves would follow a bed seen more often than the floor
            ref = float(np.median(Cw[good, 1, 3])) if good.any() else float(np.median(Cw[:, 1, 3]))
            keep = np.abs(h - ref) < 0.3
            diag["level_gate_ref_m"] = ref
            diag["level_rejected_samples"] = int((~keep).sum())
            fs = [s for s, ok in zip(fs, keep) if ok]
        if len(fs) < 3:
            return fs, np.zeros(len(inds))
        ks = np.array([k for k, _ in fs])
        fy = median_filter(np.array([y for _, y in fs]), size=5, mode="nearest")
        dy = -np.interp(np.arange(len(inds)), ks, fy)
        Cw[:, 1, 3] += dy
        Ps[:, 1] += dy
        return fs, dy

    fs, dy = (level(None) if LEVEL_FRAMES else ([], np.zeros(len(inds))))
    # 3b. per-frame depth scale: ViPE's dense depth wobbles by ~10 % from frame to frame on some clips;
    #     scale each frame's depth to agree with a map built from all frames (twice), then re-level
    ds = np.ones(len(inds))
    if ALIGN_DEPTH:
        for _ in range(2):
            ds = align_depth_scales(v, inds, Cw, good, ds)
    fs2, dy2 = (level(ds) if LEVEL_FRAMES else ([], np.zeros(len(inds))))
    dy = dy + dy2
    diag.update(level_samples=len(fs), level_offset_range_m=[float(dy.min()), float(dy.max())] if len(fs) >= 3 else None,
                level_offset_std_m=float(dy.std()), depth_scale_range=[float(ds.min()), float(ds.max())],
                depth_scale_std=float(ds.std()))

    # 4. scale: trust ViPE's metric depth unless the camera height is far from the expected height
    med_h = float(np.median(Cw[good, 1, 3])) if good.any() else float(np.median(Cw[:, 1, 3]))
    scale = 1.0
    lo_r, hi_r = (0.75, 1.25) if cap else (0.6, 1.7)              # without a measured height, only fix outliers
    if med_h > 0 and not (lo_r <= expected_h / med_h <= hi_r):
        scale = expected_h / med_h
        print(f"[world] camera height {med_h:.2f} m vs expected {expected_h:.2f} m: rescaling by {scale:.3f}")
    S = np.diag([scale, scale, scale, 1.0])
    Cw = np.einsum("ij,njk->nik", S, Cw)
    Ps *= scale
    T = S @ T

    (work / "world").mkdir(exist_ok=True)
    np.savez(work / "world" / "frames.npz", inds=inds, c2w=Cw, good=good, depth_scale=ds)

    # final snap: put the densest layer near y = 0 (the floor) exactly at 0
    wp = WorldPoses(work)
    Pw = static_points(v, sample, to_world=wp)
    near0 = Pw[np.abs(Pw[:, 1]) < 0.25, 1]
    if len(near0) > 500:
        hist, e = np.histogram(near0, bins=np.arange(-0.25, 0.2501, 0.01))
        peak = float(e[np.argmax(np.convolve(hist, [1, 2, 3, 2, 1], "same"))] + 0.005)
        Cw[:, 1, 3] -= peak
        Ps[:, 1] -= peak
        T[1, 3] -= peak
        Pw[:, 1] -= peak
        np.savez(work / "world" / "frames.npz", inds=inds, c2w=Cw, good=good, depth_scale=ds)
        wp = WorldPoses(work)
        diag["floor_snap_m"] = peak
    med_h = float(np.median(Cw[good, 1, 3])) / scale if good.any() else med_h
    lo, hi = np.percentile(Pw, 1, axis=0), np.percentile(Pw, 99, axis=0)
    floor_pts = Pw[np.abs(Pw[:, 1]) < 0.05]
    cam_y = med_h * scale
    high = Pw[Pw[:, 1] > cam_y + 0.4, 1]
    ceiling = None
    if len(high) > 0.02 * len(Pw):                                   # densest 4 cm layer above the cameras
        hist, edges = np.histogram(high, bins=np.arange(cam_y + 0.4, cam_y + 6.0, 0.04))
        if hist.max() > 0.25 * len(high) / 4:
            ceiling = float(edges[np.argmax(hist)] + 0.02)
    diag.update(ceiling_height_m=ceiling, camera_height_vipe_m=med_h, expected_camera_height_m=expected_h,
                floor_flatness_rms_m=float(np.sqrt(np.mean(floor_pts[:, 1] ** 2))) if len(floor_pts) else None,
                points_below_floor_frac=float(np.mean(Pw[:, 1] < -0.10)),
                camera_up_vs_floor_deg=float(np.degrees(np.arccos(np.clip(up @ up_cam, -1, 1)))))
    info = WorldInfo(T_vipe_to_world=T.reshape(-1).tolist(), scale=scale, floorY=0.0, median_camera_height_m=cam_y,
                     eye_height_m=cap.eye_height_m if cap else None,
                     boundsMin=tuple(lo.tolist()), boundsMax=tuple(hi.tolist()), diagnostics=diag)

    cams = []
    for idx in range(0, frames.frame_count, frames.key_stride):
        if idx > inds[-1]:
            break
        k = wp.row(idx)
        c = Cw[k].copy()
        c[:3, :3] /= scale                                           # a pure rotation for the head path
        if not good[k]:
            c[:3, 3] = Ps[k]                                         # glitch: use the smoothed position
        cams.append(CameraFrame(idx=idx, t=idx / frames.fps, w=frames.width, h=frames.height,
                                K=v.K(idx).reshape(-1).tolist(), c2w=c.reshape(-1).tolist(), good=bool(good[k])))
    (work / "world" / "world.json").write_text(info.model_dump_json(indent=2))
    (work / "world" / "cameras.json").write_text(Cameras(frames=cams).model_dump_json())
    print(f"[world] floor {'found' if floor else 'ASSUMED'}; camera height {cam_y:.2f} m (expected {expected_h:.2f}); "
          f"scale {scale:.3f}; {int(bad.sum())} glitch frames; re-levelled from {len(fs)} floor samples; "
          f"{len(cams)} keyframes")
    return info


class WorldPoses:
    """Final per-frame camera-to-world (meters, floor at 0; includes the scale) from S3, and which frames to trust."""

    def __init__(self, work: Path):
        z = np.load(Path(work) / "world" / "frames.npz")
        self.inds, self.C, self.ok = z["inds"], z["c2w"], z["good"]
        self.ds = z["depth_scale"] if "depth_scale" in z.files else np.ones(len(self.inds))
        self._row = {int(i): k for k, i in enumerate(self.inds)}

    def row(self, idx: int) -> int:
        k = self._row.get(int(idx))
        return k if k is not None else int(np.argmin(np.abs(self.inds - idx)))

    def c2w(self, idx: int) -> np.ndarray:
        return self.C[self.row(idx)]

    def good(self, idx: int) -> bool:
        return bool(self.ok[self.row(idx)])

    def depth_scale(self, idx: int) -> float:
        """Multiply ViPE's depth for this frame by this (S3's cross-frame alignment)."""
        return float(self.ds[self.row(idx)])


def load_T(work: Path) -> np.ndarray:
    return np.array(json.loads((Path(work) / "world" / "world.json").read_text())["T_vipe_to_world"]).reshape(4, 4)
