#!/usr/bin/env python3
"""Render a local scene from the recorded camera (headless Chrome, portrait) and score it against the video.
   python pipeline/tools/evalclip.py <clip id> [n shots | t1,t2,...] [label]   (from the repo .venv; see capture.js)
Writes apps/web/public/memories/<id>/compare.jpg + compare.json (with the lost-tracking rows marked)."""

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MEM = REPO / "apps/web/public/memories"
CAP = Path(__file__).resolve().parent
TITLES = {
    "img8013": "Hotel room",
    "img8014": "Hotel room corner",
    "img8015": "Hotel corridor",
    "img8016": "Hotel lobby",
    "img8017": "Night walk downtown",
    "v59": "Stage: speaker at the podium",
    "v71": "Stage and the hall",
    "v83": "Hackathon hall walk",
    "v106": "Hackathon hall, long walk",
    "o3329": "Palace of Fine Arts: short",
    "o3328": "Palace of Fine Arts: rotunda and people",
    "o3330": "Palace of Fine Arts: colonnade walk",
    "o3331": "Palace of Fine Arts: colonnade walk 2",
    "o3332": "Palace of Fine Arts: garden and people",
}


def run(cid: str, spec: str = "6", label: str | None = None) -> dict:
    out = CAP / "shots" / cid
    r = subprocess.run(
        ["node", str(CAP / "capture.js"), cid, str(out), spec], capture_output=True, text=True, check=True
    )
    print(r.stderr.strip())
    info = json.loads(r.stdout.strip().splitlines()[-1])
    sys.path.insert(0, str(REPO / "pipeline"))
    from memreplay import compare

    shots = [(s["t"], Path(s["path"])) for s in info["shots"]]
    res = compare.run(
        MEM / cid, REPO / "data/work" / cid / "input/clip.mp4", shots, label or f"{cid} {TITLES.get(cid, '')}"
    )
    res["gap_rows"] = [s["t"] for s in info["shots"] if s["inGap"]]
    good = [f for f in res["frames"] if f["t"] not in res["gap_rows"]]
    res["mean_tracked"] = (
        {k: round(sum(f[k] for f in good) / len(good), 3) for k in good[0] if k != "t"} if good else None
    )
    (MEM / cid / "compare.json").write_text(json.dumps(res, indent=2))
    print(cid, "tracked rows:", res["mean_tracked"], "lost rows:", res["gap_rows"])
    return res


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "6", sys.argv[3] if len(sys.argv) > 3 else None)
