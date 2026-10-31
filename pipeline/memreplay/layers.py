"""S6b props layer: carve each grabbable prop out of the static room splat.

The static splat (S6 --static) is trained on every frame with only people masked, so the props are in it at full
quality. A Gaussian belongs to a prop if, in the frames where ViPE masked that prop, its centre lands on the prop's
mask and is not hidden behind the depth there (multi-view vote). Those Gaussians become the prop's own splat
(object-local coordinates, so the viewer can move it along its track); the rest is the room.

Writes world/bg_room.spz (room without props), objects/<id>.spz, and switches those objects' visual to the splat
(the primitive stays as the physics collider). Props with too few Gaussians keep their primitive.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

from .handoff import Cameras, WorldInfo
from .vipe_io import Vipe, dilate
from .world import WorldPoses

MIN_GAUSSIANS = 50
SNAP_FLOOR = False
MAX_VIEWS = 30


def floor_offset(xyz: np.ndarray, opacity: np.ndarray, cam_xz: np.ndarray) -> float:
    """Height of the splat's own floor: the densest layer of fairly opaque Gaussians in [-0.6, 0.4] m within
    3 m of the walked path. The splat learns its geometry from the photos and can settle a little off the
    measured world frame; the viewer stands you on y = 0."""
    from scipy.spatial import cKDTree

    near = cKDTree(cam_xz).query(xyz[:, [0, 2]], k=1)[0] < 3.0
    y = xyz[near & (opacity > 0.3), 1]
    y = y[(y > -0.6) & (y < 0.4)]
    if len(y) < 500:
        return 0.0
    hist, e = np.histogram(y, bins=np.arange(-0.6, 0.4001, 0.02))
    return float(e[np.argmax(np.convolve(hist, [1, 2, 3, 2, 1], "same"))] + 0.01)


def read_ply(path: Path) -> np.ndarray:
    raw = Path(path).read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    header = raw[:end].decode()
    if "binary_little_endian" not in header:
        raise ValueError(f"{path}: expected a binary little-endian PLY")
    props = []
    for ln in header.splitlines():
        if ln.startswith("property"):
            _, typ, name = ln.split()
            props.append((name, {"float": "<f4", "uchar": "u1", "double": "<f8", "int": "<i4"}[typ]))
    n = int(next(ln.split()[-1] for ln in header.splitlines() if ln.startswith("element vertex")))
    return np.frombuffer(raw[end:], dtype=props, count=n).copy()


def write_ply(path: Path, data: np.ndarray) -> None:
    typ = {"<f4": "float", "|u1": "uchar", "<f8": "double", "<i4": "int"}
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        + f"element vertex {len(data)}\n"
        + "".join(f"property {typ[data.dtype[name].str]} {name}\n" for name in data.dtype.names)
        + "end_header\n"
    )
    with open(path, "wb") as f:
        f.write(header.encode())
        f.write(data.tobytes())


def to_spz(ply: Path, spz: Path) -> None:
    subprocess.run(["splat-transform", "-w", str(ply), str(spz)], check=True, capture_output=True)


def run(work: Path) -> dict:
    work = Path(work).resolve()
    from .bake import static_ply

    ply = static_ply(work)  # baked colours when available (S6c)
    if ply is None:
        raise SystemExit("no static splat yet: run `memreplay stage background --static` first")
    data = read_ply(ply)
    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    ok = np.isfinite(xyz).all(1)
    data, xyz = data[ok], xyz[ok]
    selection = json.loads((work / "objects" / "selection.json").read_text())
    objs_doc = json.loads((work / "objects" / "objects.json").read_text())
    objs = {o["id"]: o for o in objs_doc["objects"]}
    cams = {c.idx: c for c in Cameras.model_validate_json((work / "world" / "cameras.json").read_text()).frames}
    scale = WorldInfo.model_validate_json((work / "world" / "world.json").read_text()).scale
    v, wp = Vipe(work / "vipe"), WorldPoses(work)
    # 1. put the splat's floor exactly at y = 0, and rewrite the static room with it
    cam_xz = np.array([[c.c2w[3], c.c2w[11]] for c in cams.values()])
    opacity = 1 / (1 + np.exp(-data["opacity"].astype(np.float64)))
    # The splat is trained on the S3 cameras, so it already sits in the world frame; snapping its densest low
    # layer to y = 0 picked a couch seat or bed in two clips and pushed the room 0.35 m off the props. Off by default.
    shift = floor_offset(xyz, opacity, cam_xz) if SNAP_FLOOR else 0.0
    data["y"] = (data["y"] - shift).astype(np.float32)
    xyz[:, 1] -= shift
    # 2. prune floaters in front of the camera path, giants and needles (cleanup.py)
    from .cleanup import fill_sky, prune, seen_count

    path = np.array([[c.c2w[3], c.c2w[7], c.c2w[11]] for c in cams.values()])
    keep = prune(data, path) & (seen_count(xyz, list(cams.values())) >= 2)
    pruned = int((~keep).sum())
    data, xyz = data[keep], xyz[keep]
    fill_sky(data, path)  # the sky dome: overlap and firm up (cleanup.py)
    write_ply(work / "gsplat_static" / "aligned.ply", data)
    to_spz(work / "gsplat_static" / "aligned.ply", work / "world" / "bg_static.spz")
    owner = np.full(len(xyz), -1)
    report = []
    kept = [e for e in selection if e["keep"] and e["id"] in objs]
    for oi, e in enumerate(kept):
        o = objs[e["id"]]
        p0 = np.array(o["track"][0]["p"], float)
        size = e.get("spec", {}).get("size_m") or o["visual"].get("size") or [0.3, 0.3, 0.3]  # stable across reruns
        cand = np.flatnonzero((np.linalg.norm(xyz - p0, axis=1) < 0.6 * max(size) + 0.1) & (owner == -1))
        views = sorted([s for s in e["obs"] if not s["touches_border"]] or e["obs"], key=lambda s: -s["area"])[
            :MAX_VIEWS
        ]
        votes, seen = np.zeros(len(cand)), np.zeros(len(cand))
        for s in views:
            c, m = cams.get(s["idx"]), v.mask(s["idx"])
            if c is None or m is None or len(cand) == 0:
                continue
            K, C = np.array(c.K).reshape(3, 3), np.array(c.c2w).reshape(4, 4)
            w2c = np.linalg.inv(C)
            pc = xyz[cand] @ w2c[:3, :3].T + w2c[:3, 3]
            z = pc[:, 2]
            front = z > 0.05
            u = np.round(K[0, 0] * pc[:, 0] / np.where(front, z, 1) + K[0, 2]).astype(int)
            vv = np.round(K[1, 1] * pc[:, 1] / np.where(front, z, 1) + K[1, 2]).astype(int)
            inb = front & (u >= 0) & (u < c.w) & (vv >= 0) & (vv < c.h)
            # No depth test: the splat's surfaces don't follow ViPE's per-frame depth closely enough. A Gaussian
            # behind or beside the prop lands on its mask only from some viewpoints, so the vote still rejects it.
            ui, vi = np.clip(u, 0, c.w - 1), np.clip(vv, 0, c.h - 1)
            on = dilate(np.isin(m, e["ids"]), 5)[vi, ui]
            seen += inb
            votes += inb & on
        mine = (seen >= 3) & (votes >= 0.7 * np.maximum(seen, 1))
        how = "vote"
        if mine.sum() < MIN_GAUSSIANS:
            # Fallback: the splat's surfaces sit a little off the measured geometry, so votes can miss. Take what is
            # inside the prop's box (20 % larger), above the surface it rests on.
            half = 0.6 * np.array(size, float) + 0.03
            inside = np.all(np.abs(xyz[cand] - p0) <= half, axis=1) & (xyz[cand, 1] > p0[1] - size[1] / 2 + 0.03)
            mine, how = inside, "box"
        owner[cand[mine]] = oi
        report.append(
            {
                "id": e["id"],
                "candidates": int(len(cand)),
                "gaussians": int(mine.sum()),
                "views": len(views),
                "method": how,
            }
        )

    (work / "objects").mkdir(exist_ok=True)
    tmp = work / "gsplat_static"
    for oi, (e, r) in enumerate(zip(kept, report)):
        o = objs[e["id"]]
        if r["gaussians"] < MIN_GAUSSIANS:
            r["visual"] = "primitive (too few Gaussians)"
            owner[owner == oi] = -1  # leave them in the room
            continue
        sub = data[owner == oi].copy()
        p0 = np.array(o["track"][0]["p"], float)
        for k, name in enumerate(("x", "y", "z")):  # object-local: the track moves it
            sub[name] = (sub[name] - p0[k]).astype(np.float32)
        write_ply(tmp / f"obj_{e['id']}.ply", sub)
        to_spz(tmp / f"obj_{e['id']}.ply", work / "objects" / f"{e['id']}.spz")
        o.setdefault("primitive", o["visual"])  # keep the shape for reference
        o["visual"] = {"kind": "splat", "url": f"objects/{e['id']}.spz", "format": "spz"}
        r["visual"] = "splat"
    room = data[owner == -1]
    write_ply(tmp / "room.ply", room)
    to_spz(tmp / "room.ply", work / "world" / "bg_room.spz")
    for o in objs_doc["objects"]:
        o.pop("primitive", None)  # not part of the scene format
    (work / "objects" / "objects.json").write_text(json.dumps(objs_doc, indent=2))
    winfo = WorldInfo.model_validate_json((work / "world" / "world.json").read_text())
    winfo.diagnostics["room_splat_count"] = int(len(room))
    winfo.diagnostics["static_floor_shift_m"] = shift
    winfo.diagnostics["static_pruned"] = pruned
    winfo.diagnostics["static_splat_count"] = int(len(data))
    winfo.diagnostics["props_layer"] = report
    (work / "world" / "world.json").write_text(winfo.model_dump_json(indent=2))
    (work / "objects" / "layers.json").write_text(json.dumps(report, indent=2))
    print(
        f"[layers] splat floor moved by {-shift:+.3f} m; pruned {pruned}; room {len(room)} Gaussians; props: "
        + ", ".join(f"{r['id']} {r['gaussians']} ({r['visual']})" for r in report)
    )
    return {"room": len(room), "props": report}
