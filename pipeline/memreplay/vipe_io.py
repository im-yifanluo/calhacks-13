"""Read ViPE's artifacts (checked against ViPE 8c9f361, vipe/utils/io.py) without importing ViPE.

  <work>/vipe/pose/clip.npz        data (N,4,4) camera-to-world, OpenCV axes (x right, y down, z forward); inds (N,)
  <work>/vipe/intrinsics/clip.npz  data (N,4) [fx, fy, cx, cy] at full input resolution; inds (N,)
  <work>/vipe/depth/clip.zip       {idx:05d}.exr, one HALF channel "Z": z-depth in meters (not ray length), every pixel
  <work>/vipe/mask/clip.zip        {idx:05d}.png, uint8 instance id; 0 = background (anything no prompt matched)
  <work>/vipe/mask/clip.txt        "id: phrase" lines, including "0: background" and "sky"

Pixel convention: integer pixel index, no +0.5: x = (u - cx) / fx * z.
"""
from __future__ import annotations

import os
import zipfile
from functools import cached_property
from pathlib import Path

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")   # must be set before OpenCV decodes its first EXR
import cv2  # noqa: E402
import numpy as np  # noqa: E402

IGNORED_PHRASES = {"background", "sky"}
PEOPLE_PHRASES = {"person", "man", "woman", "people", "child", "kid", "boy", "girl"}
HAND_PHRASES = {"hand", "hands", "arm"}


def _decode_exr(buf: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is not None:
        return img.astype(np.float32)
    import io

    import OpenEXR  # fallback when this OpenCV build has no EXR codec
    f = OpenEXR.InputFile(io.BytesIO(buf))
    dw = f.header()["dataWindow"]
    w, h = dw.max.x - dw.min.x + 1, dw.max.y - dw.min.y + 1
    import Imath
    raw = f.channel("Z", Imath.PixelType(Imath.PixelType.FLOAT))
    return np.frombuffer(raw, np.float32).reshape(h, w).copy()


class Vipe:
    """Lazy access to one ViPE result folder (<work>/vipe)."""

    def __init__(self, vdir: Path, name: str = "clip"):
        self.dir = Path(vdir)
        self.name = name
        self._depth_zip: zipfile.ZipFile | None = None
        self._mask_zip: zipfile.ZipFile | None = None

    # --- cameras ---
    @cached_property
    def poses(self) -> tuple[np.ndarray, np.ndarray]:
        z = np.load(self.dir / "pose" / f"{self.name}.npz")
        return z["inds"].astype(int), z["data"].astype(np.float64)

    @cached_property
    def intrinsics(self) -> tuple[np.ndarray, np.ndarray]:
        z = np.load(self.dir / "intrinsics" / f"{self.name}.npz")
        return z["inds"].astype(int), z["data"].astype(np.float64)

    @cached_property
    def _pose_row(self) -> dict[int, int]:
        return {int(i): k for k, i in enumerate(self.poses[0])}

    def c2w(self, idx: int) -> np.ndarray:
        """Camera-to-ViPE-world for frame idx (nearest posed frame if idx itself has no pose)."""
        inds, data = self.poses
        k = self._pose_row.get(int(idx))
        return data[k if k is not None else int(np.argmin(np.abs(inds - idx)))]

    def K(self, idx: int) -> np.ndarray:
        inds, data = self.intrinsics
        fx, fy, cx, cy = data[min(np.searchsorted(inds, idx), len(inds) - 1)][:4]
        return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1.0]])

    @property
    def frame_indices(self) -> np.ndarray:
        return self.poses[0]

    # --- per-frame images ---
    def depth(self, idx: int) -> np.ndarray:
        if self._depth_zip is None:
            self._depth_zip = zipfile.ZipFile(self.dir / "depth" / f"{self.name}.zip")
        return _decode_exr(self._depth_zip.read(f"{idx:05d}.exr"))

    @property
    def has_masks(self) -> bool:
        return (self.dir / "mask" / f"{self.name}.zip").exists()

    def mask(self, idx: int) -> np.ndarray | None:
        if not self.has_masks:
            return None
        if self._mask_zip is None:
            self._mask_zip = zipfile.ZipFile(self.dir / "mask" / f"{self.name}.zip")
        try:
            buf = self._mask_zip.read(f"{idx:05d}.png")
        except KeyError:
            return None
        return cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_UNCHANGED)

    @cached_property
    def phrases(self) -> dict[int, str]:
        p = self.dir / "mask" / f"{self.name}.txt"
        out: dict[int, str] = {0: "background"}
        if p.exists():
            for line in p.read_text().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    out[int(k.strip())] = v.strip().lower()
        return out

    def ids_with(self, phrases: set[str]) -> list[int]:
        return [i for i, p in self.phrases.items() if p in phrases]


class Frames:
    """Sequential RGB reader for input/clip.mp4 (frame i = i-th decoded frame, same numbering as ViPE)."""

    def __init__(self, mp4: Path):
        self.cap = cv2.VideoCapture(str(mp4))
        self.pos = 0

    def get(self, idx: int) -> np.ndarray:
        """RGB uint8 (H,W,3). Reading forward is fast; going backwards re-seeks."""
        if idx < self.pos:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            self.pos = idx
        while self.pos < idx:
            self.cap.grab()
            self.pos += 1
        ok, bgr = self.cap.read()
        self.pos += 1
        if not ok:
            raise IndexError(f"frame {idx} not readable")
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


# --- geometry ---------------------------------------------------------------------------------------
def backproject(depth: np.ndarray, K: np.ndarray, sel: np.ndarray | None = None, stride: int = 1):
    """Pixels -> camera-frame points (OpenCV axes). Returns (pts (M,3), v (M,), u (M,))."""
    h, w = depth.shape
    v, u = np.mgrid[0:h:stride, 0:w:stride]
    z = depth[::stride, ::stride]
    keep = np.isfinite(z) & (z > 0)
    if sel is not None:
        keep &= sel[::stride, ::stride]
    u, v, z = u[keep], v[keep], z[keep]
    x = (u - K[0, 2]) / K[0, 0] * z
    y = (v - K[1, 2]) / K[1, 1] * z
    return np.stack([x, y, z], axis=1), v, u


def depth_edges(depth: np.ndarray, rel: float = 0.04, absolute: float = 0.10) -> np.ndarray:
    """True where depth jumps to a 4-neighbour by more than max(absolute, rel * depth): flying pixels."""
    d = depth
    jump = np.zeros_like(d, dtype=np.float32)
    jump[:, 1:] = np.maximum(jump[:, 1:], np.abs(d[:, 1:] - d[:, :-1]))
    jump[:, :-1] = np.maximum(jump[:, :-1], np.abs(d[:, 1:] - d[:, :-1]))
    jump[1:, :] = np.maximum(jump[1:, :], np.abs(d[1:, :] - d[:-1, :]))
    jump[:-1, :] = np.maximum(jump[:-1, :], np.abs(d[1:, :] - d[:-1, :]))
    edge = jump > np.maximum(absolute, rel * d)
    return cv2.dilate(edge.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0


def erode(mask: np.ndarray, px: int) -> np.ndarray:
    if px <= 0:
        return mask
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * px + 1, 2 * px + 1))
    return cv2.erode(mask.astype(np.uint8), k) > 0


def dilate(mask: np.ndarray, px: int) -> np.ndarray:
    if px <= 0:
        return mask
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * px + 1, 2 * px + 1))
    return cv2.dilate(mask.astype(np.uint8), k) > 0


def transform(T: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return pts @ T[:3, :3].T + T[:3, 3]
