"""S3 world frame: ViPE's arbitrary frame -> meters, +Y up, floor at y = 0, wearer starting at the origin
looking down -Z (three.js forward). Writes world/world.json and world/cameras.json (keyframes)."""
from __future__ import annotations

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


def static_points(v: Vipe, frame_ids: np.ndarray, stride: int = 6, max_depth: float = MAX_DEPTH) -> np.ndarray:
    """Background (mask id 0) points in ViPE's frame from the given frames."""
    out = []
    for idx in frame_ids:
        d = v.depth(int(idx))
        sel = (d < max_depth) & ~depth_edges(d)
        m = v.mask(int(idx))
        if m is not None:
            sel &= ~dilate(m > 0, 4)
        p, _, _ = backproject(d, v.K(int(idx)), sel, stride=stride)
        out.append(transform(v.c2w(int(idx)), p))
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


def choose_floor(planes: list[dict], cam_pos: np.ndarray) -> dict | None:
    """The lowest plane with real support that leaves the cameras 0.4-2.6 m above it."""
    if not planes:
        return None
    top = max(p["count"] for p in planes)
    ok = []
    for p in planes:
        h = np.median(cam_pos @ p["n"] - p["d"])
        if p["count"] >= max(800, 0.12 * top) and 0.4 < h < 2.6:
            ok.append((p["d"], p))
    return min(ok, key=lambda x: x[0])[1] if ok else None


def rotation_to(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rotation matrix taking unit vector a onto unit vector b."""
    v = np.cross(a, b)
    c = float(a @ b)
    if c < -0.999999:
        axis = _unit(np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]))
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def run(work: Path) -> WorldInfo:
    work = Path(work)
    v = Vipe(work / "vipe")
    frames = FramesInfo.model_validate_json((work / "input" / "frames.json").read_text())
    cap = CaptureInfo.model_validate_json((work / "capture.json").read_text()) if (work / "capture.json").exists() else None
    inds, C = v.poses
    cam_pos = C[:, :3, 3]
    up_cam = _unit(np.mean(-C[:, :3, 1], axis=0))                 # camera "up" = -y (OpenCV), averaged

    sample = inds[np.linspace(0, len(inds) - 1, min(SAMPLE_FRAMES, len(inds))).astype(int)]
    P = static_points(v, sample)
    rng = np.random.default_rng(0)
    if len(P) > 300_000:
        P = P[rng.choice(len(P), 300_000, replace=False)]
    planes = horizontal_planes(P, up_cam)
    floor = choose_floor(planes, cam_pos)
    diag: dict = {"planes": [{"height": p["d"], "count": p["count"], "rms": p["rms"],
                              "tilt_from_camera_up_deg": float(np.degrees(np.arccos(np.clip(p["n"] @ up_cam, -1, 1))))}
                             for p in planes]}
    expected_h = cap.eye_height_m if cap else DEFAULT_CAMERA_HEIGHT
    if floor is not None:
        up, floor_d = floor["n"], floor["d"]
        diag.update(floor_found=True, floor_rms_m=floor["rms"], floor_points=floor["count"])
    else:   # never saw the floor: put it one camera height below the median camera
        up = up_cam
        floor_d = float(np.median(cam_pos @ up)) - expected_h
        diag.update(floor_found=False)
        print("[world] warning: no floor plane found; assuming the camera was held at the expected height")

    R = rotation_to(up, np.array([0.0, 1.0, 0.0]))
    # yaw: the first camera's forward (+z, OpenCV) projected on the floor becomes -Z
    f = R @ C[0, :3, 2]
    f[1] = 0
    if np.linalg.norm(f) < 1e-3:                                   # started looking straight down: use its "up" instead
        f = R @ -C[0, :3, 1]
        f[1] = 0
    f = _unit(f)
    yaw = np.arctan2(f[0], -f[2])                                   # Ry(yaw) @ f = (0, 0, -1)
    cy, sy = np.cos(yaw), np.sin(yaw)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    R = Ry @ R
    o = cam_pos[0] - (cam_pos[0] @ up - floor_d) * up                # first camera, dropped onto the floor

    heights = (cam_pos - o) @ up
    med_h = float(np.median(heights))
    scale = 1.0
    if floor is not None and med_h > 0 and abs(expected_h / med_h - 1) > 0.2:
        scale = expected_h / med_h
        print(f"[world] ViPE camera height {med_h:.2f} m vs expected {expected_h:.2f} m: rescaling by {scale:.3f}")
    T = np.eye(4)
    T[:3, :3] = scale * R
    T[:3, 3] = -scale * R @ o

    Pw = transform(T, P)
    lo, hi = np.percentile(Pw, 1, axis=0), np.percentile(Pw, 99, axis=0)
    floor_pts = Pw[np.abs(Pw[:, 1]) < 0.05]
    diag.update(camera_height_vipe_m=med_h, expected_camera_height_m=expected_h,
                floor_flatness_rms_m=float(np.sqrt(np.mean(floor_pts[:, 1] ** 2))) if len(floor_pts) else None,
                points_below_floor_frac=float(np.mean(Pw[:, 1] < -0.10)),
                camera_up_vs_floor_deg=float(np.degrees(np.arccos(np.clip(up @ up_cam, -1, 1)))))
    info = WorldInfo(T_vipe_to_world=T.reshape(-1).tolist(), scale=scale, floorY=0.0,
                     median_camera_height_m=med_h * scale, eye_height_m=cap.eye_height_m if cap else None,
                     boundsMin=tuple(lo.tolist()), boundsMax=tuple(hi.tolist()), diagnostics=diag)

    cams = []
    for idx in range(0, frames.frame_count, frames.key_stride):
        if idx > inds[-1]:
            break
        Cw = T @ v.c2w(idx)
        Cw[:3, :3] /= scale                                         # keep a pure rotation
        cams.append(CameraFrame(idx=idx, t=idx / frames.fps, w=frames.width, h=frames.height,
                                K=v.K(idx).reshape(-1).tolist(), c2w=Cw.reshape(-1).tolist()))
    (work / "world").mkdir(exist_ok=True)
    (work / "world" / "world.json").write_text(info.model_dump_json(indent=2))
    (work / "world" / "cameras.json").write_text(Cameras(frames=cams).model_dump_json())
    print(f"[world] floor {'found' if floor else 'ASSUMED'}; camera height {info.median_camera_height_m:.2f} m "
          f"(expected {expected_h:.2f}); scale {scale:.3f}; {len(cams)} keyframes")
    return info


def load_T(work: Path) -> np.ndarray:
    return np.array(json.loads((Path(work) / "world" / "world.json").read_text())["T_vipe_to_world"]).reshape(4, 4)
