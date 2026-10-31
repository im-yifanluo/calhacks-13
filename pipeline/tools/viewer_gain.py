#!/usr/bin/env python3
"""Fit the viewer's colour gap and write it next to the scene for the bake step.

Spark (the viewer) composites a room splat a little brighter and warmer than gsplat's rasterizer does, so colours
calibrated against gsplat still come out with a warm cast in the viewer. This fits one per-channel gain and bias
from the viewer's own renders (the compare shots, blurred, tracked rows only) to the video frames and writes
<memory dir>/world/viewer_gain.json = {"gain": [r, g, b], "bias": [r, g, b]}. `memreplay stage bake` applies it to
the exported colours when the file is present (copy it to the pod's work/<id>/world/ first).

    python pipeline/tools/viewer_gain.py <clip id> ...      (after evalclip.py)
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[2]
MEM = REPO / "apps/web/public/memories"
SHOTS = Path(__file__).resolve().parent / "shots"
sys.path.insert(0, str(REPO / "pipeline"))
from memreplay.compare import autocrop, frame_at  # noqa: E402


def fit(cid: str) -> dict:
    cj = json.loads((MEM / cid / "compare.json").read_text())
    gaps = set(cj.get("gap_rows", []))
    X, Y = [], []
    for f in cj["frames"]:
        if f["t"] in gaps:
            continue
        shot = SHOTS / cid / f"{cid}_{f['t']:.1f}.png"
        if not shot.exists():
            shot = (
                Path(
                    "/private/tmp/claude-501/-Users-yifanluo-Hackathons-CalHacks-13/e2a2e10a-ec8f-4abc-bab2-5e2c4c111cc5/scratchpad/cap/shots"
                )
                / cid
                / shot.name
            )
        r = autocrop(cv2.imread(str(shot))).astype(np.float32) / 255
        o = (
            frame_at(REPO / "data/work" / cid / "input/clip.mp4", f["t"], (r.shape[1], r.shape[0])).astype(np.float32)
            / 255
        )
        X.append(cv2.GaussianBlur(r, (0, 0), 4).reshape(-1, 3)[::5])
        Y.append(cv2.GaussianBlur(o, (0, 0), 4).reshape(-1, 3)[::5])
    X, Y = np.concatenate(X), np.concatenate(Y)
    gain, bias = np.ones(3), np.zeros(3)
    for c in range(3):  # BGR in OpenCV
        A = np.stack([X[:, c], np.ones(len(X))], 1)
        g, b = np.linalg.lstsq(A, Y[:, c], rcond=None)[0]
        gain[c], bias[c] = float(np.clip(g, 0.6, 1.4)), float(np.clip(b, -0.2, 0.2))
    before = float(np.abs(X - Y).mean())
    after = float(np.abs(np.clip(X * gain + bias, 0, 1) - Y).mean())
    out = {
        "gain": [round(float(v), 4) for v in gain[::-1]],
        "bias": [round(float(v), 4) for v in bias[::-1]],  # RGB
        "rows": len(cj["frames"]) - len(gaps),
        "mean_abs_error": [round(before, 4), round(after, 4)],
    }
    (MEM / cid / "world").mkdir(exist_ok=True)
    (MEM / cid / "world" / "viewer_gain.json").write_text(json.dumps(out))
    print(cid, out)
    return out


if __name__ == "__main__":
    for cid in sys.argv[1:]:
        fit(cid)
