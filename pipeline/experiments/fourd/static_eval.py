#!/usr/bin/env python
"""Also: --frames <dir of t_%04d.ply> scores an exported 4D sequence (frame nearest each test time) the same way.
Render the main pipeline's static-room splat (3DGS PLY, world frame) at the 4DGS held-out cameras and score it
with the same metrics as post.py (PSNR / SSIM / LPIPS, people vs static pixels). Apples-to-apples comparison.
usage: python static_eval.py <static .ply> <dataset dir with cams.json> <work dir> <out json> [--renders dir]"""

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, "/workspace/memory-replay/pipeline")
sys.path.insert(0, "/workspace/4dgs/A/4DGaussians")
from gsplat import rasterization  # noqa: E402
from memreplay.vipe_io import PEOPLE_PHRASES, Vipe  # noqa: E402
from utils.loss_utils import ssim  # noqa: E402  (same SSIM as post.py)


def load_ply(path):
    with open(path, "rb") as f:
        hdr, props, n = b"", [], 0
        while True:
            line = f.readline()
            hdr += line
            t = line.decode().split()
            if t[:2] == ["element", "vertex"]:
                n = int(t[2])
            if t and t[0] == "property":
                props.append((t[2], {"float": "<f4", "uchar": "u1", "double": "<f8"}[t[1]]))
            if t and t[0] == "end_header":
                break
        a = np.frombuffer(f.read(), dtype=np.dtype(props), count=n)
    return a


def splat(v):
    names = v.dtype.names
    dev = "cuda"
    means = torch.tensor(np.stack([v["x"], v["y"], v["z"]], 1), device=dev)
    quats = torch.tensor(np.stack([v[f"rot_{i}"] for i in range(4)], 1), device=dev)
    scales = torch.exp(torch.tensor(np.stack([v[f"scale_{i}"] for i in range(3)], 1), device=dev))
    opac = torch.sigmoid(torch.tensor(v["opacity"], device=dev))
    dc = np.stack([v[f"f_dc_{i}"] for i in range(3)], 1)[:, None, :]
    nrest = len([k for k in names if k.startswith("f_rest_")])
    if nrest:
        rest = np.stack([v[f"f_rest_{i}"] for i in range(nrest)], 1).reshape(len(v), 3, nrest // 3).transpose(0, 2, 1)
        sh = np.concatenate([dc, rest], 1)
    else:
        sh = dc
    deg = int(round(np.sqrt(sh.shape[1]))) - 1
    return means, quats, scales, opac, torch.tensor(np.ascontiguousarray(sh), device=dev), deg, len(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ply")
    ap.add_argument("data")
    ap.add_argument("work")
    ap.add_argument("out")
    ap.add_argument("--renders", default="")
    ap.add_argument("--frames", default="", help="exported per-time PLYs (t_%%04d.ply @ --fps); ply arg ignored")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument(
        "--gt-video",
        action="store_true",
        help="ground truth = current work/input/clip.mp4 (OpenCV decode)"
        " instead of the 4DGS training PNGs (the clip was re-normalized after 4DGS training)",
    )
    ap.add_argument("--bg", type=float, default=0.0, help="background grey level (4DGaussians trained on white = 1)")
    a = ap.parse_args()
    cache = {}

    def gaussians(path):
        if path not in cache:
            cache.clear()
            cache[path] = splat(load_ply(path))
        return cache[path]

    meta = json.loads((Path(a.data) / "cams.json").read_text())
    vp = Vipe(Path(a.work) / "vipe")
    pid = vp.ids_with(PEOPLE_PHRASES)
    dev = "cuda"
    try:
        import lpips

        lp = lpips.LPIPS(net="alex", verbose=False).to(dev)
    except Exception:  # noqa: BLE001
        lp = None
    rows = []
    if a.renders:
        Path(a.renders).mkdir(parents=True, exist_ok=True)
    reader = None  # the source video, opened on first use with --gt-video
    for c in [c for c in meta["cams"] if c["split"] == "test"]:
        if a.frames:
            n = len(list(Path(a.frames).glob("t_*.ply")))
            ply = str(Path(a.frames) / f"t_{min(int(round(c['t'] * a.fps)), n - 1):04d}.ply")
        else:
            ply = a.ply
        means, quats, scales, opac, colors, deg, ng = gaussians(ply)
        c2w = np.array(c["c2w"]).reshape(4, 4)
        w2c = torch.tensor(np.linalg.inv(c2w), dtype=torch.float32, device=dev)
        K = torch.tensor(np.array(c["K"]).reshape(3, 3), dtype=torch.float32, device=dev)
        W, H = c["w"], c["h"]
        img, _, _ = rasterization(
            means,
            quats,
            scales,
            opac,
            colors,
            w2c[None],
            K[None],
            W,
            H,
            sh_degree=deg,
            near_plane=0.01,
            far_plane=1e3,
            render_mode="RGB",
            backgrounds=torch.full((1, 3), a.bg, device=dev),
        )
        img = img[0].clamp(0, 1).permute(2, 0, 1)
        if a.gt_video:
            from memreplay.vipe_io import Frames

            if reader is None:
                reader = Frames(Path(a.work) / "input" / "clip.mp4")
            rgb = reader.get(c["idx"])
        else:
            rgb = cv2.cvtColor(cv2.imread(str(Path(a.data) / "rgb" / "2x" / f"{c['idx']:05d}.png")), cv2.COLOR_BGR2RGB)
        gt = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).float().to(dev) / 255
        se = ((img - gt) ** 2).mean(0)
        row = {
            "idx": c["idx"],
            "psnr": -10 * math.log10(max(se.mean().item(), 1e-10)),
            "ssim": ssim(img[None], gt[None]).item(),
        }
        if lp is not None:
            row["lpips"] = lp(img[None] * 2 - 1, gt[None] * 2 - 1).item()
        m = vp.mask(c["idx"])
        if m is not None:
            if m.shape != (H, W):
                m = cv2.resize(m, (W, H), interpolation=cv2.INTER_NEAREST)
            pm = torch.from_numpy(np.isin(m, pid)).to(dev)
            if pm.sum() > 100:
                row["psnr_people"] = -10 * math.log10(max(se[pm].mean().item(), 1e-10))
            row["psnr_static"] = -10 * math.log10(max(se[~pm].mean().item(), 1e-10))
        X = torch.cat([img.reshape(3, -1).T, torch.ones(W * H, 1, device=dev)], 1).double()
        Mx = torch.linalg.lstsq(X, gt.reshape(3, -1).T.double()).solution
        cm = (X @ Mx).float().clamp(0, 1).T.reshape(3, H, W)
        row["psnr_colour_matched"] = -10 * math.log10(max(((cm - gt) ** 2).mean().item(), 1e-10))
        rows.append(row)
        if a.renders:
            o = (img.permute(1, 2, 0).cpu().numpy() * 255 + 0.5).astype(np.uint8)
            cv2.imwrite(str(Path(a.renders) / f"{c['idx']:05d}.jpg"), cv2.cvtColor(o, cv2.COLOR_RGB2BGR))
    mean = {
        k: float(np.mean([r[k] for r in rows if k in r]))
        for k in ["psnr", "ssim", "lpips", "psnr_people", "psnr_static", "psnr_colour_matched"]
        if any(k in r for r in rows)
    }
    res = {
        "ply": a.frames or a.ply,
        "num_gaussians": ng,
        "sh_degree": deg,
        "num_test": len(rows),
        "mean": mean,
        "per_frame": rows,
    }
    Path(a.out).write_text(json.dumps(res, indent=1))
    print(json.dumps(mean))


if __name__ == "__main__":
    main()
