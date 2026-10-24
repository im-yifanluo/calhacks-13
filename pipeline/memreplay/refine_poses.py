"""Use gsplat's refined camera poses for playback.

The static room is trained with --pose_opt, so the splat is consistent with the poses gsplat *refined*, not with the
ViPE poses in world/cameras.json that the viewer replays and S6b/verify use. Where ViPE's path wobbled (or our
re-levelling moved frames), the two differ by tens of centimetres and every render from the recorded camera is
misaligned and blurry. This reads the refinement from the last checkpoint (the trainer's CameraOptModule, vendored
below so it also runs on a laptop with CPU torch), applies it to the training frames, carries the per-frame
correction to the other keyframes, and rewrites world/cameras.json (the original is kept as cameras.vipe.json).

    memreplay stage refine --work <work>            # on the pod (gsplat_static/ckpts, colmap/images present)
    python -m memreplay.refine_poses <dir> <ckpt>   # anywhere: <dir>/world/cameras.json + <dir>/colmap_names.txt
"""
from __future__ import annotations

import glob
import json
import shutil
import sys
from pathlib import Path

import numpy as np


def _rotation_6d_to_matrix(d6):
    import torch

    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = torch.nn.functional.normalize(a1, dim=-1)
    b2 = a2 - (b1 * a2).sum(-1, keepdim=True) * b1
    b2 = torch.nn.functional.normalize(b2, dim=-1)
    b3 = torch.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-2)


def _apply(state: dict, c2w: np.ndarray) -> np.ndarray:
    """gsplat examples/utils.py CameraOptModule.forward: camtoworld @ [R(6d + identity) | dx]."""
    import torch

    w = state["embeds.weight"].float()
    dx, drot = w[:, :3], w[:, 3:]
    rot = _rotation_6d_to_matrix(drot + torch.tensor([1.0, 0, 0, 0, 1.0, 0]))
    T = torch.eye(4).repeat(len(w), 1, 1)
    T[:, :3, :3] = rot
    T[:, :3, 3] = dx
    return (torch.tensor(c2w, dtype=torch.float32) @ T).numpy().astype(np.float64)


def run(work: Path, ckpt_path: Path | None = None, test_every: int = 12) -> dict:
    import torch

    from .handoff import Cameras

    work = Path(work)
    if ckpt_path is None:
        ckpts = sorted(glob.glob(str(work / "gsplat_static" / "ckpts" / "ckpt_*_rank0.pt")),
                       key=lambda p: int(Path(p).stem.split("_")[1]))
        if not ckpts:
            raise SystemExit("no static checkpoint")
        ckpt_path = Path(ckpts[-1])
        cfg = (work / "gsplat_static" / "cfg.yml").read_text()
        test_every = int(next(l for l in cfg.splitlines() if l.strip().startswith("test_every")).split(":")[1])
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if "pose_adjust" not in ckpt:
        print("[refine] trained without pose_opt; nothing to do")
        return {}
    names_file = work / "colmap_names.txt"
    if names_file.exists():
        names = sorted(names_file.read_text().split())
    else:
        names = sorted(p.stem for p in (work / "colmap" / "images").glob("*.jpg"))
    train_idx = [int(n) for i, n in enumerate(names) if i % test_every != 0]     # gsplat's train split
    src = work / "world" / "cameras.json"
    orig = work / "world" / "cameras.vipe.json"
    if not orig.exists():
        shutil.copy(src, orig)
    cams = Cameras.model_validate_json(orig.read_text())
    by_idx = {c.idx: c for c in cams.frames}
    c2w = np.array([np.array(by_idx[i].c2w).reshape(4, 4) for i in train_idx])
    state = ckpt["pose_adjust"]
    assert state["embeds.weight"].shape[0] == len(train_idx), (state["embeds.weight"].shape, len(train_idx))
    refined = _apply(state, c2w)
    D = np.einsum("nij,njk->nik", refined, np.linalg.inv(c2w))       # world-frame correction per training frame
    shifts = np.linalg.norm(refined[:, :3, 3] - c2w[:, :3, 3], axis=1)
    ang = np.degrees(np.arccos(np.clip((np.einsum("nii->n", np.einsum("nij,nkj->nik", refined[:, :3, :3], c2w[:, :3, :3])) - 1) / 2, -1, 1)))
    stats = {"frames": len(train_idx), "shift_median_m": round(float(np.median(shifts)), 3),
             "shift_p90_m": round(float(np.percentile(shifts, 90)), 3), "shift_max_m": round(float(shifts.max()), 3),
             "rot_median_deg": round(float(np.median(ang)), 2), "rot_p90_deg": round(float(np.percentile(ang, 90)), 2),
             "mean_dxyz": [round(float(x), 3) for x in (refined[:, :3, 3] - c2w[:, :3, 3]).mean(0)]}
    ti = np.array(train_idx)
    out = []
    for c in cams.frames:
        k = int(np.argmin(np.abs(ti - c.idx)))
        M = D[k] @ np.array(c.c2w).reshape(4, 4)
        u, _, vt = np.linalg.svd(M[:3, :3])
        M[:3, :3] = u @ vt                                           # a pure rotation
        out.append(c.model_copy(update={"c2w": M.reshape(-1).tolist()}))
    src.write_text(Cameras(frames=out).model_dump_json())
    (work / "world" / "pose_refine.json").write_text(json.dumps(stats, indent=2))
    print(f"[refine] {work.name}: {stats}")
    return stats


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else None)
