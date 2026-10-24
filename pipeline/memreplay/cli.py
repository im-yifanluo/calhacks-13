"""memreplay CLI. Stages read/write one work dir per memory (layout in handoff.py), so any stage reruns alone.

  memreplay stage <name> --work work/<id>     run one stage (stubs until each owner implements theirs)
  memreplay merge work/<id> --title "..."      S9: world/ + objects/ -> validated memory.json

P1 · World (docs/PLAN.md 2.2)                   P2 · Things
  frames      S0 sharpest frame per 100 ms         nouns    S1 Claude: moving things + size/density
  cameras     S3 ViPE: path, lens, metric depth    masks    S2 SAM 3 text-prompted video masks
  world       S4 floor, +Y up, eye-height scale    objects  S7 SAM 3D asset + scale fix + hull
  background  S5 gsplat with masked loss -> spz    tracks   S8 CoTracker3 + RANSAC Kabsch, 10 Hz
  ghosts      S6 people as point splats
"""
from __future__ import annotations

import argparse
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

STAGES = {
    "frames": ("S0", "P1"), "nouns": ("S1", "P2"), "masks": ("S2", "P2"), "cameras": ("S3", "P1"),
    "world": ("S4", "P1"), "background": ("S5", "P1"), "ghosts": ("S6", "P1"),
    "objects": ("S7", "P2"), "tracks": ("S8", "P2"),
}


def quat_from_c2w_opencv(m: list[float]) -> tuple[float, float, float, float]:
    """Row-major 4x4 OpenCV camera-to-world -> three.js camera quaternion (x, y, z, w).

    OpenCV cameras look down +z with y down; three.js cameras look down -z with y up,
    so flip the camera's y and z axes before converting.
    """
    r = [[m[0], -m[1], -m[2]], [m[4], -m[5], -m[6]], [m[8], -m[9], -m[10]]]
    tr = r[0][0] + r[1][1] + r[2][2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        return ((r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, 0.25 * s)
    if r[0][0] > r[1][1] and r[0][0] > r[2][2]:
        s = math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2
        return (0.25 * s, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s)
    if r[1][1] > r[2][2]:
        s = math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2
        return ((r[0][1] + r[1][0]) / s, 0.25 * s, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s)
    s = math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2
    return ((r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, 0.25 * s, (r[1][0] - r[0][1]) / s)


BG_SPLAT_MAX = 350_000  # Quest budget for the background (whole scene <= 500k)


def warn(msg: str) -> None:
    print(f"[merge] {msg}", file=sys.stderr)


def merge(work: Path, title: str, memory_id: str, device: str, video_fps: float) -> Path:
    """S9: combine P1's world/ and P2's objects/ into memory.json. URLs stay relative to <work>."""
    from .handoff import Cameras, FramesIndex, ObjectsFragment, WorldInfo
    from .manifest import Background, Camera, Keyframe, MemoryManifest, Source, Timeline, World

    frames = FramesIndex.model_validate_json((work / "frames.json").read_text())
    cams = Cameras.model_validate_json((work / "world" / "cameras.json").read_text())
    world = WorldInfo.model_validate_json((work / "world" / "world.json").read_text())
    if not cams.frames:
        raise SystemExit("world/cameras.json has no frames")
    if not cams.in_world_frame:
        raise SystemExit("world/cameras.json is still in ViPE's frame; run S4 (world) first")
    if world.bgSplatCount > BG_SPLAT_MAX:
        warn(f"background has {world.bgSplatCount} splats; Quest budget is {BG_SPLAT_MAX}")

    objects = []
    for frag in (work / "objects" / "objects.json", work / "world" / "ghosts.json"):
        if frag.exists():
            objects += ObjectsFragment.model_validate_json(frag.read_text()).objects
        else:
            warn(f"note: {frag.relative_to(work)} missing, continuing without it")
    ids = [o.id for o in objects]
    if len(ids) != len(set(ids)):
        raise SystemExit(f"duplicate object ids: {sorted(i for i in ids if ids.count(i) > 1)}")
    for o in objects:
        if isinstance(o.track, list):
            low = min((k.p[1] for k in o.track), default=world.floorY)
            if low < world.floorY - 0.05:
                warn(f"object {o.id} dips {world.floorY - low:.2f} m below the floor; check S4/S8")

    cam_frames = sorted(cams.frames, key=lambda c: c.t_us)
    kept_t = [f.t_us for f in frames.frames if f.kept]
    duration = max(kept_t or [c.t_us for c in cam_frames]) / 1e6
    first = cam_frames[0]
    track = [
        Keyframe(t=c.t_us / 1e6, p=(c.c2w[3], c.c2w[7], c.c2w[11]), q=quat_from_c2w_opencv(c.c2w))
        for c in cam_frames
    ]
    manifest = MemoryManifest(
        id=memory_id,
        title=title,
        createdAt=datetime.now(timezone.utc).isoformat(),
        source=Source(device=device, durationSec=duration, fps=video_fps, width=first.w, height=first.h),
        world=World(floorY=world.floorY),
        timeline=Timeline(durationSec=duration, sampleHz=frames.target_fps),
        background=Background(url="world/bg.spz", format="spz", splatCount=world.bgSplatCount),
        camera=Camera(track=track, fovYDeg=math.degrees(2 * math.atan(first.h / (2 * first.K[4])))),
        objects=objects,
    )
    out = work / "memory.json"
    # exclude_none: the TypeScript side expects missing optional fields, not null
    out.write_text(manifest.model_dump_json(indent=2, exclude_none=True))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="memreplay", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stage", help="run one pipeline stage")
    st.add_argument("name", choices=list(STAGES))
    st.add_argument("--work", required=True, type=Path)
    mg = sub.add_parser("merge", help="S9: world/ + objects/ -> memory.json")
    mg.add_argument("work", type=Path)
    mg.add_argument("--title", default="Untitled memory")
    mg.add_argument("--id", dest="memory_id")
    mg.add_argument("--device", default="ray-ban-meta-gen2")
    mg.add_argument("--video-fps", type=float, default=30.0)
    args = ap.parse_args(argv)

    if args.cmd == "merge":
        out = merge(args.work, args.title, args.memory_id or args.work.name, args.device, args.video_fps)
        print(out)
        return 0
    code, owner = STAGES[args.name]
    print(f"[memreplay] stage {args.name} ({code}, owner {owner}) is not implemented yet; see docs/PLAN.md 2.2", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
