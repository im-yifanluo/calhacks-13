"""Clean-up for what the viewer shows.

Splats: a splat trained from a walk grows "floaters" right in front of the camera path (big, blurry blobs that only
make sense from one training view; in the lobby a white smear over a third of the view), plus giant or needle-thin
Gaussians far from the path. prune() removes
  - Gaussians whose centre is within NEAR_PATH m of the recorded camera path (nothing real sits inside the wearer's head),
  - Gaussians bigger than MAX_SCALE m, or needles (longest axis > 0.3 m and > 15x the middle one),
  - practically invisible ones (opacity < 0.002; faint Gaussians still build surfaces like floors), and anything
    > 80 m from the path.

Ghosts: Grounding DINO sometimes calls a patterned wall a "person". A real person is seen for >= 1 s, touches the
floor, and is 0.8-2.3 m tall; keep_ghost() checks that on the points-sequence file.

    memreplay clean <memory dir>     # prune the splats and filter the ghosts of a published memory, in place
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

NEAR_PATH = 0.35
MAX_SCALE = 3.0


def prune(data: np.ndarray, path_xyz: np.ndarray) -> np.ndarray:
    """Boolean keep-mask over a 3DGS PLY record array (x, y, z, scale_0..2 as log, opacity as logit)."""
    from scipy.spatial import cKDTree

    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    s = np.exp(np.stack([data["scale_0"], data["scale_1"], data["scale_2"]], 1).astype(np.float64))
    op = 1 / (1 + np.exp(-data["opacity"].astype(np.float64)))
    d = cKDTree(path_xyz).query(xyz, k=1)[0]
    srt = np.sort(s, axis=1)                                   # small, mid, big
    big, mid = srt[:, 2], np.maximum(srt[:, 1], 1e-6)
    keep = np.isfinite(xyz).all(1) & (d > NEAR_PATH) & (d < 80) & (big < MAX_SCALE) & (op > 0.002)
    keep &= ~((big > 0.3) & (big / mid > 15))                  # needles: one long axis (flat discs build floors)
    return keep


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


def keep_ghost(frames: list, hz: float) -> tuple[bool, str]:
    """frames: [(xyz, rgb)] per keyframe from read_points_sequence."""
    vis = [i for i, (p, _) in enumerate(frames) if len(p) >= 50]
    if len(vis) / hz < 1.0:
        return False, f"seen {len(vis) / hz:.1f} s"
    lows, heights = [], []
    for i in vis:
        y = np.asarray(frames[i][0], float)[:, 1]
        lows.append(np.percentile(y, 3))
        heights.append(np.percentile(y, 97) - np.percentile(y, 3))
    if np.median(lows) > 0.6:
        return False, f"floats {np.median(lows):.2f} m above the floor"
    h = float(np.percentile(heights, 75))
    if not 0.8 <= h <= 2.3:
        return False, f"{h:.2f} m tall"
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
        if (mdir / "world" / "cameras.json").exists():          # pipeline folders have it; published ones may not
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
