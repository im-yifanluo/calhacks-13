#!/usr/bin/env python
"""After 4DGaussians training: held-out metrics, videos, and per-time 3DGS export for the viewer.

Run from /workspace/4dgs/A/4DGaussians with the 4dgs venv:
  python /workspace/4dgs/post.py -m <run dir> --configs <cfg> --data <dataset dir> --work <work dir> --out <out dir>
      [--do eval,video,export] [--export_fps 10] [--max_gs 300000] [--to_world <4x4 json>]
Writes <out>/renders/*.png, metrics.json, video.mp4 (GT | 4DGS along the recorded path), video_fixedcam.mp4
(camera frozen mid-clip, time plays), frames/t_%04d.ply + .spz + frames.json, frames_dyn/ + static.ply (split).
"""

import json
import math
import subprocess
import sys
import time
from argparse import ArgumentParser
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, "/workspace/4dgs/A/4DGaussians")
sys.path.insert(0, "/workspace/memory-replay/pipeline")
import mmengine  # noqa: E402
from arguments import ModelHiddenParams, ModelParams, PipelineParams, get_combined_args  # noqa: E402
from gaussian_renderer import GaussianModel, render  # noqa: E402
from scene import Scene  # noqa: E402
from scene.cameras import Camera  # noqa: E402
from utils.graphics_utils import focal2fov  # noqa: E402
from utils.loss_utils import ssim  # noqa: E402
from utils.params_utils import merge_hparams  # noqa: E402
from utils.sh_utils import RGB2SH, eval_sh  # noqa: E402

LOG = "/workspace/logs/4dgs.log"


def log(msg):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} [4dgs] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def make_cam(c, max_idx, image=None, c2w=None, t=None):
    c2w = np.array(c["c2w"]).reshape(4, 4) if c2w is None else c2w
    R, C = c2w[:3, :3], c2w[:3, 3]
    T = -C @ R
    K = np.array(c["K"]).reshape(3, 3)
    W, H = c["w"], c["h"]
    img = torch.zeros(3, H, W) if image is None else image
    tt = c["idx"] / max_idx if t is None else t
    return Camera(
        colmap_id=c["idx"],
        R=R,
        T=T,
        FoVx=focal2fov(K[0, 0], W),
        FoVy=focal2fov(K[0, 0], H),
        image=img,
        gt_alpha_mask=None,
        image_name=f"{c['idx']:05d}",
        uid=c["idx"],
        data_device="cuda",
        time=tt,
    )


def load_rgb(data, idx):
    bgr = cv2.imread(str(Path(data) / "rgb" / "2x" / f"{idx:05d}.png"))
    return torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float() / 255.0


def to8(x):
    return (x.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255 + 0.5).astype(np.uint8)


class Video:
    def __init__(self, path, w, h, fps):
        self.p = subprocess.Popen(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-s",
                f"{w}x{h}",
                "-r",
                str(fps),
                "-i",
                "-",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-preset",
                "fast",
                str(path),
            ],
            stdin=subprocess.PIPE,
        )

    def add(self, rgb):
        self.p.stdin.write(np.ascontiguousarray(rgb).tobytes())

    def close(self):
        self.p.stdin.close()
        self.p.wait()


def quat_mul(a, b):  # (w,x,y,z)
    aw, ax, ay, az = a.unbind(-1)
    bw, bx, by, bz = b.unbind(-1)
    return torch.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        -1,
    )


def rot_to_quat(R):
    R = np.asarray(R, np.float64)
    w = math.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2, R[2, 1] - R[1, 2])
    y = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2, R[0, 2] - R[2, 0])
    z = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2, R[1, 0] - R[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def write_ply(path, xyz, fdc, op_logit, log_scale, quat):
    n = len(xyz)
    names = [
        "x",
        "y",
        "z",
        "f_dc_0",
        "f_dc_1",
        "f_dc_2",
        "opacity",
        "scale_0",
        "scale_1",
        "scale_2",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3",
    ]
    a = np.concatenate([xyz, fdc, op_logit, log_scale, quat], 1).astype("<f4")
    hdr = (
        f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n"
        + "".join(f"property float {k}\n" for k in names)
        + "end_header\n"
    )
    with open(path, "wb") as f:
        f.write(hdr.encode())
        f.write(a.tobytes())


def main():
    parser = ArgumentParser()
    model = ModelParams(parser, sentinel=True)
    pipeline = PipelineParams(parser)
    hyper = ModelHiddenParams(parser)
    parser.add_argument("--iteration", default=-1, type=int)
    parser.add_argument("--configs", type=str, required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--do", default="eval,video,export")
    parser.add_argument("--export_fps", type=float, default=10.0)
    parser.add_argument("--max_gs", type=int, default=300_000)
    parser.add_argument("--dyn_thresh", type=float, default=0.03, help="m of motion over the clip = dynamic")
    parser.add_argument("--to_world", default="", help="json file with a 4x4 similarity training->world")
    parser.add_argument("--keep_ply", type=int, default=1, help="0: delete the PLYs once the spz files exist")
    parser.add_argument("--dyn_out", type=int, default=1, help="0: skip frames_dyn/ + static.ply when not split")
    parser.add_argument("--bake_view", type=int, default=1, help="bake SH colour seen from the recorded camera")
    parser.add_argument(
        "--gs_scale_div",
        type=float,
        default=1.0,
        help="divide Gaussian sizes by this at export (run a: cameras had scale s in the rotation)",
    )
    args = get_combined_args(parser)
    args = merge_hparams(args, mmengine.Config.fromfile(args.configs))
    do = set(args.do.split(","))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((Path(args.data) / "cams.json").read_text())
    cams, max_idx, fps = meta["cams"], meta["max_idx"], meta["fps"]
    with torch.no_grad():
        dataset = model.extract(args)
        gaussians = GaussianModel(dataset.sh_degree, hyper.extract(args))
        scene = Scene(dataset, gaussians, load_iteration=args.iteration, shuffle=False)
        pipe = pipeline.extract(args)
        bg = torch.tensor([1, 1, 1] if dataset.white_background else [0, 0, 0], dtype=torch.float32, device="cuda")
        N = gaussians.get_xyz.shape[0]
        log(f"post: loaded {args.model_path} iter {scene.loaded_iter}: {N} Gaussians")
        metrics_path = out / "metrics.json"
        M = json.loads(metrics_path.read_text()) if metrics_path.exists() else {}

        def rend(cam):
            return render(cam, gaussians, pipe, bg, stage="fine", cam_type=scene.dataset_type)["render"].clamp(0, 1)

        if "eval" in do:
            from memreplay.vipe_io import PEOPLE_PHRASES, Vipe

            v = Vipe(Path(args.work) / "vipe")
            pid = v.ids_with(PEOPLE_PHRASES)
            print("people masks:", v.dir, v.has_masks, pid, flush=True)
            try:
                import lpips

                lp = lpips.LPIPS(net="alex", verbose=False).cuda()
            except Exception as e:  # noqa: BLE001
                print("no lpips:", e)
                lp = None
            (out / "renders").mkdir(exist_ok=True)
            rows = []
            t0 = time.time()
            for c in [c for c in cams if c["split"] == "test"]:
                gt = load_rgb(args.data, c["idx"])
                img = rend(make_cam(c, max_idx, gt))
                gt = gt.cuda()
                if "exp" in c:  # trained on exposure-normalized frames: score in video space, y = g x + b
                    ge = torch.tensor(c["exp"], dtype=torch.float32, device="cuda")
                    gt = (gt * ge[:3, None, None] + ge[3:, None, None]).clamp(0, 1)
                    img = (img * ge[:3, None, None] + ge[3:, None, None]).clamp(0, 1)
                mse = ((img - gt) ** 2).mean().item()
                row = {
                    "idx": c["idx"],
                    "psnr": -10 * math.log10(max(mse, 1e-10)),
                    "ssim": ssim(img[None], gt[None]).item(),
                }
                if lp is not None:
                    row["lpips"] = lp(img[None] * 2 - 1, gt[None] * 2 - 1).item()
                m = v.mask(c["idx"])
                if m is not None:
                    if m.shape != gt.shape[1:]:
                        m = cv2.resize(m, (gt.shape[2], gt.shape[1]), interpolation=cv2.INTER_NEAREST)
                    pm = torch.from_numpy(np.isin(m, pid)).cuda()
                    se = ((img - gt) ** 2).mean(0)
                    if pm.sum() > 100:
                        row["psnr_people"] = -10 * math.log10(max(se[pm].mean().item(), 1e-10))
                        row["people_frac"] = pm.float().mean().item()
                    row["psnr_static"] = -10 * math.log10(max(se[~pm].mean().item(), 1e-10))
                rows.append(row)
                cv2.imwrite(
                    str(out / "renders" / f"{c['idx']:05d}.jpg"),
                    cv2.cvtColor(np.concatenate([to8(gt), to8(img)], 1), cv2.COLOR_RGB2BGR),
                    [cv2.IMWRITE_JPEG_QUALITY, 92],
                )
            mean = {
                k: float(np.mean([r[k] for r in rows if k in r]))
                for k in ["psnr", "ssim", "lpips", "psnr_people", "psnr_static"]
                if any(k in r for r in rows)
            }
            ms = 1000 * (time.time() - t0) / max(1, len(rows))
            M.update(
                {
                    "method": "4DGaussians (HexPlane deformation), monocular",
                    "model": args.model_path,
                    "iteration": scene.loaded_iter,
                    "num_gaussians": N,
                    "test_every": 12,
                    "num_test": len(rows),
                    "res": [meta["w"], meta["h"]],
                    "mean": mean,
                    "per_frame": rows,
                    "eval_ms_per_frame_incl_io": ms,
                    "lpips_net": "alex" if lp else None,
                }
            )
            metrics_path.write_text(json.dumps(M, indent=1))
            log(f"post eval: {len(rows)} held-out frames: " + ", ".join(f"{k}={v:.4f}" for k, v in mean.items()))

        if "video" in do:
            t0 = time.time()
            W, H = meta["w"], meta["h"]
            vid = Video(out / "video.mp4", 2 * W - (2 * W) % 2, H - H % 2, fps)
            for c in cams:
                gt = load_rgb(args.data, c["idx"])
                img = rend(make_cam(c, max_idx, gt))
                fr = np.concatenate([to8(gt), to8(img)], 1)
                vid.add(fr[: H - H % 2, : 2 * W - (2 * W) % 2])
            vid.close()
            torch.cuda.synchronize()
            render_fps = len(cams) / (time.time() - t0)
            mid = cams[len(cams) // 2]
            vid = Video(out / "video_fixedcam.mp4", W - W % 2, H - H % 2, fps)
            t1 = time.time()
            for c in cams:
                img = rend(make_cam(mid, max_idx, t=c["idx"] / max_idx))
                vid.add(to8(img)[: H - H % 2, : W - W % 2])
            vid.close()
            M.update(
                {
                    "video": str(out / "video.mp4"),
                    "video_fixedcam": str(out / "video_fixedcam.mp4"),
                    "render_fps_incl_io": render_fps,
                    "render_fps_fixedcam": len(cams) / (time.time() - t1),
                }
            )
            metrics_path.write_text(json.dumps(M, indent=1))
            log(f"post video: {len(cams)} frames, {render_fps:.1f} fps incl. io -> {out / 'video.mp4'}")

        if "export" in do:
            t0 = time.time()
            S = np.eye(4)
            if args.to_world:
                S = np.array(json.loads(Path(args.to_world).read_text())["T_train_to_world"]).reshape(4, 4)
            s = float(np.cbrt(np.linalg.det(S[:3, :3])))
            Rw = S[:3, :3] / s
            St = torch.tensor(S, dtype=torch.float32, device="cuda")
            qw = torch.tensor(rot_to_quat(Rw), dtype=torch.float32, device="cuda")
            dur = (meta["frame_count"] - 1) / fps
            times = np.arange(0, dur + 1e-6, 1.0 / args.export_fps)
            fdir, ddir = out / "frames", out / "frames_dyn"
            fdir.mkdir(exist_ok=True)
            ddir.mkdir(exist_ok=True)
            xyz0, sc0, rot0 = gaussians.get_xyz, gaussians._scaling, gaussians._rotation
            op0, sh0 = gaussians._opacity, gaussians.get_features
            tab = gaussians._deformation_table
            split = tab.numel() == N and not bool(tab.all())
            states = []
            for t in times:
                tn = min(t * fps, max_idx) / max_idx
                tt = torch.full((N, 1), tn, device="cuda")
                x, sc, r, o, sh = gaussians._deformation(xyz0, sc0, rot0, op0, sh0, tt)
                if split:  # static Gaussians never went through the deformation field in training
                    x, sc, r = (
                        torch.where(tab[:, None], x, xyz0),
                        torch.where(tab[:, None], sc, sc0),
                        torch.where(tab[:, None], r, rot0),
                    )
                    o, sh = torch.where(tab[:, None], o, op0), torch.where(tab[:, None, None], sh, sh0)
                # bake the view-dependent colour (degree-3 SH, also deformed over time) for the recorded camera at
                # this time into the DC term: the viewer gets the colour the glasses saw, at 1/16 of the size
                cam_t = min(cams, key=lambda c: abs(c["t"] - t))
                campos = torch.tensor(np.array(cam_t["c2w"]).reshape(4, 4)[:3, 3], dtype=torch.float32, device="cuda")
                dirs = torch.nn.functional.normalize(x - campos, dim=-1)
                rgb = torch.clamp_min(eval_sh(gaussians.active_sh_degree, sh.transpose(1, 2), dirs) + 0.5, 0.0)
                states.append((x, sc, r, o, RGB2SH(rgb) if args.bake_view else sh[:, 0, :]))
            X = torch.stack([s_[0] for s_ in states])  # (T,N,3)
            disp = (X - X.mean(0, keepdim=True)).norm(dim=-1).amax(0)  # (N,)
            dyn = tab.clone() if split else disp > args.dyn_thresh
            sizes = []

            def finish(x, sc, r, o, fdc, sel):
                x, sc, r, o, fdc = x[sel], sc[sel], r[sel], o[sel], fdc[sel]
                x = x @ St[:3, :3].T + St[:3, 3]
                sc = sc + math.log(s) - math.log(args.gs_scale_div)
                r = torch.nn.functional.normalize(r, dim=-1)
                r = quat_mul(qw.expand_as(r), r)
                return [a.detach().cpu().numpy() for a in (x, fdc, o, sc, r)]

            for k, (x, sc, r, o, fdc) in enumerate(states):
                alpha = torch.sigmoid(o[:, 0])
                keep = alpha > 0.005
                if keep.sum() > args.max_gs:
                    thr = torch.topk(alpha[keep], args.max_gs).values[-1]
                    keep &= alpha >= thr
                write_ply(fdir / f"t_{k:04d}.ply", *finish(x, sc, r, o, fdc, keep))
                if split or args.dyn_out:
                    write_ply(ddir / f"t_{k:04d}.ply", *finish(x, sc, r, o, fdc, keep & dyn))
                sizes.append(int(keep.sum()))
            # static part: time-averaged state of the Gaussians that do not move
            st = (~dyn) & (torch.sigmoid(torch.stack([s_[3][:, 0] for s_ in states])).mean(0) > 0.005)
            xs = X.mean(0)
            scs = torch.stack([s_[1] for s_ in states]).mean(0)
            rs = states[len(states) // 2][2]
            os_ = torch.stack([s_[3] for s_ in states]).mean(0)
            fs = torch.stack([s_[4] for s_ in states]).mean(0)
            if split or args.dyn_out:
                write_ply(out / "static.ply", *finish(xs, scs, rs, os_, fs, st))
            fj = {
                "fps": args.export_fps,
                "count": len(times),
                "frame": "world",
                "file": "t_%04d.spz",
                "duration_sec": float(dur),
                "t0_sec": 0.0,
                "source": "4DGaussians",
                "T_train_to_world": S.flatten().tolist(),
                "gs_scale_div": args.gs_scale_div,
                "colour": "SH baked for the recorded camera at each time" if args.bake_view else "DC only",
                "gaussians_per_frame": {"min": min(sizes), "max": max(sizes)},
                "dynamic_split": {
                    "thresh_m": None if split else args.dyn_thresh,
                    "by": "trained static/dynamic flag" if split else "displacement",
                    "dynamic": int(dyn.sum()),
                    "static": int(st.sum()),
                    "static_file": "static.spz",
                    "dyn_dir": "frames_dyn",
                },
            }
            (fdir / "frames.json").write_text(json.dumps(fj, indent=1))
            (ddir / "frames.json").write_text(
                json.dumps({**fj, "note": "dynamic Gaussians only; pair with static.spz"}, indent=1)
            )
            log(
                f"post export: {len(times)} PLYs ({min(sizes)}-{max(sizes)} Gaussians), dynamic {int(dyn.sum())}/{N} "
                f"(> {args.dyn_thresh} m), {time.time() - t0:.0f}s; converting to spz"
            )
            plys = (
                sorted(fdir.glob("t_*.ply"))
                + sorted(ddir.glob("t_*.ply"))
                + ([out / "static.ply"] if (out / "static.ply").exists() else [])
            )
            cmds = "\n".join(f"{p} {p.with_suffix('.spz')}" for p in plys)  # paths have no spaces
            r = subprocess.run(
                ["xargs", "-P", "32", "-n", "2", "splat-transform", "-w"], input=cmds.encode(), capture_output=True
            )
            if r.returncode:
                log(f"splat-transform failed: {r.stderr.decode()[-500:]}")
            if not args.keep_ply:
                for p in plys:
                    if p.with_suffix(".spz").exists():
                        p.unlink()
            tot = lambda g: sum(p.stat().st_size for p in g)  # noqa: E731
            M["export"] = {
                "dir": str(fdir),
                "count": len(times),
                "fps": args.export_fps,
                "ply_mb": tot(fdir.glob("t_*.ply")) / 1e6,
                "ply_mb_each": max([p.stat().st_size for p in fdir.glob("t_*.ply")] or [0]) / 1e6,
                "spz_mb": tot(fdir.glob("t_*.spz")) / 1e6,
                "dyn_spz_mb": tot(ddir.glob("t_*.spz")) / 1e6,
                "static_spz_mb": (out / "static.spz").stat().st_size / 1e6 if (out / "static.spz").exists() else None,
                "n_spz": len(list(fdir.glob("t_*.spz"))),
                "gaussians_per_frame": fj["gaussians_per_frame"],
                "dynamic_split": fj["dynamic_split"],
                "seconds": time.time() - t0,
            }
            metrics_path.write_text(json.dumps(M, indent=1))
            log(f"post export done: {M['export']}")


if __name__ == "__main__":
    main()
