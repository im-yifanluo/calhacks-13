"""S5 objects: every prompted prop ViPE segmented -> a grabbable primitive with a 10 Hz track and velocity.

  observe()  one pass over the keyframes: per mask id, its pixels, 3D position and extent (objects/observations.json)
  group()    join ids that are re-detections of one object (same label, no time overlap, plausible distance)
  track()    10 Hz positions: outlier rejection, gap filling (ballistic for throws), smoothing, velocity, rest
  run()      + Claude (or a fallback table) for shape, size, density, colour -> objects/objects.json
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np
from scipy.signal import savgol_filter

from .handoff import FramesInfo, ObjectsFragment, ObjectSpec, object_slug
from .manifest import DynamicObject, Keyframe
from .vipe_io import (HAND_PHRASES, IGNORED_PHRASES, PEOPLE_PHRASES, Frames, Vipe, backproject, depth_edges, erode,
                      transform)
from .world import WorldPoses

G = np.array([0.0, -9.81, 0.0])
MIN_OBS = 3                 # keyframes an object must be seen in
MAX_EXTENT = 1.2            # m; bigger "objects" are furniture or bad masks
REST_SPEED = 0.25           # m/s


# --- observe -----------------------------------------------------------------------------------------
def observe(work: Path, v: Vipe | None = None) -> dict:
    work = Path(work)
    v = v or Vipe(work / "vipe")
    wp = WorldPoses(work)
    frames = FramesInfo.model_validate_json((work / "input" / "frames.json").read_text())
    skip = IGNORED_PHRASES | PEOPLE_PHRASES | HAND_PHRASES
    cand = {i for i, p in v.phrases.items() if i > 0 and p not in skip}
    obs: dict[int, list[dict]] = {i: [] for i in cand}
    if cand and v.has_masks:
        reader = Frames(work / "input" / "clip.mp4")
        for idx in range(0, frames.frame_count, frames.key_stride):
            if idx > v.frame_indices[-1]:
                break
            m = v.mask(idx)
            if m is None or not wp.good(idx):
                continue
            present = [int(i) for i in np.unique(m) if int(i) in cand]
            if not present:
                continue
            d = v.depth(idx) * wp.depth_scale(idx)
            edges = depth_edges(d, rel=0.03, absolute=0.05)
            Tc = wp.c2w(idx)
            gray = None
            for i in present:
                full = m == i
                area = int(full.sum())
                if area < 60:
                    continue
                core = erode(full, 2 if area > 1500 else 1) & ~edges & (d < 8)
                if core.sum() < 20:
                    core = full & (d < 8)
                pts, vv, uu = backproject(d, v.K(idx), core, stride=1)
                if len(pts) < 15:
                    continue
                pw = transform(Tc, pts)
                lo, hi = np.percentile(pw, 5, 0), np.percentile(pw, 95, 0)
                ys, xs = np.nonzero(full)
                zmed = float(np.median(pts[:, 2]))
                K = v.K(idx)
                sc = float(np.linalg.norm(Tc[:3, 0]))              # world scale (S3)
                sil = [(xs.max() - xs.min() + 1) * zmed * sc / K[0, 0], (ys.max() - ys.min() + 1) * zmed * sc / K[1, 1]]
                if gray is None:
                    gray = cv2.cvtColor(reader.get(idx), cv2.COLOR_RGB2GRAY)
                x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
                sharp = float(cv2.Laplacian(gray[y0:y1, x0:x1], cv2.CV_64F).var()) if (x1 - x0) > 3 and (y1 - y0) > 3 else 0.0
                obs[i].append({"idx": idx, "area": area, "bbox": [x0, y0, x1, y1], "pos": np.median(pw, 0).tolist(),
                               "ext": (hi - lo).tolist(), "sil": sil, "cam": Tc[:3, 3].tolist(), "sharp": sharp,
                               "touches_border": bool(x0 <= 1 or y0 <= 1 or x1 >= m.shape[1] - 1 or y1 >= m.shape[0] - 1)})
    out = {"phrases": {str(i): v.phrases[i] for i in cand}, "obs": {str(i): o for i, o in obs.items() if o}}
    (work / "objects").mkdir(exist_ok=True)
    (work / "objects" / "observations.json").write_text(json.dumps(out))
    return out


# --- group -------------------------------------------------------------------------------------------
def _plausible(pa, pb, T: float, vmax: float = 12.0) -> bool:
    """Could something get from pa to pb in T seconds? (small moves always; otherwise a projectile launched
    under vmax m/s)."""
    d = np.subtract(pb, pa)
    if np.linalg.norm(d) < 0.4:
        return True
    T = max(T, 1e-3)
    v0 = (d - 0.5 * G * T * T) / T
    return bool(np.linalg.norm(v0) < vmax + 0.4 / T)


def _segments(obs: list[dict], fps: float) -> list[list[dict]]:
    """Split one mask id's sightings wherever the position jumps further than anything could move
    (0.4 m + 4 m/s x time): ViPE's tracker sometimes hops onto a similar-looking object."""
    segs, cur = [], [obs[0]]
    for a, b in zip(obs[:-1], obs[1:]):
        dt = (b["idx"] - a["idx"]) / fps
        if not _plausible(a["pos"], b["pos"], dt):
            segs.append(cur)
            cur = []
        cur.append(b)
    segs.append(cur)
    return segs


def _centre(obs: list[dict]) -> np.ndarray:
    return np.median(np.array([o["pos"] for o in obs]), 0)


def group(observations: dict, fps: float) -> list[dict]:
    """Pieces (id segments) -> objects. Join pieces with the same label that sit in the same place (static
    re-detections, centres within 0.5 m) or that continue each other in time (gap < 1.5 s, plausible jump).
    Two different ids seen in the same frame are different objects unless they nearly coincide."""
    pieces = []
    for sid, ob in observations["obs"].items():
        ob = sorted(ob, key=lambda o: o["idx"])
        for seg in _segments(ob, fps):
            pieces.append({"ids": [int(sid)], "label": observations["phrases"][sid], "obs": seg})
    pieces.sort(key=lambda it: it["obs"][0]["idx"])
    objects: list[dict] = []
    for it in pieces:
        c = _centre(it["obs"])
        frames_it = {o["idx"] for o in it["obs"]}
        best, best_d = None, 1e9
        for o in objects:
            if o["label"] != it["label"]:
                continue
            d = float(np.linalg.norm(_centre(o["obs"]) - c))
            shared = frames_it & {x["idx"] for x in o["obs"]}
            if shared and not set(it["ids"]) <= set(o["ids"]) and d > 0.15:
                continue                                         # seen side by side: two objects
            ok = d < 0.5
            last, first = o["obs"][-1], it["obs"][0]
            if not ok and last["idx"] < first["idx"]:
                gap = (first["idx"] - last["idx"]) / fps
                ok = gap < 1.5 and _plausible(last["pos"], first["pos"], gap)
            if ok and d < best_d:
                best, best_d = o, d
        if best is None:
            objects.append({"ids": list(it["ids"]), "label": it["label"], "obs": list(it["obs"])})
        else:
            best["ids"] = sorted(set(best["ids"]) | set(it["ids"]))
            merged = {o["idx"]: o for o in best["obs"]}
            for o in it["obs"]:                                 # one sighting per frame: keep the bigger view
                if o["idx"] not in merged or o["area"] > merged[o["idx"]]["area"]:
                    merged[o["idx"]] = o
            best["obs"] = [merged[k] for k in sorted(merged)]
    return objects


# --- track -------------------------------------------------------------------------------------------
def _hampel(P: np.ndarray, win: int = 3, k: float = 3.0, floor: float = 0.08) -> np.ndarray:
    """Boolean inliers: samples within k * MAD (at least `floor` m) of the local median."""
    n = len(P)
    ok = np.ones(n, bool)
    for i in range(n):
        a, b = max(0, i - win), min(n, i + win + 1)
        med = np.median(P[a:b], 0)
        mad = np.median(np.abs(P[a:b] - med), 0) * 1.4826
        if np.any(np.abs(P[i] - med) > np.maximum(k * mad, floor)):
            ok[i] = False
    return ok


def track(samples: list[tuple[int, np.ndarray]], key_stride: int, fps: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """samples: (frame idx, world position) for one object. Returns keyframe times, positions, velocities on the
    10 Hz grid between the first and last sighting."""
    dt = key_stride / fps
    ks = np.array([s[0] // key_stride for s in samples])
    P = np.array([s[1] for s in samples], float)
    if len(P) >= 5:
        ok = _hampel(P)
        ks, P = ks[ok], P[ok]
    k0, k1 = int(ks[0]), int(ks[-1])
    K = np.arange(k0, k1 + 1)
    pos = np.full((len(K), 3), np.nan)
    pos[ks - k0] = P
    known = ~np.isnan(pos[:, 0])
    vel = np.full_like(pos, np.nan)
    ballistic = np.zeros(len(K), bool)
    # smooth each run of consecutive sightings (Savitzky-Golay, window 7, order 2)
    runs = np.split(np.flatnonzero(known), np.flatnonzero(np.diff(np.flatnonzero(known)) > 1) + 1)
    for r in runs:
        if len(r) >= 7:
            pos[r] = savgol_filter(pos[r], 7, 2, axis=0)
    # fill gaps
    for a, b in zip(runs[:-1], runs[1:]):
        i0, i1 = a[-1], b[0]
        T = (i1 - i0) * dt
        p0, p1 = pos[i0], pos[i1]
        ts = np.arange(1, i1 - i0) * dt
        moved = np.linalg.norm(p1 - p0)
        v0 = (p1 - p0 - 0.5 * G * T * T) / T
        apex = p0[1] + max(0.0, v0[1]) ** 2 / (2 * 9.81)
        j = a[max(0, len(a) - 3)]                                 # was it already moving that way before the gap?
        v_before = (pos[i0] - pos[j]) / ((i0 - j) * dt) if i0 > j else None
        throw = (v_before is not None and np.linalg.norm(v_before) > REST_SPEED
                 and np.linalg.norm(v_before - v0) < max(1.5, 0.5 * np.linalg.norm(v0)))
        if moved > 0.4 and T <= 1.2 and apex < 3.0 and throw:     # flew through the gap: projectile arc
            pos[i0 + 1:i1] = p0 + np.outer(ts, v0) + 0.5 * np.outer(ts ** 2, G)
            vel[i0 + 1:i1] = v0 + np.outer(ts, G)
            ballistic[i0 + 1:i1] = True
        else:
            pos[i0 + 1:i1] = p0 + np.outer(ts / T, p1 - p0)
    # velocity: central differences on the filled track (one-sided at the ends)
    if len(K) >= 2:
        g = np.gradient(pos, dt, axis=0)
        vel[~ballistic] = g[~ballistic]
    else:
        vel[:] = 0
    # at rest: freeze jitter so a paused object doesn't drift
    speed = np.linalg.norm(vel, axis=1)
    still = (speed < REST_SPEED) & known                       # gap-filled frames are guesses, not rests
    i = 0
    while i < len(K):
        if still[i]:
            j = i + 1                                          # grow the rest only while it stays in place
            while j < len(K) and still[j] and np.linalg.norm(pos[j] - np.median(pos[i:j], 0)) < 0.10:
                j += 1
            if (j - i) * dt >= 0.5:
                pos[i:j] = np.median(pos[i:j], 0)
                vel[i:j] = 0
            i = j
        else:
            i += 1
    return K * dt, pos, vel


# --- crops and colour ----------------------------------------------------------------------------------
def best_crop(work: Path, obj: dict, out: Path) -> tuple[Path, str]:
    """Save the largest, sharpest, unclipped view of the object; return (path, mean colour #rrggbb)."""
    cands = [o for o in obj["obs"] if not o["touches_border"]] or obj["obs"]
    o = max(cands, key=lambda o: o["area"] * (1 + math.log1p(o["sharp"])))
    reader = Frames(work / "input" / "clip.mp4")
    rgb = reader.get(o["idx"])
    x0, y0, x1, y1 = o["bbox"]
    m = Vipe(work / "vipe").mask(o["idx"])
    color = "#808080"
    if m is not None:
        sel = np.isin(m, obj["ids"])
        if sel.any():
            c = np.median(rgb[sel], 0).astype(int)
            color = "#{:02x}{:02x}{:02x}".format(*c)
    cx, cy, half = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) * 0.8 + 24
    h, w = rgb.shape[:2]
    X0, Y0, X1, Y1 = int(max(0, cx - half)), int(max(0, cy - half)), int(min(w, cx + half)), int(min(h, cy + half))
    crop = rgb[Y0:Y1, X0:X1]
    if max(crop.shape[:2]) < 256:
        f = 256 / max(crop.shape[:2])
        crop = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    return out, color


def observed_size(obj: dict) -> tuple[float, float, float]:
    """Typical size (x, y, z) in meters. Depth points only cover the visible side, so the silhouette
    (pixel extent x depth / focal length) sets a floor for the horizontal and vertical sizes."""
    ob = [o for o in obj["obs"] if not o["touches_border"]] or obj["obs"]
    e = np.percentile(np.array([o["ext"] for o in ob]), 75, axis=0)
    if all("sil" in o for o in ob):
        sw, sh = np.percentile(np.array([o["sil"] for o in ob]), 60, axis=0)
        e[1] = max(e[1], sh)
        e[0] = max(e[0], min(sw, 1.5 * max(e[0], e[2])))
        e[2] = max(e[2], min(sw, 1.5 * max(e[0], e[2])))
    return tuple(float(x) for x in np.clip(e, 0.02, None))


def clamp_spec(spec: ObjectSpec, seen: tuple[float, float, float]) -> ObjectSpec:
    """Keep Claude's size within 0.5-2x of the largest extent we actually saw."""
    big = max(seen)
    f = max(spec.size_m)
    if f > 0 and not (0.5 * big <= f <= 2.0 * big):
        target = min(max(f, 0.5 * big), 2.0 * big)
        spec.size_m = tuple(s * target / f for s in spec.size_m)
    return spec


def volume(spec: ObjectSpec) -> float:
    x, y, z = spec.size_m
    if spec.shape == "sphere":
        return 4 / 3 * math.pi * (max(x, y, z) / 2) ** 3
    if spec.shape == "cylinder":
        return math.pi * (max(x, z) / 2) ** 2 * y
    return x * y * z


def collider(spec: ObjectSpec) -> dict:
    x, y, z = spec.size_m
    if spec.shape == "sphere":
        return {"kind": "sphere", "radius": max(x, y, z) / 2}
    if spec.shape == "cylinder":
        return {"kind": "cylinder", "halfHeight": y / 2, "radius": max(x, z) / 2}
    return {"kind": "box", "halfExtents": (x / 2, y / 2, z / 2)}


class Support:
    """Height of the room collider (floor, seats, tables; wall columns ignored) under a point; 0 without one."""

    def __init__(self, work: Path):
        p = Path(work) / "world" / "room_heightfield.npz"
        self.H = None
        if p.exists():
            z = np.load(p)
            self.H, (self.x0, self.z0, self.cell) = z["H"], z["origin"]

    def __call__(self, x: float, z: float) -> float:
        if self.H is None:
            return 0.0
        i, j = int(np.floor((x - self.x0) / self.cell)), int(np.floor((z - self.z0) / self.cell))
        if not (0 <= i < self.H.shape[0] and 0 <= j < self.H.shape[1]):
            return 0.0
        h = float(self.H[i, j])
        return h if h < 1.3 else 0.0


# --- the stage -----------------------------------------------------------------------------------------
MAX_PROP = 1.0      # m; bigger things stay part of the room


# Labels that are clothing or carried by a person: they belong to the moving person (the ghost), and as "props"
# they would slide around the room on their own.
WORN = ("lanyard", "badge", "shoe", "sneaker", "boot", "hat", "cap", "glasses", "headphone", "earbud", "watch",
        "phone", "backpack", "bag", "purse", "jacket", "hoodie", "shirt", "mask", "cable", "wire", "cord", "hand", "camera")


def select(work: Path, use_claude: bool | None = None) -> list[dict]:
    """Group sightings into objects and decide which become grabbable props (Claude or the fallback table).
    Runs before S4 so that only kept props (and people) are cut out of the room. objects/selection.json"""
    mfile = work / "objects" / "manual_specs.json"
    manual = json.loads(mfile.read_text()) if mfile.exists() else {}
    from . import claude

    work = Path(work)
    frames = FramesInfo.model_validate_json((work / "input" / "frames.json").read_text())
    obs_path = work / "objects" / "observations.json"
    observations = json.loads(obs_path.read_text()) if obs_path.exists() else observe(work)
    use_claude = claude.available() if use_claude is None else use_claude
    counts: dict[str, int] = {}
    out = []
    for g in group(observations, frames.fps):
        if len(g["obs"]) < MIN_OBS:
            continue
        seen = observed_size(g)
        n = counts.get(g["label"], 0)
        counts[g["label"]] = n + 1
        oid = object_slug(g["label"], n)
        entry = {"id": oid, "label": g["label"], "ids": g["ids"], "obs": g["obs"], "observed_size_m": seen}
        if max(seen) > MAX_EXTENT:
            out.append({**entry, "keep": False, "reason": f"too big ({max(seen):.1f} m)"})
            continue
        if any(w in g["label"].lower() for w in WORN):          # things on people move with the person, not as props
            out.append({**entry, "keep": False, "reason": "worn or held"})
            continue
        crop, color = best_crop(work, g, work / "objects" / "crops" / f"{oid}.jpg")
        bottom = float(np.median([o["pos"][1] - o["ext"][1] / 2 for o in g["obs"]]))
        entry["bottom_above_floor_m"] = bottom
        source, spec = "fallback", claude.fallback_spec(g["label"], seen, color)
        if bottom > 2.0:                                    # nothing rests 2 m up: mounted
            spec.movable = False
        # objects/manual_specs.json: {label or id: {shape, size_m, density_kg_m3, grabbable, movable}} written by a
        # person (or Claude in chat) when the API is unavailable; wins over the API
        man = manual.get(oid) or manual.get(g["label"])
        if man:
            spec, source = spec.model_copy(update={k: (tuple(v) if k == "size_m" else v) for k, v in man.items()
                                                   if k in ObjectSpec.model_fields}), "manual"
        elif use_claude:
            try:
                spec, source = claude.describe(crop, g["label"], seen, bottom), "claude"
            except Exception as e:  # network, quota, refusal: keep the fallback
                print(f"[objects] Claude failed for {oid} ({e}); using the fallback table")
        spec = clamp_spec(spec, seen)
        keep = spec.grabbable and spec.movable and max(spec.size_m) <= MAX_PROP
        reason = ("" if keep else "mounted/fixed" if not spec.movable else "not grabbable" if not spec.grabbable
                  else f"too big ({max(spec.size_m):.1f} m)")
        out.append({**entry, "keep": bool(keep), "reason": reason,
                    "spec": spec.model_dump(), "spec_source": source})
    (work / "objects" / "selection.json").write_text(json.dumps(out))
    print(f"[objects] kept {sum(e['keep'] for e in out)} of {len(out)}: "
          + ", ".join(f"{e['id']}{'' if e['keep'] else ' (' + e['reason'] + ')'}" for e in out))
    return out


def scene_static_ids(work: Path) -> list[int]:
    """Mask ids that stay part of the room: segmented things we did not keep as props (signs, benches...)."""
    p = Path(work) / "objects" / "selection.json"
    if not p.exists():
        return []
    sel = json.loads(p.read_text())
    kept = {i for e in sel if e["keep"] for i in e["ids"]}
    return sorted({i for e in sel if not e["keep"] for i in e["ids"]} - kept)


def run(work: Path, use_claude: bool | None = None) -> list[DynamicObject]:
    work = Path(work)
    frames = FramesInfo.model_validate_json((work / "input" / "frames.json").read_text())
    sel_path = work / "objects" / "selection.json"
    selection = json.loads(sel_path.read_text()) if sel_path.exists() else select(work, use_claude)
    support = Support(work)
    result, report = [], []
    for e in selection:
        if not e["keep"]:
            report.append({"id": e["id"], "label": e["label"], "kept": False, "reason": e["reason"], "mask_ids": e["ids"]})
            continue
        g, oid, seen, source = e, e["id"], tuple(e["observed_size_m"]), e["spec_source"]
        spec = ObjectSpec.model_validate(e["spec"])
        half_h = spec.size_m[1] / 2
        depth_bias = 0.35 * min(spec.size_m)                   # the median of the visible surface sits in front
        samples = []
        for o in sorted(g["obs"], key=lambda o: o["idx"]):
            p, c = np.array(o["pos"]), np.array(o["cam"])
            ray = p - c
            samples.append((o["idx"], p + depth_bias * ray / max(np.linalg.norm(ray), 1e-6), not o["touches_border"]))
        whole = [s for s in samples if s[2]]                    # views cut by the image edge bias a static centre
        S = np.array([s[1] for s in (whole if len(whole) >= 3 else samples)])
        centre = np.median(S, 0)
        dist = np.linalg.norm(S - centre, axis=1)
        spread = float(np.percentile(dist, 80))
        # a sustained excursion (3 of 5 sightings in a row) is real motion even if it is a small share of the clip
        from scipy.ndimage import median_filter as _mf
        excursion = float(_mf(dist, size=5, mode="nearest").max()) if len(dist) >= 5 else spread
        thr = max(0.2, 0.75 * max(spec.size_m))
        static = spread < thr and excursion < thr
        if static:
            # never moved: the scatter is depth noise and changing viewpoints, not motion
            t, P, V = np.array([samples[0][0], samples[-1][0]]) / frames.fps, np.array([centre, centre]), np.zeros((2, 3))
        else:
            t, P, V = track([(i, q) for i, q, _ in samples], frames.key_stride, frames.fps)
        # resting at the ends: the object exists for the whole memory (hold its first/last place). Moving or in the
        # air at an end (thrown in or out of view): only show it while it was seen, rather than leave it floating.
        dur = frames.duration_sec
        def airborne(k):
            return (not static and (np.linalg.norm(V[k]) > REST_SPEED or
                    (support.H is not None and P[k, 1] - half_h - support(P[k, 0], P[k, 2]) > 0.12)))
        vis0 = float(t[0]) if airborne(0) else 0.0
        vis1 = float(t[-1]) if airborne(-1) else float(dur)
        if t[0] > 0 and vis0 == 0.0:
            t, P, V = np.r_[0.0, t], np.vstack([P[:1], P]), np.vstack([np.zeros((1, 3)), V])
        if t[-1] < dur and vis1 == float(dur):
            t, P, V = np.r_[t, dur], np.vstack([P, P[-1:]]), np.vstack([V, np.zeros((1, 3))])
        # never inside the floor or a table: lift the bottom onto the support below
        for k in range(len(P)):
            floor = support(P[k, 0], P[k, 2])
            gap = P[k, 1] - half_h - floor
            resting = not V[k].any()
            if gap < 0 or (resting and gap < 0.12):           # inside the support, or hovering just above it at rest
                P[k, 1] = floor + half_h
                if V[k, 1] < 0 and np.linalg.norm(V[k]) < 1.0:
                    V[k, 1] = 0.0
        # density x box volume runs away on things whose box is mostly air (a cable across a stage came out at
        # 125 kg, a lanyard at 16 kg): nothing a hand picks up weighs more than ~15 kg, nothing less than 10 g
        mass = float(np.clip(spec.density_kg_m3 * volume(spec), 0.01, 15.0))
        result.append(DynamicObject(
            id=oid, label=spec.label or g["label"],
            visual={"kind": "primitive", "shape": spec.shape, "size": spec.size_m, "color": spec.color},
            collider=collider(spec), mass=round(mass, 4), grabbable=spec.grabbable,
            visibleFrom=vis0, visibleTo=vis1,
            track=[Keyframe(t=round(float(tt), 4), p=tuple(np.round(p, 4)), q=(0, 0, 0, 1), v=tuple(np.round(vv, 4)))
                   for tt, p, vv in zip(t, P, V)]))
        speeds = np.linalg.norm(V, axis=1)
        report.append({"id": oid, "label": spec.label, "kept": True, "mask_ids": g["ids"], "sightings": len(g["obs"]), "spec_source": source,
                       "static": bool(static), "sighting_spread_m": round(spread, 3),
                       "shape": spec.shape, "size_m": spec.size_m, "observed_size_m": seen, "mass_kg": round(mass, 3),
                       "visible": [float(t[0]), float(t[-1])], "max_speed_m_s": float(speeds.max()),
                       "path_length_m": float(np.sum(np.linalg.norm(np.diff(P, axis=0), axis=1))) if len(P) > 1 else 0.0})
    (work / "objects" / "objects.json").write_text(ObjectsFragment(objects=result).model_dump_json(indent=2))
    (work / "objects" / "report.json").write_text(json.dumps(report, indent=2))
    print(f"[objects] {len(result)} objects: " + ", ".join(f"{r['id']} ({r['shape']}, {r['mass_kg']} kg, "
                                                          f"{r['sightings']} sightings)" for r in report if r["kept"]))
    return result
