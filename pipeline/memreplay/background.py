"""S6 background splat: gsplat (MCMC) on our world-frame cameras with people and props masked out of the loss.

prepare()  <work>/colmap/{images,masks,sparse/0} from cameras.json, ViPE masks and bg_points.ply
train()    runs gsplat's examples/simple_trainer.py through train_splat.py (adds per-image masks)
convert()  last PLY -> world/bg.spz with splat-transform (<= 300k splats)
"""

from __future__ import annotations

import os
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
# Depth supervision from ViPE (gsplat --depth_loss on points sampled from each frame's depth): without it the
# Gaussians of a forward walk (corridor) stretch along the walking direction. MEMREPLAY_DEPTH_LOSS=0 turns it off.
DEPTH_LOSS = os.environ.get("MEMREPLAY_DEPTH_LOSS", "1") == "1"
DEPTH_LAMBDA = 1e-2
# Outdoors the sky used to be masked out of the loss (no depth), and nearby Gaussians smeared across it. Now sky
# pixels stay in the loss and are seeded on a dome SKY_DISTANCE metres out, so the trainer puts sky colour there.
SKY_DOME = os.environ.get("MEMREPLAY_SKY_DOME", "1") == "1"
SKY_DISTANCE = 150.0
CAP = 300_000
# static mode: the walk-through room. Only people/hands are masked (props stay in the room), more frames and
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
        window = frames[a : max(b, a + 1)]
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
    from .objects import scene_static_ids
    from .vipe_io import HAND_PHRASES, PEOPLE_PHRASES

    if static:  # everything but people and hands belongs to the room, the sky included (SKY_DOME below)
        movers = set(v.ids_with(PEOPLE_PHRASES | HAND_PHRASES))
        keep_in_room = [i for i in v.phrases if i > 0 and i not in movers]
        if SKY_DOME:
            keep_in_room += [i for i in v.sky_ids if i not in keep_in_room]
    else:
        keep_in_room = scene_static_ids(work)
    c0 = chosen[0]
    K = np.array(c0.K).reshape(3, 3)
    # ViPE puts pixel centres at integer coordinates; COLMAP/gsplat at +0.5
    (col / "sparse/0/cameras.txt").write_text(
        f"1 PINHOLE {c0.w} {c0.h} {K[0, 0]:.6f} {K[1, 1]:.6f} {K[0, 2] + 0.5:.6f} {K[1, 2] + 0.5:.6f}\n"
    )
    obs = {}  # image id -> [(u, v, point3D id)], for POINTS2D
    tracks = None
    if DEPTH_LOSS:
        # seed points sampled from ViPE's depth, one track per point, so gsplat's --depth_loss can supervise the
        # rendered depth at those pixels (the fix for Gaussians stretched along the walking direction)
        seed_xyz, seed_rgb, tracks, uv = depth_points(work, v, chosen, reader)
        for j, (img, (u, vv)) in enumerate(zip(tracks, uv), start=1):
            obs.setdefault(int(img), []).append((float(u), float(vv), j))
    lines = []
    for i, c in enumerate(chosen, start=1):
        name = f"{c.idx:05d}"
        rgb = reader.get(c.idx)
        cv2.imwrite(
            str(col / "images" / f"{name}.jpg"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95]
        )
        static = v.static_mask(
            c.idx, margin_px=12, extra_static=keep_in_room
        )  # wider: passers-by were leaving streaks in the room
        if static is None:
            static = np.ones(rgb.shape[:2], bool)
        cv2.imwrite(str(col / "masks" / f"{name}.png"), static.astype(np.uint8) * 255)
        c2w = np.array(c.c2w).reshape(4, 4)
        w2c = np.linalg.inv(c2w)
        q = _quat_wxyz(w2c[:3, :3])
        t = w2c[:3, 3]
        pts2d = " ".join(f"{u:.2f} {vv:.2f} {pid}" for u, vv, pid in obs.get(i, []))
        lines.append(
            f"{i} {q[0]:.9f} {q[1]:.9f} {q[2]:.9f} {q[3]:.9f} {t[0]:.9f} {t[1]:.9f} {t[2]:.9f} 1 {name}.jpg\n{pts2d}\n"
        )
    (col / "sparse/0/images.txt").write_text("".join(lines))
    if not DEPTH_LOSS:
        seed_xyz, seed_rgb = read_splat_ply_xyz_rgb(work / "world" / "bg_points.ply")
        if len(seed_xyz) > INIT_POINTS:
            sel = np.random.default_rng(0).choice(len(seed_xyz), INIT_POINTS, replace=False)
            seed_xyz, seed_rgb = seed_xyz[sel], seed_rgb[sel]
    pos_in_image = {}  # point id -> its index in that image's POINTS2D
    for img, lst in obs.items():
        for k, (_, _, pid) in enumerate(lst):
            pos_in_image[pid] = k
    with open(col / "sparse/0/points3D.txt", "w") as f:
        for i, (p, c) in enumerate(zip(seed_xyz, seed_rgb), start=1):  # (the image loop above reuses `rgb`)
            track = f" {tracks[i - 1]} {pos_in_image[i]}" if tracks is not None else ""
            f.write(f"{i} {p[0]:.5f} {p[1]:.5f} {p[2]:.5f} {c[0]} {c[1]} {c[2]} 0{track}\n")
    print(
        f"[background] colmap dir: {len(chosen)} images, {len(seed_xyz)} seed points"
        + (" (from ViPE depth, with tracks)" if tracks is not None else "")
    )
    return col


def depth_points(work: Path, v, chosen: list, reader) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """~INIT_POINTS world-frame points sampled on a grid from ViPE's depth of the chosen frames (static pixels,
    not on depth edges, closer than MAX_DEPTH), with the 1-based COLMAP image id that saw each. Every image gets
    at least one point (gsplat's depth loader indexes by image). Also returns each point's pixel (u, v)."""
    from .vipe_io import backproject, depth_edges, transform
    from .world import MAX_DEPTH, WorldPoses

    wp = WorldPoses(work)
    per = int(np.clip(INIT_POINTS // max(1, len(chosen)), 300, 1500))
    pts, cols, ids, uvs = [], [], [], []
    for i, c in enumerate(chosen, start=1):
        d = v.depth(c.idx) * wp.depth_scale(c.idx)
        rgb = reader.get(c.idx)
        if rgb.shape[:2] != d.shape:
            rgb = cv2.resize(rgb, (d.shape[1], d.shape[0]), interpolation=cv2.INTER_AREA)
        stride = max(2, int(np.ceil(np.sqrt(d.shape[0] * d.shape[1] / per))))
        sel = (d < MAX_DEPTH) & ~depth_edges(d)
        st = v.static_mask(c.idx, d, margin_px=4)
        if st is not None:
            sel &= st
        p, vv, uu = backproject(d, v.K(c.idx), sel, stride=stride)
        if len(p) == 0:
            p, vv, uu = backproject(d, v.K(c.idx), np.isfinite(d) & (d > 0), stride=stride)
        if len(p) == 0:
            continue
        if SKY_DOME and v.sky_ids:
            # the sky has no depth: seed it far away along the rays (a dome) so the trainer fits sky colour there
            # instead of smearing nearby Gaussians across it; the depth loss then also holds it at that distance
            m = v.mask(c.idx)
            sky = np.isin(m, v.sky_ids) & ~(d < 20.0) if m is not None else None
            if sky is not None and sky.any():
                ps, vs, us = backproject(np.full_like(d, SKY_DISTANCE), v.K(c.idx), sky, stride=stride * 2)
                if len(ps):
                    p = np.concatenate([p, ps])
                    vv = np.concatenate([vv, vs])
                    uu = np.concatenate([uu, us])
        pts.append(transform(wp.c2w(c.idx), p))
        cols.append(rgb[vv, uu])
        ids.append(np.full(len(p), i, np.int32))
        uvs.append(np.stack([uu, vv], 1))
    return np.concatenate(pts), np.concatenate(cols), np.concatenate(ids), np.concatenate(uvs)


def train(work: Path, steps_scaler: float = 0.25, static: bool = False) -> Path:
    work = Path(work)
    out = work / ("gsplat_static" if static else "gsplat")
    env = dict(os.environ)
    cap = STATIC["cap"] if static else CAP
    cmd = [
        sys.executable,
        "-m",
        "memreplay.train_splat",
        "mcmc",
        "--data_dir",
        str(work / "colmap"),
        "--data_factor",
        "1",
        "--result_dir",
        str(out),
        "--strategy.cap-max",
        str(cap),
        "--steps_scaler",
        str(steps_scaler),
        "--save_ply",
        "--disable_viewer",
        "--no-normalize-world-space",
        "--app_opt",
    ]
    # --app_opt (per-image appearance embedding) is lost at export, so colours come out a little averaged, but without
    # it the MCMC training diverges on these auto-exposed phone clips: the loss climbs after ~20 % of the steps and
    # 85 % of the Gaussians end with opacity < 0.002 (room corner: 390k usable Gaussians with it, 13k without)
    if static:  # refine ViPE's poses; evaluate on held-out frames at the end
        steps = int(30_000 * steps_scaler)
        # gsplat's default pose_opt_lr (1e-5) moves cameras only ~2 mm; 1e-3 let the whole splat drift away from the
        # held-out cameras (room corner PSNR 19 -> 8), so path drift is left to S3's levelling instead
        # gsplat multiplies eval_steps by steps_scaler itself, so pass the unscaled count to evaluate at the end
        cmd += ["--pose_opt", "--test_every", str(STATIC["test_every"]), "--eval_steps", "30000"]
        if DEPTH_LOSS:
            cmd += ["--depth_loss", "--depth_lambda", str(DEPTH_LAMBDA)]
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
    work = Path(work).resolve()  # train_splat changes directory
    FramesInfo.model_validate_json((Path(work) / "input" / "frames.json").read_text())
    if steps_scaler is None:
        steps_scaler = STATIC["steps_scaler"] if static else 0.25
    prepare(work, static)
    ply = train(work, steps_scaler, static)
    if static:
        from . import bake

        ply = bake.run(work) or ply  # colours at the mean appearance, not the zero one
    convert(work, ply, static)
