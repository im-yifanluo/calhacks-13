"""memreplay CLI. Each stage reads/writes a work dir so stages can be rerun on their own.

  memreplay run   <video.mp4> --out work/<id>      # all stages
  memreplay stage <name> --work work/<id>          # one stage

Stages (see docs/PLAN.md for tools and fallbacks):
  1 ingest    : ffmpeg -> frames @ 10-15 fps, downscale to ~1080p long edge, drop blurry frames
  2 poses     : camera poses + per-frame metric depth (MegaSaM / VGGT-family; fallback COLMAP)
  3 segment   : SAM 3 text-prompted video masks for movable things ("person", "dog", "ball", ...)
  4 background: train static 3DGS with dynamic pixels masked out (gsplat / Brush) -> .spz
  5 objects   : best-view crop per object -> SAM 3D Objects / TRELLIS / Hunyuan3D -> .glb + convex hull
  6 tracks    : per-frame object pose from masked depth + mesh fit (ICP), smoothed -> keyframes
  7 export    : align gravity/floor, scale to meters, write memory.json, upload assets
"""
import argparse
import sys

STAGES = ["ingest", "poses", "segment", "background", "objects", "tracks", "export"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="memreplay")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("video")
    run.add_argument("--out", required=True)
    st = sub.add_parser("stage")
    st.add_argument("name", choices=STAGES)
    st.add_argument("--work", required=True)
    args = ap.parse_args(argv)
    print(f"[memreplay] {args.cmd}: stages not implemented yet -> see docs/PLAN.md", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
