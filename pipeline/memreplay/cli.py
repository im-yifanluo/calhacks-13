"""memreplay CLI for the one-person vision pipeline (pipeline/README.md).
Every step reads and writes one work dir per memory (layout in handoff.py), so any step reruns alone.

  memreplay run work/<id> --title "..."        every step below, in order (skips finished ones unless --force)
  memreplay stage <name> --work work/<id>     run one step
  memreplay merge work/<id> --title "..."      S7: everything -> validated memory.json

Steps (S0 is recording the clip; put it in the work dir as clip.mov or clip.mp4):
  normalize   S1 ffmpeg: upright, 30 fps, 1280 px, SDR, audio, frames.json
  nouns       S1 Claude looks at a contact sheet and lists the props for ViPE to segment (nouns.json)
  vipe        S2 NVIDIA ViPE (its own env): cameras, intrinsics, metric depth, instance masks
  world       S3 floor plane -> world frame (meters, +Y up, floor at 0), cameras.json
  l0          S4 static points -> bg_points.ply, room collider, people ghosts
  objects     S5 object tracks + velocity; Claude picks shape, size, mass
  background  S6 gsplat on our cameras with people/props masked out -> bg.spz
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

STAGES = {"normalize": "S1", "nouns": "S1", "vipe": "S2", "world": "S3", "l0": "S4", "objects": "S5", "background": "S6"}
DONE_MARKER = {"normalize": "input/frames.json", "nouns": "nouns.json", "vipe": "vipe/pose/clip.npz",
               "world": "world/cameras.json", "l0": "world/ghosts.json", "objects": "objects/objects.json",
               "background": "world/bg.spz"}
KF_GAP_SEC = 0.5   # ViPE re-runs detection every 0.5 s (default 2 s leaves new things unmasked too long)


def run_vipe(work: Path) -> None:
    """S2 in ViPE's own env (pod layout from pipeline/runpod/env.sh)."""
    from .handoff import Nouns

    work = Path(work).resolve()
    nouns = Nouns.model_validate_json((work / "nouns.json").read_text()).nouns
    env_sh = Path(__file__).resolve().parents[1] / "runpod" / "env.sh"
    phrases = ",".join(nouns)
    cmd = (f"source '{env_sh}' && use vipe && cd \"$SRC/vipe\" && uv run python run.py pipeline=default "
           f"streams=raw_mp4_stream streams.base_path='{work}/input/clip.mp4' streams.frame_end=-1 "
           f"pipeline.output.path='{work}/vipe' pipeline.output.save_artifacts=true pipeline.output.save_viz=false "
           f"pipeline.init.instance.kf_gap_sec={KF_GAP_SEC} 'pipeline.init.instance.phrases=[{phrases}]'")
    subprocess.run(["bash", "-c", cmd], check=True)


def run_stage(name: str, work: Path, args: argparse.Namespace | None = None) -> None:
    work = Path(work)
    if name == "normalize":
        from . import normalize
        eye = getattr(args, "eye_height", None)
        normalize.run(work, eye_height_m=eye)
    elif name == "nouns":
        from . import claude, normalize
        from .handoff import Nouns
        sheet = normalize.contact_sheet(work, work / "input" / "sheet.jpg", n=8, width=256)
        nouns = Nouns().nouns
        if claude.available():
            try:
                nouns = claude.propose_nouns(sheet)
            except Exception as e:
                print(f"[nouns] Claude failed ({e}); using the default prompts")
        else:
            nouns = nouns + ["ball", "bottle", "cup", "can", "box"]
            print("[nouns] no ANTHROPIC_API_KEY; using generic prop prompts")
        (work / "nouns.json").write_text(Nouns(nouns=nouns).model_dump_json(indent=2))
        print(f"[nouns] {nouns}")
    elif name == "vipe":
        run_vipe(work)
    elif name == "world":
        from . import world
        world.run(work)
    elif name == "l0":
        from . import l0, objects
        objects.observe(work)
        l0.run(work)
    elif name == "objects":
        from . import objects
        if not (work / "objects" / "observations.json").exists():
            objects.observe(work)
        objects.run(work)
    elif name == "background":
        from . import background
        background.run(work, steps_scaler=getattr(args, "steps_scaler", 0.25) or 0.25)
    else:
        raise SystemExit(f"unknown step {name}")


def run_all(work: Path, title: str, args: argparse.Namespace) -> Path:
    work = Path(work)
    timings = {}
    skip = set(args.skip or [])
    for name in STAGES:
        if name in skip:
            continue
        if not args.force and (work / DONE_MARKER[name]).exists() and name not in (args.redo or []):
            print(f"[run] {name}: already done")
            continue
        t0 = time.time()
        print(f"[run] {name} ...", flush=True)
        run_stage(name, work, args)
        timings[name] = round(time.time() - t0, 1)
        if name in ("l0", "objects", "background"):        # a viewable memory after every layer
            merge(work, title, args.memory_id or work.name, args.device)
    out = merge(work, title, args.memory_id or work.name, args.device)
    log = work / "run_log.json"
    old = json.loads(log.read_text()) if log.exists() else {}
    old.update({k: v for k, v in timings.items()})
    log.write_text(json.dumps(old, indent=2))
    print(f"[run] done: {out}  timings {timings}")
    return out
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
    st.add_argument("--eye-height", type=float, help="camera height when recording, m (normalize)")
    st.add_argument("--steps-scaler", type=float, default=0.25, help="gsplat schedule scale (background)")
    mg = sub.add_parser("merge", help="S7: everything -> memory.json")
    rn = sub.add_parser("run", help="all steps, then merge")
    for p in (mg, rn):
        p.add_argument("work", type=Path)
        p.add_argument("--title", default="Untitled memory")
        p.add_argument("--id", dest="memory_id")
        p.add_argument("--device", default="ray-ban-meta-gen2")
    rn.add_argument("--eye-height", type=float)
    rn.add_argument("--steps-scaler", type=float, default=0.25)
    rn.add_argument("--force", action="store_true", help="rerun finished steps too")
    rn.add_argument("--redo", nargs="*", choices=list(STAGES), help="rerun just these finished steps")
    rn.add_argument("--skip", nargs="*", choices=list(STAGES), help="leave these steps out")
    vf = sub.add_parser("verify", help="measure the result against the video; pictures in <work>/verify")
    vf.add_argument("work", type=Path)
    pb = sub.add_parser("publish", help="copy the viewer files to a folder, or upload them (--to s3)")
    pb.add_argument("work", type=Path)
    pb.add_argument("--to", required=True, help="a folder, or 's3' (bucket settings from the env)")
    pb.add_argument("--prefix", help="s3 key prefix (default memories/<work name>)")
    wk = sub.add_parser("worker", help="poll SpacetimeDB for uploads and process them")
    wk.add_argument("--once", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "verify":
        from . import verify
        print(json.dumps(verify.run(args.work), indent=2))
        return 0
    if args.cmd == "publish":
        from . import worker
        if args.to == "s3":
            print(worker.publish_s3(args.work, args.prefix or f"memories/{Path(args.work).name}"))
        else:
            for f in worker.publish_dir(args.work, Path(args.to)):
                print(f)
        return 0
    if args.cmd == "worker":
        from . import worker
        worker.loop(once=args.once)
        return 0

    if args.cmd == "merge":
        print(merge(args.work, args.title, args.memory_id or args.work.name, args.device))
        return 0
    if args.cmd == "run":
        run_all(args.work, args.title, args)
        return 0
    run_stage(args.name, args.work, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
