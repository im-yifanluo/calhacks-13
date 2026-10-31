#!/usr/bin/env python
"""Memory Replay work dir (ViPE + S3 world poses) -> Nerfies/HyperNeRF-style dataset that 4DGaussians reads.

  <out>/rgb/2x/<id>.png          frames at training resolution (4DGaussians' hyper loader hardcodes the 2x folder)
  <out>/camera/<id>.json         Nerfies camera: orientation = R_w2c (orthonormal), position = camera centre (world m)
  <out>/dataset.json             ids / train_ids / val_ids (every --test-every-th frame held out: idx % 12 == 6)
  <out>/metadata.json            warp_id = frame idx (4DGaussians normalises by the max -> time in [0,1])
  <out>/scene.json               identity centre/scale (cameras stay in the level metric world frame)
  <out>/points3D_downsample2.ply init cloud from ViPE depth, people INCLUDED (they are the point of 4D)
  <out>/aabb.json                HexPlane bounds (robust box of the near points; far points still init Gaussians)
  <out>/cams.json                our own record: idx, t, K, c2w (orthonormal), split (used by post.py)
  <out>/world_*.{npz,json}       snapshot of the world frame used (the main pipeline may refit it later)
NB: world/frames.npz c2w carries the metric scale in its rotation block (det = s^3): it maps ViPE camera points
to world points. Cameras must use the orthonormal part Q = R / s, or the rasterizer's view space is scaled by s^2.
Run with the 4dgs venv:  python convert.py /workspace/work/v59 /workspace/4dgs/A/data/v59
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, "/workspace/memory-replay/pipeline")
import cv2  # noqa: E402
from memreplay.vipe_io import Frames, Vipe, backproject, depth_edges, transform  # noqa: E402


def write_ply(path, xyz, rgb, flag=None):
    n = len(xyz)
    dt = np.dtype(
        [
            ("x", "<f4"),
            ("y", "<f4"),
            ("z", "<f4"),
            ("nx", "<f4"),
            ("ny", "<f4"),
            ("nz", "<f4"),
            ("red", "u1"),
            ("green", "u1"),
            ("blue", "u1"),
        ]
    )
    a = np.zeros(n, dt)
    a["x"], a["y"], a["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    a["red"], a["green"], a["blue"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    if flag is not None:
        a["nx"] = flag.astype(np.float32)
    hdr = (
        f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n"
        + "".join(f"property float {k}\n" for k in ["x", "y", "z", "nx", "ny", "nz"])
        + "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
    )
    with open(path, "wb") as f:
        f.write(hdr.encode())
        f.write(a.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("out")
    ap.add_argument("--stride", type=int, default=1, help="use every n-th frame")
    ap.add_argument("--test-every", type=int, default=12)
    ap.add_argument("--scale", type=float, default=1.0, help="training resolution / normalized frame size")
    ap.add_argument("--pts-every", type=int, default=6)
    ap.add_argument("--max-depth", type=float, default=40.0)
    ap.add_argument("--aabb-depth", type=float, default=12.0)
    ap.add_argument("--n-points", type=int, default=150_000)
    ap.add_argument(
        "--refined",
        action="store_true",
        help="apply the main pipeline's pose refinement "
        "(world/cameras.json vs cameras.vipe.json, nearest keyframe's delta) to every frame",
    )
    ap.add_argument(
        "--exposure",
        action="store_true",
        help="train on exposure-normalized frames x = (y - b) / g "
        "(world/exposure.json, the room-export colour space the viewer's wearer view re-exposes)",
    )
    ap.add_argument("--dyn-flag", action="store_true", help="flag person points dynamic (nx=1); HexPlane box = people")
    ap.add_argument("--reuse-rgb", default="", help="dataset dir whose rgb/2x frames (same clip, same scale) to link")
    a = ap.parse_args()
    t0 = time.time()
    work, out = Path(a.work), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.reuse_rgb:
        (out / "rgb").mkdir(parents=True, exist_ok=True)
        if not (out / "rgb" / "2x").exists():
            (out / "rgb" / "2x").symlink_to(Path(a.reuse_rgb).resolve() / "rgb" / "2x")
    (out / "rgb" / "2x").mkdir(parents=True, exist_ok=True)
    (out / "camera").mkdir(parents=True, exist_ok=True)
    fj = json.loads((work / "input" / "frames.json").read_text())
    fps, W0, H0, N = fj["fps"], fj["width"], fj["height"], fj["frame_count"]
    v = Vipe(work / "vipe")
    posed = set(int(i) for i in v.poses[0])
    if (work / "world" / "frames.npz").exists():
        from memreplay.world import WorldPoses

        for f in ("frames.npz", "world.json", "cameras.json"):
            shutil.copy2(work / "world" / f, out / f"world_{f}")
        wp = WorldPoses(work)
        c2w_of, ds_of, frame = wp.c2w, wp.depth_scale, "world"
    else:
        c2w_of, ds_of, frame = v.c2w, (lambda i: 1.0), "vipe"
    print(f"frame={frame} fps={fps} {W0}x{H0} N={N} posed={len(posed)}")
    deltas, expo = {}, {}
    if a.refined:
        ref = {
            f["idx"]: np.array(f["c2w"]).reshape(4, 4)
            for f in json.loads((work / "world" / "cameras.json").read_text())["frames"]
        }
        raw = {
            f["idx"]: np.array(f["c2w"]).reshape(4, 4)
            for f in json.loads((work / "world" / "cameras.vipe.json").read_text())["frames"]
        }
        deltas = {k: ref[k] @ np.linalg.inv(raw[k]) for k in ref if k in raw}
        shutil.copy2(work / "world" / "pose_refine.json", out / "world_pose_refine.json")
    if a.exposure:
        expo = {
            int(k): np.array(v, np.float64)
            for k, v in json.loads((work / "world" / "exposure.json").read_text()).items()
        }
        shutil.copy2(work / "world" / "exposure.json", out / "world_exposure.json")
    dk, ek = sorted(deltas), sorted(expo)

    def nearest(keys, i):
        return keys[int(np.argmin(np.abs(np.array(keys) - i)))]

    W, H = int(round(W0 * a.scale)), int(round(H0 * a.scale))
    sel = [i for i in range(0, N, a.stride) if i in posed]
    reader = Frames(work / "input" / "clip.mp4")
    ids, train, val, cams = [], [], [], []
    pts, cols, near_pts, flags = [], [], [], []
    from memreplay.vipe_io import PEOPLE_PHRASES, dilate

    pid = v.ids_with(PEOPLE_PHRASES)
    per = 2 * a.n_points // max(1, len(sel) // a.pts_every)
    scales = []
    for k, i in enumerate(sel):
        rgb = reader.get(i)
        if rgb.shape[:2] != (H0, W0):
            rgb = cv2.resize(rgb, (W0, H0), interpolation=cv2.INTER_AREA)
        K = v.K(i).copy()
        T = np.asarray(c2w_of(i), np.float64)  # maps ViPE camera points -> world (includes scale)
        s = float(np.cbrt(np.linalg.det(T[:3, :3])))
        scales.append(s)
        c2w = T.copy()
        c2w[:3, :3] /= s  # orthonormal camera pose
        if deltas:
            c2w = deltas[nearest(dk, i)] @ c2w
        ge = None
        if expo:
            ge = expo[nearest(ek, i)]  # y = g x + b per channel, y = the video frame
            rgb_train = np.clip(((rgb / 255.0 - ge[3:]) / ge[:3]) * 255.0 + 0.5, 0, 255).astype(np.uint8)
        else:
            rgb_train = rgb
        Ks = K.copy()
        Ks[0] *= W / W0
        Ks[1] *= H / H0
        name = f"{i:05d}"
        if not a.reuse_rgb:
            img = rgb_train if (W, H) == (W0, H0) else cv2.resize(rgb_train, (W, H), interpolation=cv2.INTER_AREA)
            cv2.imwrite(
                str(out / "rgb" / "2x" / f"{name}.png"),
                cv2.cvtColor(img, cv2.COLOR_RGB2BGR),
                [cv2.IMWRITE_PNG_COMPRESSION, 1],
            )
        R = c2w[:3, :3]
        cam = {
            "orientation": R.T.tolist(),
            "position": c2w[:3, 3].tolist(),
            "focal_length": float(Ks[0, 0]),
            "principal_point": [float(Ks[0, 2]), float(Ks[1, 2])],
            "skew": 0.0,
            "pixel_aspect_ratio": 1.0,
            "radial_distortion": [0.0, 0.0, 0.0],
            "tangential_distortion": [0.0, 0.0],
            "image_size": [W, H],
        }
        (out / "camera" / f"{name}.json").write_text(json.dumps(cam))
        ids.append(name)
        split = "test" if i % a.test_every == a.test_every // 2 else "train"
        (val if split == "test" else train).append(name)
        cams.append(
            {
                "idx": i,
                "t": i / fps,
                "w": W,
                "h": H,
                "K": Ks.flatten().tolist(),
                "c2w": c2w.flatten().tolist(),
                "split": split,
                **({"exp": ge.tolist()} if ge is not None else {}),
            }
        )
        if k % a.pts_every == 0:
            d = v.depth(i) * ds_of(i)
            if d.shape != (H0, W0):
                d = cv2.resize(d, (W0, H0), interpolation=cv2.INTER_NEAREST)
            m = np.isfinite(d) & (d > 0) & (d < a.max_depth / s) & ~depth_edges(d)
            stride = max(2, int(np.ceil(np.sqrt(m.sum() / max(per, 1)))))
            p, vv, uu = backproject(d, K, m, stride=stride)
            pw = transform(T, p)  # ViPE metres -> world metres
            pm = v.mask(i)
            pm = np.zeros(d.shape, bool) if pm is None else dilate(np.isin(pm, pid), 6)
            if a.dyn_flag:  # denser sampling on people: they need it most
                p2, v2, u2 = backproject(d, K, m & pm, stride=max(2, stride // 2))
                pw = np.concatenate([pw, transform(T, p2)])
                vv, uu, p = np.concatenate([vv, v2]), np.concatenate([uu, u2]), np.concatenate([p, p2])
            flags.append(pm[vv, uu])
            pts.append(pw)
            cols.append(rgb_train[vv, uu])
            near_pts.append(pw[p[:, 2] * s < a.aabb_depth])
    P, C, F = np.concatenate(pts), np.concatenate(cols), np.concatenate(flags)
    lo = np.percentile(P, 0.5, 0)
    vox = 0.01
    for _ in range(30):
        key = np.floor((P - lo) / vox).astype(np.int64)
        key = np.concatenate([key, F[:, None].astype(np.int64)], 1)  # thin people and room separately
        _, first = np.unique(key, axis=0, return_index=True)
        if len(first) <= a.n_points:
            break
        vox *= 1.25
    P, C, F = P[first], C[first], F[first]
    write_ply(out / "points3D_downsample2.ply", P.astype(np.float32), C.astype(np.uint8), F if a.dyn_flag else None)
    Q = P[F] if (a.dyn_flag and F.sum() > 100) else np.concatenate(near_pts)
    amin, amax = np.percentile(Q, 0.5, 0), np.percentile(Q, 99.5, 0)
    pad = 0.05 * (amax - amin) + (0.5 if a.dyn_flag else 0.0)
    amin, amax = amin - pad, amax + pad
    (out / "aabb.json").write_text(json.dumps({"min": amin.tolist(), "max": amax.tolist()}))
    (out / "dataset.json").write_text(
        json.dumps({"count": len(ids), "num_exemplars": len(train), "ids": ids, "train_ids": train, "val_ids": val})
    )
    (out / "metadata.json").write_text(
        json.dumps({n: {"warp_id": int(n), "appearance_id": int(n), "camera_id": 0} for n in ids})
    )
    (out / "scene.json").write_text(json.dumps({"scale": 1.0, "center": [0.0, 0.0, 0.0], "near": 0.05, "far": 80.0}))
    C2 = np.array([np.array(c["c2w"]).reshape(4, 4)[:3, 3] for c in cams])
    rad = float(np.linalg.norm(C2 - C2.mean(0), axis=1).max())
    (out / "cams.json").write_text(
        json.dumps(
            {
                "frame": frame,
                "fps": fps,
                "w": W,
                "h": H,
                "frame_count": N,
                "max_idx": max(int(n) for n in ids),
                "cam_radius": rad,
                "world_scale": float(np.median(scales)),
                "cams": cams,
            }
        )
    )
    K0 = v.K(sel[0])
    print(
        f"ids={len(ids)} train={len(train)} val={len(val)} points={len(P)} (person {int(F.sum())}, "
        f"dyn_flag={a.dyn_flag}) (voxel {vox:.3f} m) "
        f"aabb={np.round(amin, 2).tolist()}..{np.round(amax, 2).tolist()} cam_radius={rad:.3f} m "
        f"world_scale={np.median(scales):.4f} K0 fx={K0[0, 0]:.1f} fy={K0[1, 1]:.1f} cx={K0[0, 2]:.1f} "
        f"cy={K0[1, 2]:.1f} (W/2={W0 / 2}, H/2={H0 / 2}) took {time.time() - t0:.0f}s"
    )


if __name__ == "__main__":
    main()
