"""S6c: bake the trained appearance into plain colours.

The static room is trained with gsplat's --app_opt: every frame gets an appearance embedding and a small MLP turns
(embedding, per-Gaussian features, view direction) into colour, which absorbs the phone's auto-exposure. The PLY
gsplat saves bakes that MLP at the *zero* embedding, which is nobody's exposure: the judges saw a warm, peach or
sodium cast on three of five clips. This re-exports the final checkpoint at the **mean** embedding (the average
frame's exposure and white balance), view-independent, to <work>/gsplat_static/baked.ply, which layers/convert
prefer over the trainer's own PLY when it is newer than the checkpoint.

    memreplay stage bake --work <work>        (CPU is fine: a 500k-Gaussian MLP pass takes seconds)
"""
from __future__ import annotations

import glob
import json
import os
import sys
from pathlib import Path

import numpy as np


def latest_ckpt(work: Path) -> Path | None:
    cks = sorted(glob.glob(str(work / "gsplat_static" / "ckpts" / "ckpt_*_rank0.pt")),
                 key=lambda p: int(Path(p).stem.split("_")[1]))
    return Path(cks[-1]) if cks else None


def static_ply(work: Path) -> Path | None:
    """The PLY to build the room from: baked.ply if it is newer than the last checkpoint, else the trainer's last."""
    work = Path(work)
    baked = work / "gsplat_static" / "baked.ply"
    ck = latest_ckpt(work)
    if baked.exists() and (ck is None or baked.stat().st_mtime >= ck.stat().st_mtime):
        return baked
    plys = sorted((work / "gsplat_static" / "ply").glob("point_cloud_*.ply"), key=lambda p: int(p.stem.split("_")[-1]))
    return plys[-1] if plys else None


def run(work: Path) -> Path | None:
    import torch

    work = Path(work).resolve()
    ck_path = latest_ckpt(work)
    if ck_path is None:
        raise SystemExit("no static checkpoint")
    ck = torch.load(ck_path, map_location="cpu", weights_only=False)
    if "app_module" not in ck:
        print("[bake] trained without --app_opt; the trainer's PLY already has plain colours")
        return None
    examples = Path(os.environ.get("SRC", "/workspace/src")) / "gsplat" / "examples"
    sys.path.insert(0, str(examples))
    from utils import AppearanceOptModule, rgb_to_sh
    from gsplat import export_splats

    splats = ck["splats"]
    state = ck["app_module"]
    n_images, embed_dim = state["embeds.weight"].shape
    feature_dim = splats["features"].shape[1]
    sh_degree = 3
    app = AppearanceOptModule(n_images, feature_dim, embed_dim=embed_dim, sh_degree=sh_degree)
    app.load_state_dict(state)
    app.eval()
    with torch.no_grad():
        mean = app.embeds.weight.mean(0, keepdim=True)
        spread = float(app.embeds.weight.std(0).mean())
        app.embeds.weight[0] = mean[0]                          # row 0 now holds the average frame's appearance
        feats = splats["features"].float()
        dirs = torch.zeros(1, feats.shape[0], 3)
        rgb = torch.sigmoid(app(features=feats, embed_ids=torch.zeros(1, dtype=torch.long), dirs=dirs,
                                sh_degree=sh_degree) + splats["colors"].float())
        rgb = rgb.squeeze(0)                                    # [N, 3]
        gain, bias, note, per_view = calibrate(work, splats, rgb)
        # the viewer's own colour gap (pipeline/tools/viewer_gain.py: Spark composites brighter and warmer than
        # gsplat), folded into the export so free mode is right too
        vg, vb = torch.ones(3), torch.zeros(3)
        vfile = work / "world" / "viewer_gain.json"
        if vfile.exists():
            vj = json.loads(vfile.read_text())
            vg, vb = torch.tensor(vj["gain"], dtype=torch.float32), torch.tensor(vj["bias"], dtype=torch.float32)
            note += f"; viewer gain {vj['gain']} bias {vj['bias']}"
        g_all, b_all = gain * vg, bias * vg + vb                 # the whole chain, raw -> exported
        rgb = (rgb * g_all + b_all).clamp(0, 1).unsqueeze(1)    # [N, 1, 3]
        # each training frame's own exposure, relative to the export: y = gi x + bi with x = (xe - b_all) / g_all
        exposure = {}
        for idx, (gi, bi) in per_view.items():
            rel_g = gi / g_all.numpy()
            rel_b = bi - rel_g * b_all.numpy()
            exposure[str(idx)] = [round(float(v), 4) for v in np.concatenate([rel_g, rel_b])]
        (work / "world" / "exposure.json").write_text(json.dumps(exposure))
        sh0 = rgb_to_sh(rgb)
        shN = torch.empty([sh0.shape[0], 0, 3])
        out = work / "gsplat_static" / "baked.ply"
        export_splats(means=splats["means"].float(), scales=splats["scales"].float(), quats=splats["quats"].float(),
                      opacities=splats["opacities"].float(), sh0=sh0, shN=shN, format="ply", save_to=str(out))
    m = rgb.squeeze(1).mean(0).tolist()
    print(f"[bake] {work.name}: {sh0.shape[0]} Gaussians at the mean of {n_images} appearance embeddings "
          f"(embedding spread {spread:.3f}); colour calibration gain {[round(float(g), 3) for g in gain]} "
          f"bias {[round(float(b), 3) for b in bias]} ({note}); mean colour {[round(x, 3) for x in m]} -> {out.relative_to(work)}")
    return out


def calibrate(work: Path, splats: dict, rgb, n_views: int = 400):
    """Per-channel gain and bias that make gsplat's renders of the baked splat match the training frames on
    average (blurred, static pixels, fully covered). The appearance MLP's mean is not exactly the frames' mean
    exposure, and this is also where any systematic tone bias of the export would show. Needs CUDA (gsplat's
    rasterizer); without it, identity."""
    import torch

    one, zero = torch.ones(3), torch.zeros(3)
    if not torch.cuda.is_available():
        return one, zero, "no CUDA, not calibrated", {}
    try:
        import cv2
        from gsplat import rasterization
        from datasets.colmap import Parser
    except Exception as e:                                       # pragma: no cover
        return one, zero, f"not calibrated: {e}", {}
    p = Parser(data_dir=str(work / "colmap"), factor=1, normalize=False, test_every=12)
    idx = np.linspace(0, len(p.image_names) - 1, min(n_views, len(p.image_names))).astype(int)
    dev = "cuda"
    means = splats["means"].float().to(dev)
    quats = splats["quats"].float().to(dev)
    scales = torch.exp(splats["scales"].float()).to(dev)
    op = torch.sigmoid(splats["opacities"].float()).to(dev)
    col = rgb.float().to(dev)
    X, Y = [], []
    per_view = {}                                                # image idx -> (gain[3], bias[3]) for that frame
    with torch.no_grad():
        for i in idx:
            K = torch.tensor(p.Ks_dict[p.camera_ids[i]], dtype=torch.float32, device=dev)
            w2c = torch.linalg.inv(torch.tensor(p.camtoworlds[i], dtype=torch.float32)).to(dev)
            gt = cv2.imread(p.image_paths[i])[..., ::-1].astype(np.float32) / 255
            H, W = gt.shape[:2]
            mpath = Path(p.image_paths[i]).parent.parent / "masks" / (Path(p.image_paths[i]).stem + ".png")
            mask = (cv2.imread(str(mpath), 0) > 127) if mpath.exists() else np.ones((H, W), bool)
            img, alpha, _ = rasterization(means, quats, scales, op, col, w2c[None], K[None], W, H, packed=False,
                                          backgrounds=torch.zeros(1, 3, device=dev))
            r = img[0].clamp(0, 1).cpu().numpy()
            a = alpha[0, ..., 0].cpu().numpy()
            sel = (a > 0.95) & mask
            if sel.mean() < 0.05:
                continue
            rb = cv2.GaussianBlur(r, (0, 0), 4)
            gb = cv2.GaussianBlur(gt, (0, 0), 4)
            xs, ys = rb[sel][::7], gb[sel][::7]
            X.append(xs)
            Y.append(ys)
            gi, bi = np.ones(3), np.zeros(3)
            for c in range(3):
                A = np.stack([xs[:, c], np.ones(len(xs))], 1)
                g, b = np.linalg.lstsq(A, ys[:, c], rcond=None)[0]
                gi[c], bi[c] = float(np.clip(g, 0.3, 3.0)), float(np.clip(b, -0.3, 0.3))
            per_view[int(Path(p.image_paths[i]).stem)] = (gi, bi)
    if not X:
        return one, zero, "no covered pixels, not calibrated", {}
    X, Y = np.concatenate(X), np.concatenate(Y)
    gain, bias = np.ones(3), np.zeros(3)
    for c in range(3):
        A = np.stack([X[:, c], np.ones(len(X))], 1)
        g, b = np.linalg.lstsq(A, Y[:, c], rcond=None)[0]
        gain[c], bias[c] = float(np.clip(g, 0.7, 1.5)), float(np.clip(b, -0.15, 0.15))
    before = float(np.abs(X - Y).mean())
    after = float(np.abs(np.clip(X * gain + bias, 0, 1) - Y).mean())
    return (torch.tensor(gain, dtype=torch.float32), torch.tensor(bias, dtype=torch.float32),
            f"{len(idx)} views, {len(X)} px, mean abs error {before:.3f} -> {after:.3f}; per-frame exposure for {len(per_view)} frames",
            per_view)
