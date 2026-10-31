"""Clean-up for what the viewer shows.

Splats: a splat trained from a walk grows "floaters" right in front of the camera path (big, blurry blobs that only
make sense from one training view; in the lobby a white smear over a third of the view), plus giant or needle-thin
Gaussians far from the path. prune() removes
  - Gaussians whose centre is within NEAR_PATH m of the recorded camera path (nothing real sits inside the wearer's head),
  - Gaussians bigger than MAX_SCALE m, or needles (longest axis > 0.12 m and > 8x the middle one),
  - practically invisible ones (opacity < 0.002; faint Gaussians still build surfaces like floors), and anything
    > MAX_DIST m from the path.
  Beyond FAR m (distant facades, the sky dome seeded SKY_DISTANCE m out by the background stage) Gaussians are
  coarse by nature: the size limit grows with distance, the needle and haze rules are off, and faint ones go.

Ghosts: Grounding DINO sometimes calls a patterned wall a "person". A real person is seen for >= 1 s, touches the
floor, and is 0.8-2.3 m tall; keep_ghost() checks that on the points-sequence file.

    memreplay clean <memory dir>     # prune the splats and filter the ghosts of a published memory, in place
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

NEAR_PATH = 0.5
MAX_SCALE = 1.5
FAR = 60.0  # m from the path: beyond this, far-field rules apply
FAR_SCALE_PER_M = 0.06  # size limit beyond FAR grows with distance (9 m for a sky Gaussian 150 m out)
MAX_DIST = 400.0  # m: nothing farther than this (the viewer's far plane is 200 m from the eye)
SKY_FILL = float(os.environ.get("MEMREPLAY_SKY_FILL", "2.5"))  # grow far sky Gaussians by this factor (1 = off)
SKY_MIN_OPACITY = 0.7  # and make them at least this opaque: a sky is smooth and sits behind everything
SKY_ABOVE_EYE = 5.0  # m above the camera path: below this a far Gaussian may be a facade, not sky
NEAR_BIG_RADIUS = 1.5  # m from the path
NEAR_BIG = 0.35  # m: a Gaussian this long, this close, is a floater (close surfaces are finely resolved)


def prune(data: np.ndarray, path_xyz: np.ndarray) -> np.ndarray:
    """Boolean keep-mask over a 3DGS PLY record array (x, y, z, scale_0..2 as log, opacity as logit)."""
    from scipy.spatial import cKDTree

    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    s = np.exp(np.stack([data["scale_0"], data["scale_1"], data["scale_2"]], 1).astype(np.float64))
    op = 1 / (1 + np.exp(-data["opacity"].astype(np.float64)))
    d = cKDTree(path_xyz).query(xyz, k=1)[0]
    srt = np.sort(s, axis=1)  # small, mid, big
    big, mid = srt[:, 2], np.maximum(srt[:, 1], 1e-6)
    far = d > FAR  # distant facades and the sky dome
    keep = np.isfinite(xyz).all(1) & (d > NEAR_PATH) & (d < MAX_DIST) & (op > 0.002)
    keep &= big < np.where(far, FAR_SCALE_PER_M * d, MAX_SCALE)  # giants (far ones may legitimately be metres across)
    keep &= far | ~((big > 0.12) & (big / mid > 8))  # needles: one long axis (flat discs build floors)
    keep &= far | ~((big > 0.6) & (op < 0.3))  # big, faint blobs: haze and light blooms
    keep &= ~(far & (op < 0.1))  # far and faint: never visible, only a cost
    keep &= ~((d < NEAR_BIG_RADIUS) & (big > NEAR_BIG))  # big blobs right in front of the camera: floaters
    return keep


def fill_sky(data: np.ndarray, path_xyz: np.ndarray) -> int:
    """Grow and firm up the sky dome, in place. The background stage seeds sky pixels 150 m out and the trainer
    leaves a few thousand opaque Gaussians there, 1-5 m across, with gaps between them that render as black holes
    in the sky. Far (> FAR m) Gaussians well above the camera path are the sky: scale them by SKY_FILL so neighbours
    overlap and raise their opacity to SKY_MIN_OPACITY. Returns how many were touched."""
    from scipy.spatial import cKDTree

    if SKY_FILL <= 1.0 or len(data) == 0:
        return 0
    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    op = 1 / (1 + np.exp(-data["opacity"].astype(np.float64)))
    d = cKDTree(path_xyz).query(xyz, k=1)[0]
    m = (d > FAR) & (xyz[:, 1] - np.median(path_xyz[:, 1]) > SKY_ABOVE_EYE) & (op > 0.1)
    if not m.any():
        return 0
    for k in ("scale_0", "scale_1", "scale_2"):
        data[k][m] = (data[k][m] + np.log(SKY_FILL)).astype(np.float32)
    o = np.maximum(op[m], SKY_MIN_OPACITY)
    data["opacity"][m] = np.log(o / (1 - o)).astype(np.float32)
    print(f"[layers] sky: grew {int(m.sum())} far Gaussians x{SKY_FILL:g} and set opacity >= {SKY_MIN_OPACITY}")
    return int(m.sum())


def seen_count(xyz: np.ndarray, cams: list, min_views: int = 2) -> np.ndarray:
    """How many recorded keyframes have each point inside their image (no occlusion test). cams: Cameras.frames.
    A Gaussian that only one or two frames saw was fitted to almost nothing and tends to be a streak."""
    n = np.zeros(len(xyz), np.int32)
    for c in cams:
        if not c.good:
            continue
        K = np.array(c.K).reshape(3, 3)
        w2c = np.linalg.inv(np.array(c.c2w).reshape(4, 4))
        pc = xyz @ w2c[:3, :3].T + w2c[:3, 3]
        z = pc[:, 2]
        ok = z > 0.1
        u = K[0, 0] * pc[:, 0] / np.where(ok, z, 1) + K[0, 2]
        v = K[1, 1] * pc[:, 1] / np.where(ok, z, 1) + K[1, 2]
        n += ok & (u >= 0) & (u < c.w) & (v >= 0) & (v < c.h)
    return n


def track_positions(memory: dict) -> np.ndarray:
    tr = memory["camera"]["track"]
    return np.array([k["p"] for k in tr], float) if isinstance(tr, list) else np.zeros((0, 3))


# splat-transform's -t/-r act in its own frame (Y and Z flipped relative to the 3DGS PLY frame), so a PLY
# translation of +y must be passed as -t 0,-y,0. Translate in numpy instead wherever possible.
def _convert(src: Path, dst: Path) -> None:
    exe = shutil.which("splat-transform")
    cmd = [exe] if exe else ["npx", "-y", "@playcanvas/splat-transform"]
    subprocess.run(cmd + ["-w", str(src), str(dst)], check=True, capture_output=True)


def prune_file(splat: Path, path_xyz: np.ndarray, cams: list | None = None, min_views: int = 2) -> tuple[int, int]:
    """Prune a .spz/.ply in place (floaters, giants, needles, and with cams: Gaussians seen by < min_views frames).
    Returns (before, after)."""
    from .layers import read_ply, write_ply

    with tempfile.TemporaryDirectory() as td:
        ply = Path(td) / "in.ply"
        if splat.suffix == ".ply":
            shutil.copy(splat, ply)
        else:
            _convert(splat, ply)
        data = read_ply(ply)
        keep = prune(data, path_xyz)
        if cams is not None:
            xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
            keep &= seen_count(xyz, cams) >= min_views
        out = Path(td) / "out.ply"
        write_ply(out, data[keep])
        if splat.suffix == ".ply":
            shutil.copy(out, splat)
        else:
            _convert(out, splat)
    return len(data), int(keep.sum())


def trim_frame(q: np.ndarray, radius: float = 1.0) -> np.ndarray:
    """A person's points within `radius` (xz) of their median: the mask often bleeds onto the wall or floor behind
    them, which lands metres away in 3D and stretches the ghost."""
    if len(q) < 10:
        return q
    med = np.median(q, 0)
    keep = np.hypot(q[:, 0] - med[0], q[:, 2] - med[2]) < radius
    return q[keep] if keep.sum() >= 10 else q


def trim_frames(frames: list, radius: float = 1.0) -> list:
    out = []
    for p, c in frames:
        if len(p) < 10:
            out.append((p, c))
            continue
        q = np.asarray(p, float)
        med = np.median(q, 0)
        keep = np.hypot(q[:, 0] - med[0], q[:, 2] - med[2]) < radius
        out.append((q[keep], np.asarray(c)[keep]) if keep.sum() >= 10 else (p, c))
    return out


def keep_ghost(frames: list, hz: float, ground=None) -> tuple[bool, str]:
    """frames: [(xyz, rgb)] per keyframe from read_points_sequence. A real person is 0.5-3.2 m tall (seated and
    partly hidden people included, depth noise included) and either stays in view for >= 1 s or clearly moves
    (>= 0.5 m); a patterned wall mistaken for a person is static and brief. "People" whose lowest point is > 0.6 m
    above the ground under them are ceiling fixtures or signs; `ground(x, z)` is the room collider's height there
    (a stage, a step), 0 without one."""
    vis = [i for i, (p, _) in enumerate(frames) if len(p) >= 50]
    if not vis:
        return False, "never seen"
    lows, heights, centres = [], [], []
    for i in vis:
        q = trim_frame(np.asarray(frames[i][0], float))
        lows.append(np.percentile(q[:, 1], 3))
        heights.append(np.percentile(q[:, 1], 97) - np.percentile(q[:, 1], 3))
        centres.append(np.median(q, 0))
    h = float(np.percentile(heights, 75))
    if not 0.5 <= h <= 3.2:
        return False, f"{h:.2f} m tall"
    above = [lo - (ground(float(c[0]), float(c[2])) if ground is not None else 0.0) for lo, c in zip(lows, centres)]
    if np.median(above) > 0.6:
        return False, f"floats {np.median(above):.2f} m above the ground"
    moved = float(np.linalg.norm(centres[-1] - centres[0])) if len(centres) > 1 else 0.0
    if len(vis) / hz < 1.0 and moved < 0.5:
        return False, f"seen {len(vis) / hz:.1f} s and static"
    return True, "ok"


def filter_ghosts(objects: list[dict], base: Path) -> tuple[list[dict], list[str]]:
    from .handoff import read_points_sequence

    kept, dropped = [], []
    for o in objects:
        if o["visual"]["kind"] == "points-sequence":
            hz, frames = read_points_sequence(Path(base) / o["visual"]["url"])
            ok, why = keep_ghost(frames, hz)
            if not ok:
                dropped.append(f"{o['id']} ({why})")
                continue
        kept.append(o)
    return kept, dropped


def clean_memory_dir(mdir: Path) -> dict:
    """Prune every background/prop splat a published memory references, and drop false ghosts, in place."""
    mdir = Path(mdir)
    report = {}
    done = set()
    for name in ("memory.static.json", "memory.json"):
        p = mdir / name
        if not p.exists():
            continue
        m = json.loads(p.read_text())
        path = track_positions(m)
        cams = None
        if (mdir / "world" / "cameras.json").exists():  # pipeline folders have it; published ones may not
            from .handoff import Cameras

            cams = Cameras.model_validate_json((mdir / "world" / "cameras.json").read_text()).frames
        bg = m["background"]["url"]
        if bg.endswith((".spz", ".ply")) and bg not in done and (mdir / bg).exists():
            before, after = prune_file(mdir / bg, path, cams)
            m["background"]["splatCount"] = after
            report[bg] = f"{before} -> {after}"
            done.add(bg)
        elif bg in done:
            m["background"]["splatCount"] = int(report[bg].split("-> ")[1])
        m["objects"], dropped = filter_ghosts(m["objects"], mdir)
        if dropped:
            report[f"{name} ghosts dropped"] = dropped
        p.write_text(json.dumps(m, indent=2))
    return report
