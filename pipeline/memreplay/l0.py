"""S4 L0 export: room points (world/bg_points.ply), room collider (world/room_collider.glb) and
people ghosts (world/ghosts/<id>.bin + world/ghosts.json)."""
from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

from .handoff import FramesInfo, ObjectsFragment, WorldInfo, write_points_sequence
from .manifest import DynamicObject, Keyframe
from .vipe_io import HAND_PHRASES, PEOPLE_PHRASES, Frames, Vipe, backproject, depth_edges, dilate, erode, transform
from .world import WorldPoses

ROOM_MAX_DEPTH = 7.0
ROOM_CAP = 300_000
ROOM_FRAMES = 360            # frames sampled for the room points
GHOST_BYTES_BUDGET = 24e6    # all ghost files together; keeps the memory light enough for a phone
GHOST_MAX_PTS = 12_000


# --- room points -------------------------------------------------------------------------------------
def _voxel_reduce(keys, xyz, rgb, cnt):
    """Merge rows with equal voxel keys: sums of xyz/rgb and counts."""
    order = np.argsort(keys, kind="stable")
    keys, xyz, rgb, cnt = keys[order], xyz[order], rgb[order], cnt[order]
    first = np.r_[True, keys[1:] != keys[:-1]]
    starts = np.flatnonzero(first)
    return (keys[starts], np.add.reduceat(xyz, starts), np.add.reduceat(rgb, starts), np.add.reduceat(cnt, starts))


def _keys(p: np.ndarray, vox: float) -> np.ndarray:
    q = np.floor(p / vox).astype(np.int64) + (1 << 20)
    return (q[:, 0] << 42) | (q[:, 1] << 21) | q[:, 2]


def room_points(work: Path, v: Vipe, wp: WorldPoses, frames: FramesInfo, vox: float = 0.02,
                extra_static: list[int] | None = None):
    """Back-project background pixels from many frames, merge on a vox grid, keep voxels seen in >= 2 frames."""
    ids = np.arange(0, frames.frame_count, frames.key_stride)
    ids = ids[ids <= v.frame_indices[-1]]
    ids = ids[np.linspace(0, len(ids) - 1, min(ROOM_FRAMES, len(ids))).astype(int)]
    reader = Frames(work / "input" / "clip.mp4")
    acc = None
    batch = []
    for n, idx in enumerate(ids):
        idx = int(idx)
        if not wp.good(idx):
            continue
        d = v.depth(idx) * wp.depth_scale(idx)
        sel = (d < ROOM_MAX_DEPTH) & ~depth_edges(d)
        st = v.static_mask(idx, d, margin_px=6, extra_static=extra_static)   # margin around people/props
        if st is not None:
            sel &= st
        p, vv, uu = backproject(d, v.K(idx), sel, stride=2)
        if len(p) == 0:
            continue
        pw = transform(wp.c2w(idx), p)
        rgb = reader.get(idx)[vv, uu].astype(np.float64)
        k = _keys(pw, vox)
        kk, s_xyz, s_rgb, c = _voxel_reduce(k, pw, rgb, np.ones(len(k), np.int64))
        batch.append((kk, s_xyz / c[:, None], s_rgb / c[:, None], np.ones(len(kk), np.int64)))  # one vote per frame
        if len(batch) >= 40:
            parts = ([acc] if acc is not None else []) + batch
            acc = _voxel_reduce(*(np.concatenate([b[i] for b in parts]) for i in range(4)))
            batch = []
    if batch:                                                  # flush the last partial batch
        parts = ([acc] if acc is not None else []) + batch
        acc = _voxel_reduce(*(np.concatenate([b[i] for b in parts]) for i in range(4)))
    if acc is None:
        raise RuntimeError("l0: no usable frames for room points (all bad poses or empty depth)")
    keys, s_xyz, s_rgb, cnt = acc
    # s_xyz/s_rgb are sums of per-frame means (one vote per frame), so divide by the frame count
    keep = cnt >= 2
    xyz, rgb, cnt = s_xyz[keep] / cnt[keep, None], s_rgb[keep] / cnt[keep, None], cnt[keep]
    if len(xyz) > ROOM_CAP:                                     # keep the best-observed voxels
        top = np.argsort(-cnt, kind="stable")[:ROOM_CAP]
        xyz, rgb = xyz[top], rgb[top]
    return xyz.astype(np.float32), np.clip(rgb, 0, 255).astype(np.uint8)


def write_splat_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray, radius: float = 0.012, opacity: float = 0.9) -> None:
    """Points as small round Gaussian splats in the standard 3DGS PLY layout (Spark and splat-transform read it)."""
    n = len(xyz)
    f_dc = (rgb.astype(np.float32) / 255.0 - 0.5) / 0.28209479
    logit = math.log(opacity / (1 - opacity))
    data = np.zeros(n, dtype=[(c, "<f4") for c in ("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                                                   "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")])
    data["x"], data["y"], data["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    data["f_dc_0"], data["f_dc_1"], data["f_dc_2"] = f_dc[:, 0], f_dc[:, 1], f_dc[:, 2]
    data["opacity"] = logit
    data["scale_0"] = data["scale_1"] = data["scale_2"] = math.log(radius)
    data["rot_0"] = 1.0
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {n}\n" + \
        "".join(f"property float {name}\n" for name in data.dtype.names) + "end_header\n"
    with open(path, "wb") as f:
        f.write(header.encode())
        f.write(data.tobytes())


def read_splat_ply_xyz_rgb(path: Path) -> tuple[np.ndarray, np.ndarray]:
    raw = Path(path).read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    names = [ln.split()[-1] for ln in raw[:end].decode().splitlines() if ln.startswith("property")]
    data = np.frombuffer(raw[end:], dtype=[(n, "<f4") for n in names])
    xyz = np.stack([data["x"], data["y"], data["z"]], 1)
    rgb = np.clip((np.stack([data["f_dc_0"], data["f_dc_1"], data["f_dc_2"]], 1) * 0.28209479 + 0.5) * 255, 0, 255)
    return xyz, rgb.astype(np.uint8)


# --- room collider -----------------------------------------------------------------------------------
def heightfield(xyz: np.ndarray, lo: np.ndarray, hi: np.ndarray, cell: float = 0.10):
    """Cell height = 90th percentile of points below 1.2 m (floor, seats, tables); cells with a lot of structure
    between 1.2 and 2.2 m (walls, tall furniture) become 2.2 m columns so thrown things bounce off walls."""
    x0, z0 = lo[0] - 0.3, lo[2] - 0.3
    nx = int(np.ceil((hi[0] + 0.3 - x0) / cell)) + 1
    nz = int(np.ceil((hi[2] + 0.3 - z0) / cell)) + 1
    ix = np.clip(((xyz[:, 0] - x0) / cell).astype(int), 0, nx - 1)
    iz = np.clip(((xyz[:, 2] - z0) / cell).astype(int), 0, nz - 1)
    flat = ix * nz + iz
    H = np.zeros(nx * nz, np.float32)
    low = (xyz[:, 1] > -0.15) & (xyz[:, 1] < 1.2)
    order = np.argsort(flat[low], kind="stable")
    fl, yl = flat[low][order], xyz[low, 1][order]
    if len(fl):
        starts = np.flatnonzero(np.r_[True, fl[1:] != fl[:-1]])
        ends = np.r_[starts[1:], len(fl)]
        for s, e in zip(starts, ends):
            if e - s >= 3:
                H[fl[s]] = max(0.0, float(np.percentile(yl[s:e], 90)))
    tall = (xyz[:, 1] >= 1.2) & (xyz[:, 1] < 2.2)
    tc = np.bincount(flat[tall], minlength=nx * nz)
    span = np.zeros(nx * nz, np.float32)
    np.maximum.at(span, flat[tall], xyz[tall, 1])
    walls = ((tc >= 6) & (span > 1.6)).reshape(nx, nz)
    H = cv2.medianBlur(H.reshape(nx, nz), 3)                    # de-speckle the floor/table layer only
    nb = cv2.filter2D(walls.astype(np.float32), -1, np.ones((3, 3), np.float32), borderType=cv2.BORDER_CONSTANT) - walls
    H[walls & (nb >= 1)] = 2.2                                  # wall columns with at least one wall neighbour
    return H, (x0, z0, cell)


def heightfield_mesh(H: np.ndarray, origin: tuple[float, float, float]):
    import trimesh

    x0, z0, cell = origin
    nx, nz = H.shape
    gx, gz = np.meshgrid(np.arange(nx), np.arange(nz), indexing="ij")
    verts = np.stack([x0 + (gx + 0.5) * cell, H, z0 + (gz + 0.5) * cell], -1).reshape(-1, 3)   # cell centres
    a = (gx[:-1, :-1] * nz + gz[:-1, :-1]).reshape(-1)
    b, c, d = a + nz, a + 1, a + nz + 1
    faces = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, d], 1)])   # counter-clockwise seen from +Y
    return trimesh.Trimesh(vertices=verts, faces=faces, process=False)


# --- people ghosts -------------------------------------------------------------------------------------
def person_tracks(v: Vipe, wp: WorldPoses, key_ids: np.ndarray) -> list[dict]:
    """Join person ids that are re-detections of the same person (no time overlap, close in 3D)."""
    pids = v.ids_with(PEOPLE_PHRASES)
    if not pids:
        return []
    seen: dict[int, list[tuple[int, np.ndarray]]] = {p: [] for p in pids}
    for idx in key_ids:
        m = v.mask(int(idx))
        if m is None or not wp.good(int(idx)):
            continue
        present = [p for p in np.unique(m) if p in seen]
        if not present:
            continue
        d = v.depth(int(idx)) * wp.depth_scale(int(idx))
        for p in present:
            sel = (m == p) & (d < 8)
            if sel.sum() < 50:
                continue
            pts, _, _ = backproject(d, v.K(int(idx)), sel, stride=4)
            seen[p].append((int(idx), transform(wp.c2w(int(idx)), np.median(pts, 0, keepdims=True))[0]))
    spans = sorted(((obs[0][0], obs[-1][0], p, obs) for p, obs in seen.items() if obs), key=lambda s: s[0])
    tracks: list[dict] = []
    for first, last, p, obs in spans:
        best = None
        for tr in tracks:
            if tr["last"] < first and np.linalg.norm(tr["last_pos"] - obs[0][1]) < 1.2 and first - tr["last"] < 150:
                best = tr
        if best is None:
            tracks.append({"ids": [p], "first": first, "last": last, "last_pos": obs[-1][1]})
        else:
            best["ids"].append(p)
            best["last"], best["last_pos"] = last, obs[-1][1]
    return tracks


def ghosts(work: Path, v: Vipe, wp: WorldPoses, frames: FramesInfo) -> list[DynamicObject]:
    key_ids = np.arange(0, frames.frame_count, frames.key_stride)
    tracks = person_tracks(v, wp, key_ids)
    if not tracks:
        return []
    hand_ids = set(v.ids_with(HAND_PHRASES))
    hz = frames.fps / frames.key_stride
    per_frame = int(np.clip(GHOST_BYTES_BUDGET / (9 * len(key_ids) * len(tracks)), 1500, GHOST_MAX_PTS))
    reader = Frames(work / "input" / "clip.mp4")
    rng = np.random.default_rng(0)
    seqs = [[] for _ in tracks]
    for idx in key_ids:
        idx = int(idx)
        m = v.mask(idx)
        present = set(np.unique(m).tolist()) if m is not None else set()
        active = [k for k, tr in enumerate(tracks) if present & set(tr["ids"])] if wp.good(idx) else []
        if not active:
            for s in seqs:
                s.append((np.zeros((0, 3)), np.zeros((0, 3), np.uint8)))
            continue
        d = v.depth(idx) * wp.depth_scale(idx)
        rgb = reader.get(idx)
        edges = depth_edges(d, rel=0.03, absolute=0.06)
        hands = np.isin(m, list(hand_ids)) if hand_ids else np.zeros_like(m, bool)
        for k, tr in enumerate(tracks):
            if k not in active:
                seqs[k].append((np.zeros((0, 3)), np.zeros((0, 3), np.uint8)))
                continue
            body = np.isin(m, tr["ids"])
            # a hand that touches this person's mask belongs to them (ViPE gives hands their own id)
            if hands.any():
                n_lab, lab = cv2.connectedComponents(hands.astype(np.uint8))
                touch = np.unique(lab[dilate(body, 3) & hands])
                body |= np.isin(lab, touch[touch > 0])
            area = int(body.sum())
            sel = erode(body, 3 if area > 20000 else 1) & ~edges & (d < 8)
            pts, vv, uu = backproject(d, v.K(idx), sel, stride=1)
            if len(pts) > per_frame:
                pick = rng.choice(len(pts), per_frame, replace=False)
                pts, vv, uu = pts[pick], vv[pick], uu[pick]
            seqs[k].append((transform(wp.c2w(idx), pts), rgb[vv, uu]))
    from .cleanup import keep_ghost

    out = []
    (work / "world" / "ghosts").mkdir(parents=True, exist_ok=True)
    real = []
    for k in range(len(tracks)):
        ok, why = keep_ghost(seqs[k], hz)
        if ok:
            real.append(k)
        else:
            print(f"[l0] dropped a 'person' track ({why})")
    for n, k in enumerate(real):
        tr = tracks[k]
        gid = f"person-{n}"
        write_points_sequence(work / "world" / "ghosts" / f"{gid}.bin", seqs[k], hz)
        vis = [i for i, (p, _) in enumerate(seqs[k]) if len(p)]
        out.append(DynamicObject(
            id=gid, label="person",
            visual={"kind": "points-sequence", "url": f"world/ghosts/{gid}.bin", "frameCount": len(seqs[k]), "sampleHz": hz},
            collider={"kind": "capsule", "halfHeight": 0.6, "radius": 0.25}, mass=0, grabbable=False,
            visibleFrom=vis[0] / hz if vis else 0.0, visibleTo=vis[-1] / hz if vis else 0.0,
            track=[Keyframe(t=0, p=(0, 0, 0), q=(0, 0, 0, 1))]))
    return out


# --- the stage -----------------------------------------------------------------------------------------
def run(work: Path) -> None:
    import trimesh  # noqa: F401

    work = Path(work)
    v = Vipe(work / "vipe")
    wp = WorldPoses(work)
    frames = FramesInfo.model_validate_json((work / "input" / "frames.json").read_text())
    winfo = WorldInfo.model_validate_json((work / "world" / "world.json").read_text())

    from .objects import scene_static_ids

    xyz, rgb = room_points(work, v, wp, frames, extra_static=scene_static_ids(work))
    write_splat_ply(work / "world" / "bg_points.ply", xyz, rgb)
    winfo.bgPointsCount = len(xyz)
    lo, hi = np.percentile(xyz, 0.5, axis=0), np.percentile(xyz, 99.5, axis=0)
    winfo.boundsMin, winfo.boundsMax = tuple(lo.tolist()), tuple(hi.tolist())
    (work / "world" / "world.json").write_text(winfo.model_dump_json(indent=2))
    print(f"[l0] room: {len(xyz)} points")

    H, origin = heightfield(xyz, lo, hi)
    heightfield_mesh(H, origin).export(work / "world" / "room_collider.glb")
    np.savez(work / "world" / "room_heightfield.npz", H=H, origin=np.array(origin))   # S5 reads heights from this
    print(f"[l0] collider: {H.shape[0]}x{H.shape[1]} cells, {np.mean(H > 0.3) * 100:.0f}% raised")

    people = ghosts(work, v, wp, frames)
    (work / "world" / "ghosts.json").write_text(ObjectsFragment(objects=people).model_dump_json(indent=2))
    print(f"[l0] ghosts: {len(people)} people")
