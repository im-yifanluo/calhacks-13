#!/usr/bin/env python3
"""Build the args for judge.js (a Claude Code Workflow script: judge + skeptic per clip, then a report) from each scene's compare.json (written by evalclip.py)."""
import json
import sys
from pathlib import Path

MEM = Path(__file__).resolve().parents[2] / "apps/web/public/memories"
TITLES = {"img8013": "Hotel room", "img8014": "Hotel room corner", "img8015": "Hotel corridor",
          "img8016": "Hotel lobby", "img8017": "Night walk downtown"}
NOTES = {
    "img8013": "42 s hand-held walk around a hotel room (bed, desk, TV, window), chest-height phone. No people.",
    "img8014": "11 s look at a hotel room corner: couch, floor lamp (lit), TV, side table with papers. No people.",
    "img8015": "73 s walk along a hotel corridor past doors and a housekeeping cart. No people.",
    "img8016": "34 s walk through a hotel lobby; tracking was lost for a stretch in the middle. A person or two may appear.",
    "img8017": "142 s night walk on a downtown street: shops, cars, pedestrians, strong lights.",
}
COMMON = ("The render is the reconstructed static room (Gaussian splat) with movable props carved out as separate "
          "splats and any people shown as translucent point 'ghosts', drawn from the recorded camera at the video's "
          "field of view. Expected, acceptable differences: lamps and screens may not glow, people are abstract ghosts, "
          "thin cables may be missing. Rows flagged 'tracking lost' render black on purpose.")


def main(ids):
    clips = []
    for cid in ids:
        cj = MEM / cid / "compare.json"
        if not cj.exists():
            print(f"skip {cid}: no compare.json", file=sys.stderr)
            continue
        d = json.loads(cj.read_text())
        gaps = d.get("gap_rows", [])
        clips.append({"id": cid, "title": TITLES[cid], "grid": str(MEM / cid / "compare.jpg"), "metrics": str(cj),
                      "gaps": gaps, "notes": f"{NOTES[cid]} {COMMON}",
                      "shots": [{"t": f["t"], "inGap": f["t"] in gaps} for f in d["frames"]]})
    return {"clips": clips}


if __name__ == "__main__":
    ids = sys.argv[1:] or list(TITLES)
    out = main(ids)
    print(json.dumps(out))
