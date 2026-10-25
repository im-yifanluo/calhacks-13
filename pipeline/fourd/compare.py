#!/usr/bin/env python
"""Side-by-side for the write-up: rows = moments t, columns = video frame | main pipeline shot | 4DGS render from the
recorded camera (world/cameras.json keyframe nearest t), all 450x600; per-row PSNR of both renders vs the frame.
Run like post.py (4dgs venv, cwd 4DGaussians):
  python compare.py -m <run> --configs <cfg> --work /workspace/work/v59 --shots <dir with v59_<t>.png> --out x.jpg"""
import json
import math
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, "/workspace/4dgs/A")
sys.path.insert(0, "/workspace/4dgs/A/4DGaussians")
from post import (GaussianModel, ModelHiddenParams, ModelParams, PipelineParams, Scene, get_combined_args,  # noqa: E402
                  make_cam, merge_hparams, render)

TIMES = [1.5, 4.4, 7.3, 10.3, 13.2, 16.2]


def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2) / 255.0 ** 2
    return -10 * math.log10(max(mse, 1e-10))


def matched(a, ref):
    """a after the least-squares global colour map (3x3 + bias) onto ref: removes tone/exposure differences
    (the two methods were trained on differently tone-mapped versions of the clip), keeps structure errors."""
    X = np.concatenate([a.reshape(-1, 3).astype(np.float64), np.ones((a.shape[0] * a.shape[1], 1))], 1)
    M, *_ = np.linalg.lstsq(X, ref.reshape(-1, 3).astype(np.float64), rcond=None)
    return np.clip(X @ M, 0, 255).reshape(a.shape)


def label(img, text):
    out = img.copy()
    cv2.rectangle(out, (0, 0), (out.shape[1], 28), (0, 0, 0), -1)
    cv2.putText(out, text, (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def main():
    import mmengine
    parser = ArgumentParser()
    model, pipeline, hyper = ModelParams(parser, sentinel=True), PipelineParams(parser), ModelHiddenParams(parser)
    for k in ["--configs", "--work", "--shots", "--out", "--name", "--exposure"]:
        parser.add_argument(k, default="")
    parser.add_argument("--iteration", type=int, default=-1)
    parser.add_argument("--bg", type=float, default=-1, help="-1 = training background")
    args = get_combined_args(parser)
    args = merge_hparams(args, mmengine.Config.fromfile(args.configs))
    work = Path(args.work)
    frames = json.loads((work / "world" / "cameras.json").read_text())["frames"]
    fj = json.loads((work / "input" / "frames.json").read_text())
    max_idx = fj["frame_count"] - 1
    W, H = 450, 600
    rows, table = [], []
    with torch.no_grad():
        dataset = model.extract(args)
        g = GaussianModel(dataset.sh_degree, hyper.extract(args))
        Scene(dataset, g, load_iteration=args.iteration, shuffle=False)
        pipe = pipeline.extract(args)
        bgv = (1.0 if dataset.white_background else 0.0) if args.bg < 0 else args.bg
        bg = torch.full((3,), bgv, dtype=torch.float32, device="cuda")
        for t in TIMES:
            k = min(frames, key=lambda f: abs(f["t"] - t))
            raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t}", "-i", str(work / "input" / "clip.mp4"),
                                  "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                                 capture_output=True, check=True).stdout
            frame = np.frombuffer(raw, np.uint8).reshape(fj["height"], fj["width"], 3)
            frame = cv2.resize(frame, (W, H), interpolation=cv2.INTER_AREA)
            shot = cv2.cvtColor(cv2.imread(str(Path(args.shots) / f"v59_{t}.png")), cv2.COLOR_BGR2RGB)
            shot = cv2.resize(shot, (W, H), interpolation=cv2.INTER_AREA)
            c = {"idx": k["idx"], "c2w": k["c2w"], "K": k["K"], "w": k["w"], "h": k["h"]}
            img = render(make_cam(c, max_idx), g, pipe, bg, stage="fine", cam_type="nerfies")["render"].clamp(0, 1)
            if args.exposure:   # model trained on exposure-normalized frames: re-expose like the viewer's wearer view
                ge = torch.tensor(json.loads(Path(args.exposure).read_text())[str(k["idx"])], dtype=torch.float32,
                                  device="cuda")
                img = (img * ge[:3, None, None] + ge[3:, None, None]).clamp(0, 1)
            ours = (img.permute(1, 2, 0).cpu().numpy() * 255 + 0.5).astype(np.uint8)
            ours = cv2.resize(ours, (W, H), interpolation=cv2.INTER_AREA)
            from memreplay.vipe_io import Frames
            cvf = cv2.resize(Frames(work / "input" / "clip.mp4").get(k["idx"]), (W, H), interpolation=cv2.INTER_AREA)
            cv_main, cv_ours = psnr(shot, cvf), psnr(ours, cvf)
            p_main, p_ours = psnr(shot, frame), psnr(ours, frame)
            m_main, m_ours = psnr(matched(shot, frame), frame), psnr(matched(ours, frame), frame)
            table.append({"t": t, "keyframe_idx": k["idx"], "keyframe_t": k["t"], "psnr_main": p_main,
                          "psnr_4dgs": p_ours, "psnr_main_colour_matched": m_main, "psnr_4dgs_colour_matched": m_ours,
                          "psnr_main_vs_opencv_frame": cv_main, "psnr_4dgs_vs_opencv_frame": cv_ours,
                          "ffmpeg_vs_opencv_mean_abs_diff": float(np.abs(frame.astype(int) - cvf.astype(int)).mean())})
            rows.append(np.concatenate([label(frame, f"video t={t}s"),
                                        label(shot, f"main {p_main:.1f} dB (cm {m_main:.1f})"),
                                        label(ours, f"4DGS {p_ours:.1f} dB (cm {m_ours:.1f})")], 1))
    grid = np.concatenate(rows, 0)
    cv2.imwrite(args.out, cv2.cvtColor(grid, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
    Path(args.out).with_suffix(".json").write_text(json.dumps({"model": args.model_path, "bg": bgv, "rows": table,
                                                               "mean_psnr_main": float(np.mean([r["psnr_main"] for r in table])),
                                                               "mean_psnr_4dgs": float(np.mean([r["psnr_4dgs"] for r in table])),
                                                               "mean_psnr_main_colour_matched": float(np.mean([r["psnr_main_colour_matched"] for r in table])),
                                                               "mean_psnr_4dgs_colour_matched": float(np.mean([r["psnr_4dgs_colour_matched"] for r in table])),
                                                               "mean_psnr_main_vs_opencv_frame": float(np.mean([r["psnr_main_vs_opencv_frame"] for r in table])),
                                                               "mean_psnr_4dgs_vs_opencv_frame": float(np.mean([r["psnr_4dgs_vs_opencv_frame"] for r in table]))},
                                                              indent=1))
    print(json.dumps(table, indent=1))


if __name__ == "__main__":
    main()
