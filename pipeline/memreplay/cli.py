"""memreplay CLI for the one-person vision pipeline (pipeline/README.md).
Every step reads and writes one work dir per memory (layout in handoff.py), so any step reruns alone.

  memreplay stage <name> --work work/<id>     run one step (stubs until each is written)
  memreplay merge work/<id> --title "..."      S7: everything -> validated memory.json

Steps (S0 is recording the clip):
  normalize   S1 ffmpeg: upright, 30 fps, 1280 px, audio, frames.json
  (S2 is ViPE itself: run it with `uv run python run.py ...`, see the runbook)
  world       S3 up direction + floor plane -> world frame, cameras.json
  l0          S4 static points -> bg_points.ply, room collider, people ghosts
  objects     S5 object tracks + velocity; Claude picks shape, size, mass
  background  S6 gsplat on ViPE cameras + masks -> bg.spz
"""
from __future__ import annotations

import argparse
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

STAGES = {"normalize": "S1", "world": "S3", "l0": "S4", "objects": "S5", "background": "S6"}
BG_SPLAT_MAX = 350_000  # Quest budget for the background (whole scene <= 500k)


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


def warn(msg: str) -> None:
    print(f"[merge] {msg}", file=sys.stderr)


def merge(work: Path, title: str, memory_id: str, device: str) -> Path:
    """S7: combine everything in <work> into memory.json. URLs stay relative to <work>."""
    from .handoff import Cameras, FramesInfo, ObjectsFragment, WorldInfo
    from .manifest import Background, Camera, Keyframe, MemoryManifest, Source, Timeline, World

    frames = FramesInfo.model_validate_json((work / "input" / "frames.json").read_text())
    cams = Cameras.model_validate_json((work / "world" / "cameras.json").read_text())
    world = WorldInfo.model_validate_json((work / "world" / "world.json").read_text())
    if not cams.frames:
        raise SystemExit("world/cameras.json has no frames; run S3 (world) first")

    # Background: the trained splat (S6) if it exists, otherwise the L0 points (S4).
    if (work / "world" / "bg.spz").exists():
        background = Background(url="world/bg.spz", format="spz", splatCount=world.bgSplatCount)
    elif (work / "world" / "bg_points.ply").exists():
        background = Background(url="world/bg_points.ply", format="ply", splatCount=world.bgPointsCount)
        warn("using the L0 point background (world/bg_points.ply); run S6 for the trained splat")
    else:
        raise SystemExit("no background yet: run S4 (l0) first")
    if background.splatCount > BG_SPLAT_MAX:
        warn(f"background has {background.splatCount} splats; Quest budget is {BG_SPLAT_MAX}")
    if (work / "world" / "room_collider.glb").exists():
        background.colliderUrl = "world/room_collider.glb"
    else:
        warn("no world/room_collider.glb: thrown objects will only land on the floor plane")

    objects = []
    for frag in (work / "world" / "ghosts.json", work / "objects" / "objects.json"):
        if frag.exists():
            objects += ObjectsFragment.model_validate_json(frag.read_text()).objects
        else:
            warn(f"note: {frag.relative_to(work)} missing, continuing without it")
    ids = [o.id for o in objects]
    if len(ids) != len(set(ids)):
        raise SystemExit(f"duplicate object ids: {sorted(i for i in ids if ids.count(i) > 1)}")
    for o in objects:
        if isinstance(o.track, list) and o.grabbable:
            low = min((k.p[1] for k in o.track), default=world.floorY)
            if low < world.floorY - 0.05:
                warn(f"object {o.id} dips {world.floorY - low:.2f} m below the floor; check S3/S5")

    cam_frames = sorted(cams.frames, key=lambda c: c.t)
    first = cam_frames[0]
    track = [Keyframe(t=c.t, p=(c.c2w[3], c.c2w[7], c.c2w[11]), q=quat_from_c2w_opencv(c.c2w)) for c in cam_frames]
    audio = "input/audio.m4a" if (work / "input" / "audio.m4a").exists() else None
    manifest = MemoryManifest(
        id=memory_id,
        title=title,
        createdAt=datetime.now(timezone.utc).isoformat(),
        source=Source(device=device, durationSec=frames.duration_sec, fps=frames.fps,
                      width=frames.width, height=frames.height, audioUrl=audio),
        world=World(floorY=world.floorY),
        timeline=Timeline(durationSec=frames.duration_sec, sampleHz=frames.fps / frames.key_stride),
        background=background,
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
    st = sub.add_parser("stage", help="run one pipeline step")
    st.add_argument("name", choices=list(STAGES))
    st.add_argument("--work", required=True, type=Path)
    mg = sub.add_parser("merge", help="S7: everything -> memory.json")
    mg.add_argument("work", type=Path)
    mg.add_argument("--title", default="Untitled memory")
    mg.add_argument("--id", dest="memory_id")
    mg.add_argument("--device", default="ray-ban-meta-gen2")
    args = ap.parse_args(argv)

    if args.cmd == "merge":
        print(merge(args.work, args.title, args.memory_id or args.work.name, args.device))
        return 0
    print(f"[memreplay] step {args.name} ({STAGES[args.name]}) is not written yet; see pipeline/README.md", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
