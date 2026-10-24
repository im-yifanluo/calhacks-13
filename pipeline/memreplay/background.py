"""S6 background splat: gsplat (MCMC) on our world-frame cameras with people and props masked out of the loss.

  prepare()  <work>/colmap/{images,masks,sparse/0} from cameras.json, ViPE masks and bg_points.ply
  train()    runs gsplat's examples/simple_trainer.py through train_splat.py (adds per-image masks)
  convert()  last PLY -> world/bg.spz with splat-transform (<= 300k splats)
"""
from __future__ import annotations

import os
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from .handoff import Cameras, FramesInfo, WorldInfo
from .l0 import read_splat_ply_xyz_rgb
from .vipe_io import Frames, Vipe, dilate

MAX_IMAGES = 300
INIT_POINTS = 150_000
CAP = 300_000
# static mode: the walk-through room. People, hands and moving props are masked; stationary props stay in it.
# More frames and
# Gaussians (Spark's default budget on Quest is 500k), longer training, camera poses refined, PSNR on held-out frames.
STATIC = {"images": 400, "cap": 500_000, "steps_scaler": 0.67, "test_every": 12, "out": "bg_static.spz"}


def _quat_wxyz(R: np.ndarray) -> np.ndarray:
    tr = np.trace(R)
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        q = [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        q = [(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
    elif R[1, 1] > R[2, 2]:
        s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        q = [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s]
    else:
        s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        q = [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def pick_frames(work: Path, cams: Cameras, n: int) -> list:
    """About n keyframes spread over the clip, taking the sharpest one in each window."""
    frames = [c for c in cams.frames if c.good]
    if len(frames) <= n:
        return frames
    reader = Frames(Path(work) / "input" / "clip.mp4")
    edges = np.linspace(0, len(frames), n + 1).astype(int)
    picked = []
    for a, b in zip(edges[:-1], edges[1:]):
        window = frames[a:max(b, a + 1)]
        scores = []
        for c in window:
            g = cv2.cvtColor(reader.get(c.idx), cv2.COLOR_RGB2GRAY)
            scores.append(cv2.Laplacian(cv2.resize(g, None, fx=0.5, fy=0.5), cv2.CV_64F).var())
        picked.append(window[int(np.argmax(scores))])
    return picked


def prepare(work: Path, static: bool = False) -> Path:
    work = Path(work)
    cams = Cameras.model_validate_json((work / "world" / "cameras.json").read_text())
    v = Vipe(work / "vipe")
    col = work / "colmap"
    if col.exists():
        shutil.rmtree(col)
    for d in ("images", "masks", "sparse/0"):
        (col / d).mkdir(parents=True)
    chosen = pick_frames(work, cams, STATIC["images"] if static else MAX_IMAGES)
    reader = Frames(work / "input" / "clip.mp4")
    from .objects import scene_static_ids, room_training_policy
    from .vipe_io import HAND_PHRASES, PEOPLE_PHRASES
    moving_ids = set(room_training_policy(work)["moving_ids"]) if static else set()
    if static:
        movers = set(v.ids_with(PEOPLE_PHRASES | HAND_PHRASES)) | moving_ids
        keep_in_room = [i for i in v.phrases if i > 0 and i not in movers]
    else:
        keep_in_room = scene_static_ids(work)
    c0 = chosen[0]
    K = np.array(c0.K).reshape(3, 3)
    # ViPE puts pixel centres at integer coordinates; COLMAP/gsplat at +0.5
    (col / "sparse/0/cameras.txt").write_text(
        f"1 PINHOLE {c0.w} {c0.h} {K[0, 0]:.6f} {K[1, 1]:.6f} {K[0, 2] + 0.5:.6f} {K[1, 2] + 0.5:.6f}\n")
    lines = []
    for i, c in enumerate(chosen, start=1):
        name = f"{c.idx:05d}"
        rgb = reader.get(c.idx)
        cv2.imwrite(str(col / "images" / f"{name}.jpg"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
        static = v.static_mask(c.idx, margin_px=5, extra_static=keep_in_room)
        if static is None:
            if moving_ids:
                raise ValueError(f"Missing masks for frame {c.idx}; cannot exclude moving props from background")
            static = np.ones(rgb.shape[:2], bool)
        cv2.imwrite(str(col / "masks" / f"{name}.png"), static.astype(np.uint8) * 255)
        c2w = np.array(c.c2w).reshape(4, 4)
        w2c = np.linalg.inv(c2w)
        q = _quat_wxyz(w2c[:3, :3])
        t = w2c[:3, 3]
        lines.append(f"{i} {q[0]:.9f} {q[1]:.9f} {q[2]:.9f} {q[3]:.9f} {t[0]:.9f} {t[1]:.9f} {t[2]:.9f} 1 {name}.jpg\n\n")
    (col / "sparse/0/images.txt").write_text("".join(lines))
    xyz, rgb = read_splat_ply_xyz_rgb(work / "world" / "bg_points.ply")
    if len(xyz) > INIT_POINTS:
        sel = np.random.default_rng(0).choice(len(xyz), INIT_POINTS, replace=False)
        xyz, rgb = xyz[sel], rgb[sel]
    with open(col / "sparse/0/points3D.txt", "w") as f:
        for i, (p, c) in enumerate(zip(xyz, rgb), start=1):
            f.write(f"{i} {p[0]:.5f} {p[1]:.5f} {p[2]:.5f} {c[0]} {c[1]} {c[2]} 0\n")
    print(f"[background] colmap dir: {len(chosen)} images, {len(xyz)} seed points")
    return col


def train(work: Path, steps_scaler: float = 0.25, static: bool = False) -> Path:
    work = Path(work)
    out = work / ("gsplat_static" if static else "gsplat")
    env = dict(os.environ)
    cap = STATIC["cap"] if static else CAP
    cmd = [sys.executable, "-m", "memreplay.train_splat", "mcmc", "--data_dir", str(work / "colmap"),
           "--data_factor", "1", "--result_dir", str(out), "--strategy.cap-max", str(cap),
           "--steps_scaler", str(steps_scaler), "--save_ply", "--app_opt", "--disable_viewer",
           "--no-normalize-world-space"]
    if static:   # refine ViPE's poses; evaluate on held-out frames at the end
        steps = int(30_000 * steps_scaler)
        cmd += ["--pose_opt", "--test_every", str(STATIC["test_every"]), "--eval_steps", str(steps)]
    else:
        cmd += ["--eval_steps", "-1", "--test_every", "100000"]
    subprocess.run(cmd, check=True, env=env)
    plys = sorted((out / "ply").glob("point_cloud_*.ply"), key=lambda p: int(p.stem.split("_")[-1]))
    if not plys:
        raise SystemExit("gsplat wrote no PLY")
    return plys[-1]


def convert(work: Path, ply: Path, static: bool = False) -> int:
    work = Path(work)
    out = work / "world" / (STATIC["out"] if static else "bg.spz")
    tmp = ply.parent.parent / "bg_capped.ply"
    cap = STATIC["cap"] if static else CAP
    subprocess.run(["splat-transform", "-w", str(ply), "--filter-nan", "--decimate", str(cap), str(tmp)], check=True)
    subprocess.run(["splat-transform", "-w", str(tmp), str(out)], check=True)
    raw = tmp.read_bytes()[:2000].decode(errors="ignore")
    n = int(next(ln.split()[-1] for ln in raw.splitlines() if ln.startswith("element vertex")))
    winfo = WorldInfo.model_validate_json((work / "world" / "world.json").read_text())
    if static:
        winfo.diagnostics["static_splat_count"] = n
    else:
        winfo.bgSplatCount = n
    (work / "world" / "world.json").write_text(winfo.model_dump_json(indent=2))
    print(f"[background] world/{out.name}: {n} splats")
    return n


def run(work: Path, steps_scaler: float | None = None, static: bool = False) -> None:
    work = Path(work).resolve()                                # train_splat changes directory
    FramesInfo.model_validate_json((Path(work) / "input" / "frames.json").read_text())
    if steps_scaler is None:
        steps_scaler = STATIC["steps_scaler"] if static else 0.25
    from .objects import room_training_policy
    policy = room_training_policy(work) if static else None
    policy_path = work / "world/background_policy.json"
    if static:
        policy_path.unlink(missing_ok=True)
    prepare(work, static)
    convert(work, train(work, steps_scaler, static), static)
    if static:
        policy_path.write_text(json.dumps(policy, indent=2))
