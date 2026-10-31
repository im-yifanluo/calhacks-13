#!/usr/bin/env python
"""How much does the 4DGaussians deformation move each Gaussian over the clip, and is the motion on the people?
Same args as post.py (-m, --configs, --data, --work). Prints/returns percentiles of max displacement from the mean
position over 10 Hz samples, split by whether the Gaussian projects into a ViPE 'person' mask at mid-clip."""

import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, "/workspace/4dgs/A")
sys.path.insert(0, "/workspace/4dgs/A/4DGaussians")
from post import GaussianModel, ModelHiddenParams, ModelParams, PipelineParams, Scene, get_combined_args, merge_hparams  # noqa: E402,E501


def main():
    from argparse import ArgumentParser

    import mmengine

    parser = ArgumentParser()
    model, _pipe, hyper = ModelParams(parser, sentinel=True), PipelineParams(parser), ModelHiddenParams(parser)
    for k in ["--configs", "--data", "--work", "--out"]:
        parser.add_argument(k, default="")
    parser.add_argument("--iteration", type=int, default=-1)
    args = get_combined_args(parser)
    args = merge_hparams(args, mmengine.Config.fromfile(args.configs))
    meta = json.loads((Path(args.data) / "cams.json").read_text())
    cams, max_idx, fps = meta["cams"], meta["max_idx"], meta["fps"]
    from memreplay.vipe_io import PEOPLE_PHRASES, Vipe

    v = Vipe(Path(args.work) / "vipe")
    pid = v.ids_with(PEOPLE_PHRASES)
    with torch.no_grad():
        g = GaussianModel(args.sh_degree, hyper.extract(args))
        Scene(model.extract(args), g, load_iteration=args.iteration, shuffle=False)
        N = g.get_xyz.shape[0]
        times = np.arange(0, (meta["frame_count"] - 1) / fps + 1e-6, 0.1)
        X = []
        for t in times:
            tt = torch.full((N, 1), min(t * fps, max_idx) / max_idx, device="cuda")
            x = g._deformation(g.get_xyz, g._scaling, g._rotation, g._opacity, g.get_features, tt)[0]
            tab = g._deformation_table
            if tab.numel() == N and not bool(tab.all()):
                x = torch.where(tab[:, None], x, g.get_xyz)
            X.append(x)
        X = torch.stack(X)
        disp = (X - X.mean(0, keepdim=True)).norm(dim=-1).amax(0).cpu().numpy()
        alpha = torch.sigmoid(g._opacity[:, 0]).cpu().numpy()
        # which Gaussians sit on a person at mid-clip
        c = cams[len(cams) // 2]
        k = int(round(c["t"] * 10))
        P = X[min(k, len(X) - 1)].cpu().numpy()
        c2w = np.array(c["c2w"]).reshape(4, 4)
        R = c2w[:3, :3] / np.cbrt(np.linalg.det(c2w[:3, :3]))
        pc = (P - c2w[:3, 3]) @ R
        K = np.array(c["K"]).reshape(3, 3)
        z = pc[:, 2]
        u = np.round(K[0, 0] * pc[:, 0] / np.maximum(z, 1e-6) + K[0, 2]).astype(int)
        vv = np.round(K[1, 1] * pc[:, 1] / np.maximum(z, 1e-6) + K[1, 2]).astype(int)
        m = v.mask(c["idx"])
        inside = (z > 0.1) & (u >= 0) & (u < m.shape[1]) & (vv >= 0) & (vv < m.shape[0])
        person = np.zeros(N, bool)
        person[inside] = np.isin(m[vv[inside], u[inside]], pid)
        vis = alpha > 0.05

        def stats(sel):
            d = disp[sel]
            return {
                "n": int(sel.sum()),
                "p50_cm": float(np.percentile(d, 50) * 100),
                "p90_cm": float(np.percentile(d, 90) * 100),
                "p99_cm": float(np.percentile(d, 99) * 100),
                "frac_gt_5cm": float((d > 0.05).mean()),
                "frac_gt_10cm": float((d > 0.10).mean()),
                "frac_gt_20cm": float((d > 0.20).mean()),
            }

        res = {
            "all_visible": stats(vis),
            "on_person_mid_clip": stats(vis & person),
            "not_person": stats(vis & ~person),
            "model": args.model_path,
            "note": "max distance from the time-mean position over 10 Hz samples (training frame units)",
        }
        print(json.dumps(res, indent=1))
        if args.out:
            Path(args.out).write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
