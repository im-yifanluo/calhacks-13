"""A synthetic 'ViPE output' with known ground truth, for testing S3-S7 without a GPU.

A room (floor, three walls, a table), a ball that rests on the table, is thrown at t = 2 s and lands on the
floor, and a person walking across. A camera at chest height looks down at the floor, then walks sideways
while panning. Everything is ray-traced at low resolution and written in ViPE's layout, inside a random rigid
frame (as ViPE's arbitrary world frame would be), so S3 has to find the floor and up direction itself.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import cv2
import numpy as np

W, H, FPS = 180, 320, 30
CAM_H = 1.35
BALL_R = 0.11
TABLE = (np.array([0.2, 0.0, -2.0]), np.array([1.0, 0.75, -1.4]))  # box min / max
PERSON_SIZE = np.array([0.45, 1.75, 0.3])
G = 9.81
THROW_T, THROW_V = 2.0, np.array([-1.2, 2.6, 0.4])


def ball_pos(t: float) -> np.ndarray:
    p0 = np.array([0.6, TABLE[1][1] + BALL_R, -1.7])
    if t < THROW_T:
        return p0
    tt = t - THROW_T
    p = p0 + THROW_V * tt + np.array([0, -0.5 * G * tt * tt, 0])
    if p[1] <= BALL_R:  # landed: solve for the landing time and stay there
        a, b, c = -0.5 * G, THROW_V[1], p0[1] - BALL_R
        tl = (-b - np.sqrt(b * b - 4 * a * c)) / (2 * a)
        p = p0 + THROW_V * tl + np.array([0, -0.5 * G * tl * tl, 0])
        p[1] = BALL_R
    return p


def person_box(t: float) -> tuple[np.ndarray, np.ndarray]:
    x = -1.6 + 0.5 * t
    c = np.array([x, PERSON_SIZE[1] / 2, -2.8])
    return c - PERSON_SIZE / 2, c + PERSON_SIZE / 2


def camera(t: float) -> np.ndarray:
    """c2w in the true world, OpenCV axes."""
    if t < 1.0:
        pitch, yaw, x = -55.0, 0.0, 0.0
    else:
        s = (t - 1.0) / 5.0
        pitch, yaw, x = -20.0 + 5 * np.sin(3 * s), 25 * np.sin(2 * np.pi * s * 0.8), 1.2 * s
    p, y = np.radians(pitch), np.radians(yaw)
    fwd = np.array([-np.sin(y) * np.cos(p), np.sin(p), -np.cos(y) * np.cos(p)])
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    c2w = np.eye(4)
    c2w[:3, 0], c2w[:3, 1], c2w[:3, 2] = right, down, fwd
    c2w[:3, 3] = [x, CAM_H + 0.02 * np.sin(5 * t), 0.3 * np.sin(t)]
    return c2w


def _box_hit(o, d, lo, hi):
    with np.errstate(divide="ignore", invalid="ignore"):
        t1, t2 = (lo - o) / d, (hi - o) / d
    tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
    tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
    return np.where((tmax >= tmin) & (tmax > 0), np.where(tmin > 0, tmin, np.inf), np.inf)


def render(t: float, K: np.ndarray, c2w: np.ndarray):
    v, u = np.mgrid[0:H, 0:W]
    dcam = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u, float)], -1)
    d = dcam @ c2w[:3, :3].T
    o = c2w[:3, 3]
    depth = np.full((H, W), np.inf)
    color = np.zeros((H, W, 3))
    ident = np.zeros((H, W), np.uint8)

    def take(tt, col, iid=0):
        nonlocal depth
        closer = tt < depth
        depth = np.where(closer, tt, depth)
        color[closer] = col(closer) if callable(col) else col
        ident[closer] = iid

    with np.errstate(divide="ignore", invalid="ignore"):
        tf = np.where(d[..., 1] < 0, -o[1] / d[..., 1], np.inf)  # floor y = 0
    pf = o + d * tf[..., None]
    inside = (np.abs(pf[..., 0]) < 3) & (pf[..., 2] > -4) & (pf[..., 2] < 3)
    tf = np.where(inside, tf, np.inf)
    take(
        tf,
        lambda m: np.where(
            ((np.floor(pf[m, 0] * 2) + np.floor(pf[m, 2] * 2)) % 2 == 0)[:, None], [200, 190, 170], [120, 110, 100]
        ),
    )
    for axis, val, col in ((2, -4.0, [180, 200, 220]), (0, -3.0, [210, 190, 160]), (0, 3.0, [170, 210, 170])):
        with np.errstate(divide="ignore", invalid="ignore"):
            tw = (val - o[axis]) / d[..., axis]
        pw = o + d * tw[..., None]
        ok = (tw > 0) & (pw[..., 1] > 0) & (pw[..., 1] < 2.6)
        take(
            np.where(ok, tw, np.inf),
            lambda m, pw=pw, col=col: np.array(col) * (0.85 + 0.15 * (np.floor(pw[m, 1] * 3) % 2))[:, None],
        )
    take(_box_hit(o, d, *TABLE), [110, 70, 40])
    take(_box_hit(o, d, *person_box(t)), [200, 60, 60], 2)
    c = ball_pos(t)
    oc = o - c
    b = np.sum(d * oc, -1)
    a = np.sum(d * d, -1)
    disc = b * b - a * (oc @ oc - BALL_R**2)
    with np.errstate(invalid="ignore"):
        tb = np.where(disc > 0, (-b - np.sqrt(np.maximum(disc, 0))) / a, np.inf)
    take(np.where(tb > 0, tb, np.inf), [240, 200, 30], 1)
    depth = np.where(np.isfinite(depth), depth, 50.0).astype(np.float32)  # z-depth, since dcam.z = 1
    return depth, color.astype(np.uint8), ident


def make(work: Path, seconds: float = 6.0, seed: int = 3) -> dict:
    """Write <work>/input/clip.mp4 + frames.json + nouns.json + capture.json and <work>/vipe/ like ViPE would."""
    work = Path(work)
    for d in ("input", "vipe/pose", "vipe/intrinsics", "vipe/depth", "vipe/mask"):
        (work / d).mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    axis = rng.normal(size=3)
    axis /= np.linalg.norm(axis)
    ang = np.radians(40)
    Kx = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    A = np.eye(4)
    A[:3, :3] = np.eye(3) + np.sin(ang) * Kx + (1 - np.cos(ang)) * Kx @ Kx
    A[:3, 3] = rng.normal(size=3)
    K = np.array([[160.0, 0, W / 2 - 0.5], [0, 160.0, H / 2 - 0.5], [0, 0, 1]])
    n = int(seconds * FPS)
    vw = cv2.VideoWriter(str(work / "input" / "clip.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    poses = []
    with (
        zipfile.ZipFile(work / "vipe/depth/clip.zip", "w") as zd,
        zipfile.ZipFile(work / "vipe/mask/clip.zip", "w") as zm,
    ):
        for i in range(n):
            t = i / FPS
            c2w = camera(t)
            depth, rgb, ident = render(t, K, c2w)
            vw.write(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
            zd.writestr(
                f"{i:05d}.exr",
                cv2.imencode(".exr", depth, [cv2.IMWRITE_EXR_TYPE, cv2.IMWRITE_EXR_TYPE_HALF])[1].tobytes(),
            )
            zm.writestr(f"{i:05d}.png", cv2.imencode(".png", ident)[1].tobytes())
            poses.append(A @ c2w)
    vw.release()
    inds = np.arange(n)
    np.savez(work / "vipe/pose/clip.npz", data=np.array(poses), inds=inds)
    np.savez(work / "vipe/intrinsics/clip.npz", data=np.tile([K[0, 0], K[1, 1], K[0, 2], K[1, 2]], (n, 1)), inds=inds)
    (work / "vipe/mask/clip.txt").write_text("0: background\n1: ball\n2: person\n")
    (work / "input/frames.json").write_text(
        json.dumps(
            {
                "source": "synthetic",
                "fps": FPS,
                "width": W,
                "height": H,
                "frame_count": n,
                "key_stride": 3,
                "duration_sec": n / FPS,
            }
        )
    )
    (work / "nouns.json").write_text(json.dumps({"nouns": ["person", "hand", "ball"]}))
    (work / "capture.json").write_text(json.dumps({"eye_height_m": CAM_H}))
    return {"A": A, "K": K, "frames": n}
