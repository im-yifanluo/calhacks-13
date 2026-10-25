#!/usr/bin/env python3
"""Build the args for judge.js (a Claude Code Workflow script: judge + skeptic per clip, then a report) from each scene's compare.json (written by evalclip.py)."""
import json
import sys
from pathlib import Path

MEM = Path(__file__).resolve().parents[2] / "apps/web/public/memories"
TITLES = {"img8013": "Hotel room", "img8014": "Hotel room corner", "img8015": "Hotel corridor",
          "img8016": "Hotel lobby", "img8017": "Night walk downtown",
          "v59": "Stage: speaker at the podium", "v71": "Stage and the hall", "v83": "Hackathon hall walk",
          "v106": "Hackathon hall, long walk", "o3329": "Palace of Fine Arts: short", "o3328": "Palace of Fine Arts: rotunda and people",
          "o3330": "Palace of Fine Arts: colonnade walk", "o3331": "Palace of Fine Arts: colonnade walk 2",
          "o3332": "Palace of Fine Arts: garden and people"}
NOTES = {
    "img8013": "42 s hand-held walk around a hotel room (bed, desk, TV, window), chest-height phone. No people.",
    "img8014": "11 s look at a hotel room corner: couch, floor lamp (lit), TV, side table with papers. No people.",
    "img8015": "73 s walk along a hotel corridor past doors and a housekeeping cart. No people.",
    "img8016": "34 s walk through a hotel lobby; tracking was lost for a stretch in the middle. A person or two may appear.",
    "img8017": "142 s night walk on a downtown street: shops, cars, pedestrians, strong lights.",
    "v59": "18 s from Ray-Ban Meta glasses (wide lens, eye height): a speaker standing at a clear podium on a stage with a CalHacks backdrop and a giant teddy bear; the speaker shifts and gestures; the camera pans.",
    "v71": "39 s from the glasses: the same stage and speaker, then the camera turns to a hall full of seated and walking people.",
    "v83": "45 s from the glasses: walking through a hackathon hall; tables, laptops, many people sitting and walking past.",
    "v106": "60 s from the glasses: a longer walk through the same hall with people moving in every direction.",
    "o3329": "7 s outdoors from the glasses: looking down at the ground near people's feet at the Palace of Fine Arts.",
    "o3328": "43 s outdoors from the glasses: the Palace of Fine Arts rotunda and colonnade, people walking on the paths, bright sun.",
    "o3330": "60 s outdoors from the glasses: walking along the colonnade path with lawns and trees, people walking towards and away.",
    "o3331": "60 s outdoors from the glasses: the same colonnade walk, more people passing close by.",
    "o3332": "50 s outdoors from the glasses: path past planters and bushes to the columns, people walking ahead, one passing very close.",
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
