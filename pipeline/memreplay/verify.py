"""memreplay verify <work>: measure how well a memory matches its video, and draw pictures to look at.

  reprojection   room points rendered from the recorded cameras vs the real frames (colour error, coverage)
  floor/scale    floor flatness, camera height vs the expected height
  objects        tracked centres projected into frames: inside the object's ViPE mask?
  physics        resting objects sit on a support (floor/table); a pause-and-drop settles above the collider
  pictures       verify/reproj_<idx>.jpg (real | points | difference), verify/map.png (top-down)
Writes <work>/verify/report.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from .handoff import Cameras, read_points_sequence
from .l0 import read_splat_ply_xyz_rgb
from .objects import Support
from .vipe_io import Frames, Vipe


def project(xyz: np.ndarray, K: np.ndarray, c2w: np.ndarray, w: int, h: int):
    w2c = np.linalg.inv(c2w)
    pc = xyz @ w2c[:3, :3].T + w2c[:3, 3]
    z = pc[:, 2]
    ok = z > 0.05
    u = K[0, 0] * pc[:, 0] / np.where(ok, z, 1) + K[0, 2]
    v = K[1, 1] * pc[:, 1] / np.where(ok, z, 1) + K[1, 2]
    ok &= (u >= 0) & (u < w - 0.5) & (v >= 0) & (v < h - 0.5)
    return u, v, z, ok


def render_points(xyz, rgb, K, c2w, w, h, radius_m: float = 0.012):
    """Z-buffered splat render of points as squares sized by their projected radius."""
    u, v, z, ok = project(xyz, K, c2w, w, h)
    img = np.zeros((h, w, 3), np.uint8)
    zbuf = np.full((h, w), np.inf, np.float32)
    idx = np.flatnonzero(ok)
    idx = idx[np.argsort(-z[idx])]                         # far first, near overwrite
    r = np.clip((K[0, 0] * radius_m / z[idx]).astype(int), 0, 6)
    ui, vi = np.round(u[idx]).astype(int), np.round(v[idx]).astype(int)
    for rr in range(0, 7):
        sel = r == rr
        if not sel.any():
            continue
        for dy in range(-rr, rr + 1):
            for dx in range(-rr, rr + 1):
                yy, xx = np.clip(vi[sel] + dy, 0, h - 1), np.clip(ui[sel] + dx, 0, w - 1)
                zz = z[idx][sel]
                closer = zz < zbuf[yy, xx]
                zbuf[yy[closer], xx[closer]] = zz[closer]
                img[yy[closer], xx[closer]] = rgb[idx][sel][closer]
    return img, np.isfinite(zbuf)


def reprojection(work: Path, n_frames: int = 6) -> dict:
    cams = Cameras.model_validate_json((work / "world" / "cameras.json").read_text()).frames
    xyz, rgb = read_splat_ply_xyz_rgb(work / "world" / "bg_points.ply")
    v = Vipe(work / "vipe")
    reader = Frames(work / "input" / "clip.mp4")
    out = work / "verify"
    out.mkdir(exist_ok=True)
    from .objects import scene_static_ids
    keep_in_room = scene_static_ids(work)
    errs, covs, pics = [], [], []
    cams = [c for c in cams if c.good] or cams
    picks = [cams[i] for i in np.linspace(0, len(cams) - 1, n_frames + 2).astype(int)[1:-1]]
    for c in picks:
        K, c2w = np.array(c.K).reshape(3, 3), np.array(c.c2w).reshape(4, 4)
        real = reader.get(c.idx)
        img, hit = render_points(xyz, rgb, K, c2w, c.w, c.h)
        st = v.static_mask(c.idx, extra_static=keep_in_room)
        static = hit & (st if st is not None else True)
        d = np.abs(img.astype(int) - real.astype(int)).mean(-1)
        errs.append(float(np.median(d[static])) if static.any() else None)
        covs.append(float(hit.mean()))
        diff = np.where(static[..., None], np.clip(d * 3, 0, 255).astype(np.uint8)[..., None].repeat(3, -1), 0)
        strip = np.concatenate([real, img, diff], 1)
        p = out / f"reproj_{c.idx:05d}.jpg"
        cv2.imwrite(str(p), cv2.cvtColor(cv2.resize(strip, None, fx=0.5, fy=0.5), cv2.COLOR_RGB2BGR))
        pics.append(p.name)
    good = [e for e in errs if e is not None]
    return {"median_abs_colour_error": float(np.median(good)) if good else None, "per_frame_error": errs,
            "coverage": float(np.mean(covs)), "pictures": pics}


def objects_check(work: Path) -> dict:
    """Each kept object's track, evaluated at the frames where ViPE saw it, projected into those frames:
    does it land on the object's mask? And does it rest on a support?"""
    p = work / "objects" / "objects.json"
    if not p.exists():
        return {"count": 0}
    objs = {o["id"]: o for o in json.loads(p.read_text())["objects"]}
    sel = {e["id"]: e for e in json.loads((work / "objects" / "selection.json").read_text())} \
        if (work / "objects" / "selection.json").exists() else {}
    cams = {c.idx: c for c in Cameras.model_validate_json((work / "world" / "cameras.json").read_text()).frames}
    v = Vipe(work / "vipe")
    support = Support(work)
    results = []
    for oid, o in objs.items():
        size = o["visual"].get("size", [0.1, 0.1, 0.1])
        half = size[1] / 2
        ts = np.array([k["t"] for k in o["track"]])
        P = np.array([k["p"] for k in o["track"]])
        e = sel.get(oid)
        sightings = [s for s in (e["obs"] if e else []) if not s["touches_border"]]   # whole views only
        sightings = sightings[:: max(1, len(sightings) // 40)]
        inside = tested = 0
        errs = []
        for ob in sightings:
            c = cams.get(ob["idx"])
            m = v.mask(ob["idx"])
            if c is None or m is None:
                continue
            obj_mask = np.isin(m, e["ids"])
            if obj_mask.sum() < 30:
                continue
            pos = np.array([np.interp(ob["idx"] / 30.0, ts, P[:, j]) for j in range(3)])
            u, vv, z, ok = project(pos[None], np.array(c.K).reshape(3, 3), np.array(c.c2w).reshape(4, 4), c.w, c.h)
            tested += 1
            ys, xs = np.nonzero(obj_mask)
            if ok[0]:
                ui, vi = int(round(u[0])), int(round(vv[0]))
                if (cv2.dilate(obj_mask.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0)[vi, ui]:
                    inside += 1
                errs.append(float(np.hypot(u[0] - xs.mean(), vv[0] - ys.mean())))
        last = o["track"][-1]
        gap = last["p"][1] - half - support(last["p"][0], last["p"][2])
        results.append({"id": oid, "label": o["label"], "shape": o["visual"].get("shape"), "mass": o["mass"],
                        "centre_in_mask_frac": round(inside / tested, 3) if tested else None, "frames_tested": tested,
                        "median_px_from_mask_centre": round(float(np.median(errs)), 1) if errs else None,
                        "rest_gap_to_support_m": round(gap, 3), "settles": drop_test(o, support)})
    return {"count": len(objs), "objects": results}


def drop_test(o: dict, support: Support, seconds: float = 3.0) -> dict:
    """Pause at the middle keyframe, hand its velocity to a point-mass sim with the room heightfield as ground."""
    k = o["track"][len(o["track"]) // 2]
    p, v = np.array(k["p"], float), np.array(k.get("v") or (0, 0, 0), float)
    half = o["visual"].get("size", [0.1, 0.1, 0.1])[1] / 2
    dt = 1 / 240
    for _ in range(int(seconds / dt)):
        v[1] -= 9.81 * dt
        p += v * dt
        ground = support(p[0], p[2]) + half
        if p[1] < ground:
            p[1] = ground
            v[1] = -0.3 * v[1]
            v[[0, 2]] *= 0.9
    return {"final_height_above_support_m": round(float(p[1] - half - support(p[0], p[2])), 3),
            "final_speed_m_s": round(float(np.linalg.norm(v)), 3)}


def top_down(work: Path) -> str:
    xyz, rgb = read_splat_ply_xyz_rgb(work / "world" / "bg_points.ply")
    cams = Cameras.model_validate_json((work / "world" / "cameras.json").read_text()).frames
    lo, hi = np.percentile(xyz[:, [0, 2]], 1, 0) - 0.5, np.percentile(xyz[:, [0, 2]], 99, 0) + 0.5
    scale = 900 / max(hi - lo)
    W, H = int((hi[0] - lo[0]) * scale) + 1, int((hi[1] - lo[1]) * scale) + 1
    img = np.full((H, W, 3), 255, np.uint8)
    order = np.argsort(xyz[:, 1])                          # higher points drawn last
    px = ((xyz[order][:, [0, 2]] - lo) * scale).astype(int)
    ok = (px[:, 0] >= 0) & (px[:, 0] < W) & (px[:, 1] >= 0) & (px[:, 1] < H)
    img[px[ok, 1], px[ok, 0]] = rgb[order][ok]
    path = np.array([[c.c2w[3], c.c2w[11]] for c in cams])
    pts = ((path - lo) * scale).astype(np.int32)
    cv2.polylines(img, [pts.reshape(-1, 1, 2)], False, (0, 120, 255), 2)
    cv2.circle(img, tuple(int(x) for x in pts[0]), 6, (0, 200, 0), -1)
    for frag in ("world/ghosts.json", "objects/objects.json"):
        p = work / frag
        if not p.exists():
            continue
        for o in json.loads(p.read_text())["objects"]:
            if o["visual"]["kind"] == "points-sequence":
                hz, frames = read_points_sequence(work / o["visual"]["url"])
                cs = np.array([f[0].astype(float).mean(0) for f in frames if len(f[0])])
                if len(cs):
                    q = ((cs[:, [0, 2]] - lo) * scale).astype(np.int32)
                    cv2.polylines(img, [q.reshape(-1, 1, 2)], False, (220, 0, 220), 2)
            else:
                q = ((np.array([k["p"] for k in o["track"]])[:, [0, 2]] - lo) * scale).astype(np.int32)
                cv2.polylines(img, [q.reshape(-1, 1, 2)], False, (255, 0, 0), 2)
                cv2.circle(img, tuple(int(x) for x in q[-1]), 5, (255, 0, 0), -1)
                cv2.putText(img, o["id"], tuple(int(x) + 6 for x in q[-1]), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 0, 0), 1)
    out = work / "verify" / "map.png"
    out.parent.mkdir(exist_ok=True)
    cv2.imwrite(str(out), cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    return out.name


def run(work: Path) -> dict:
    work = Path(work)
    world = json.loads((work / "world" / "world.json").read_text())
    rep = {"world": {"camera_height_m": world["median_camera_height_m"], "scale": world["scale"],
                     **{k: world["diagnostics"].get(k) for k in ("floor_found", "floor_flatness_rms_m", "floor_rms_m",
                                                                  "points_below_floor_frac", "camera_up_vs_floor_deg")}},
           "background": {"points": world["bgPointsCount"], "splats": world["bgSplatCount"]},
           "reprojection": reprojection(work), "objects": objects_check(work), "map": top_down(work)}
    g = work / "world" / "ghosts.json"
    rep["people"] = len(json.loads(g.read_text())["objects"]) if g.exists() else 0
    (work / "verify" / "report.json").write_text(json.dumps(rep, indent=2))
    return rep
