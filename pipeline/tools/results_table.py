#!/usr/bin/env python3
"""Per-clip facts from the pulled scenes -> markdown rows for the report (python results_table.py [ids])."""
import json
import sys
from collections import Counter
from pathlib import Path

MEM = Path(__file__).resolve().parents[2] / "apps/web/public/memories"
IDS = sys.argv[1:] or ["img8013", "img8014", "img8015", "img8016", "img8017"]


def load(p):
    return json.loads(p.read_text()) if p.exists() else {}


rows = []
for cid in IDS:
    d = MEM / cid
    m, w, c, v = load(d / "memory.json"), load(d / "world/world.json"), load(d / "compare.json"), load(d / "verify/report.json")
    if not m:
        print(f"{cid}: no memory.json", file=sys.stderr)
        continue
    dg = w.get("diagnostics", {})
    kinds = Counter(o["visual"].get("kind", "?") for o in m["objects"])
    ghosts = sum(1 for o in m["objects"] if "ghost" in o.get("id", "") or o["visual"].get("kind") == "points-sequence")
    props = len(m["objects"]) - ghosts
    gaps = m["timeline"].get("gaps") or []
    mt = c.get("mean_tracked") or c.get("mean") or {}
    rows.append({
        "id": cid, "title": m["title"], "secs": round(m["timeline"]["durationSec"]),
        "floor": "found" if dg.get("floor_found") else "assumed", "scale": round(w.get("scale", 1), 2),
        "cam_h": round(w.get("median_camera_height_m", 0), 2), "level_range": dg.get("level_offset_range_m"),
        "room_splats": m["background"].get("splatCount"), "pruned": dg.get("static_pruned"),
        "props": props, "ghosts": ghosts, "kinds": dict(kinds),
        "gaps_s": round(sum(b - a for a, b in gaps), 1), "n_gaps": len(gaps),
        "psnr": mt.get("psnr"), "ssim": mt.get("ssim"), "hist": mt.get("hist"), "centre_ssim": mt.get("centre_ssim"),
        "lost_rows": c.get("gap_rows"), "reproj_err": (v.get("reprojection") or {}).get("median_abs_colour_error"),
    })

print("| clip | length | floor fit | scale | cam height | room Gaussians (pruned) | props | ghosts | lost tracking | PSNR | SSIM | colour | centre SSIM |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    print(f"| {r['title']} (`{r['id']}`) | {r['secs']} s | {r['floor']} | {r['scale']} | {r['cam_h']} m | {r['room_splats']} ({r['pruned']}) | "
          f"{r['props']} | {r['ghosts']} | {r['gaps_s']} s in {r['n_gaps']} | {r['psnr']} | {r['ssim']} | {r['hist']} | {r['centre_ssim']} |")
print()
for r in rows:
    print(r)
