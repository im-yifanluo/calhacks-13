"""File formats between the steps of the one-person vision pipeline. See pipeline/README.md.

One glasses clip per memory, one work dir per memory. Upload or copy the work dir as-is,
because memory.json uses URLs relative to it.

  <work>/clip.mov                     S0  the original glasses video (always named clip.mov; ffmpeg reads any container)
  <work>/capture.json                S0  CaptureInfo: the wearer's measured eye height
  <work>/input/clip.mp4               S1  upright, constant 30 fps, long side 1280 px, no audio (ViPE input)
  <work>/input/audio.m4a              S1  the clip's audio, played in sync by the viewer
  <work>/input/frames.json            S1  FramesInfo
  <work>/nouns.json                   S1  Nouns: single-word ViPE prompts, typed by hand
  <work>/vipe/                        S2  ViPE's raw output: pose/, intrinsics/, depth/, mask/
                                          (frame index = frame number in input/clip.mp4)
  <work>/world/world.json             S3  WorldInfo
  <work>/world/cameras.json           S3  Cameras (keyframes, world frame)
  <work>/world/frames.npz             S3  every frame's final camera-to-world (incl. scale) + good flags (world.WorldPoses)
  <work>/world/bg_points.ply          S4  L0 background: static points written as small splats (Spark reads .ply)
  <work>/world/room_collider.glb      S4  floor + tables as a 10 cm heightfield mesh
  <work>/world/ghosts/<id>.bin        S4  people as per-frame points (POINTS_SEQUENCE_LAYOUT below)
  <work>/world/ghosts.json            S4  ObjectsFragment: the people
  <work>/objects/crops/<id>.jpg       S5  best crop of each object, sent to Claude
  <work>/objects/objects.json         S5  ObjectsFragment: grabbable objects
  <work>/colmap/, <work>/gsplat/      S6  background training inputs and checkpoints
  <work>/world/bg.spz                 S6  trained background splat; merge prefers it over bg_points.ply
  <work>/memory.json                  S7  merge

World frame everywhere after S3: meters, +Y up, floor at y = 0.
Camera matrices use OpenCV camera axes (x right, y down, z forward); merge converts for three.js.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .manifest import DynamicObject

Mat3 = list[float]  # row-major 3x3
Mat4 = list[float]  # row-major 4x4


# --- S0 -------------------------------------------------------------------------------------
class CaptureInfo(BaseModel):
    eye_height_m: float  # measured on the wearer; S3 compares ViPE's camera height against it


# --- S1 -------------------------------------------------------------------------------------
class FramesInfo(BaseModel):
    source: str  # original file name, e.g. "clip.mov"
    fps: float = 30.0  # input/clip.mp4 is constant frame rate
    width: int
    height: int
    frame_count: int
    key_stride: int = 3  # every 3rd frame is a keyframe -> 10 Hz tracks, ghosts and camera path
    duration_sec: float


class Nouns(BaseModel):
    """ViPE masking prompts. Use single words (multi-word handling in ViPE is unverified).
    ViPE replaces its default list, so always keep "person" and "hand"."""

    nouns: list[str] = ["person", "hand"]


# --- S3 -------------------------------------------------------------------------------------
class CameraFrame(BaseModel):
    idx: int  # frame number in input/clip.mp4
    t: float  # seconds
    w: int
    h: int
    K: Mat3 = Field(min_length=9, max_length=9)
    c2w: Mat4 = Field(min_length=16, max_length=16)  # camera-to-world, OpenCV camera axes, world frame
    good: bool = True  # False where ViPE's tracking glitched (position smoothed; S4-S6 skip the frame)


class Cameras(BaseModel):
    frames: list[CameraFrame]  # keyframes only (every key_stride-th frame)


class WorldInfo(BaseModel):
    T_vipe_to_world: Mat4 = Field(
        min_length=16, max_length=16
    )  # rotation + translation (+ scale) applied to ViPE output
    scale: float = 1.0  # 1.0 = trust ViPE's metric depth; set from eye height only if ViPE's scale looks wrong
    floorY: float = 0.0
    up: tuple[float, float, float] = (0.0, 1.0, 0.0)
    median_camera_height_m: float  # sanity check: should be close to the wearer's eye height
    eye_height_m: float | None = None  # measured on the wearer at capture time
    boundsMin: tuple[float, float, float]
    boundsMax: tuple[float, float, float]
    bgPointsCount: int = 0  # filled by S4 (bg_points.ply)
    bgSplatCount: int = 0  # filled by S6 (bg.spz)
    diagnostics: dict = {}  # S3 floor fit quality etc., for the verification report


# --- S5 -------------------------------------------------------------------------------------
class ObjectSpec(BaseModel):
    """What Claude returns for one object (label + crop -> simple shape for physics)."""

    label: str
    shape: Literal["sphere", "box", "cylinder"]
    size_m: tuple[float, float, float]  # full extents x, y, z; cylinder axis is +Y
    density_kg_m3: float
    color: str  # "#rrggbb", for the tinted primitive
    grabbable: bool
    movable: bool = True  # free-standing, resting on something (not mounted on a wall or ceiling, not built in)


# --- S4/S5 -> S7 --------------------------------------------------------------------------
class ObjectsFragment(BaseModel):
    """The `objects` part of memory.json, written by S4 (people) and S5 (grabbable objects).
    All url fields are relative to <work>, e.g. "world/ghosts/person-0.bin"."""

    objects: list[DynamicObject]


def object_slug(label: str, n: int) -> str:
    """Path-safe id for a merged object: ("cardboard box", 0) -> "cardboard-box-0"."""
    return "-".join("".join(c if c.isalnum() else " " for c in f"{label} {n}".lower()).split())


# --- points-sequence binary (people ghosts) --------------------------------------------------
POINTS_SEQUENCE_LAYOUT = """
Little-endian. Header: b"MRPS", u32 version (=1), u32 frameCount, f32 sampleHz,
then u32 count[frameCount]. Then one block per frame:
  positions: float16[count * 3]   (x, y, z in world meters)
  colors:    uint8[count * 3]     (r, g, b)
  padding:   zero bytes to the next multiple of 4
Every block starts 4-byte aligned, so the viewer can wrap positions in a Uint16Array
(three.js Float16BufferAttribute) and colors in a Uint8Array without copying.
"""


def write_points_sequence(path: Path, frames: list[tuple[object, object]], sample_hz: float) -> None:
    """frames: list of (xyz float array [N,3], rgb uint8 array [N,3]); N may differ per frame."""
    import numpy as np

    counts = [len(xyz) for xyz, _ in frames]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"MRPS" + struct.pack("<IIf", 1, len(frames), sample_hz))
        f.write(np.asarray(counts, dtype="<u4").tobytes())
        for xyz, rgb in frames:
            block = np.asarray(xyz, dtype="<f2").tobytes() + np.asarray(rgb, dtype=np.uint8).tobytes()
            f.write(block + b"\0" * (-len(block) % 4))


def read_points_sequence(path: Path) -> tuple[float, list[tuple[object, object]]]:
    import numpy as np

    data = Path(path).read_bytes()
    assert data[:4] == b"MRPS", "not a points-sequence file"
    _version, n, hz = struct.unpack_from("<IIf", data, 4)
    counts = np.frombuffer(data, dtype="<u4", count=n, offset=16)
    off, frames = 16 + 4 * n, []
    for c in counts:
        xyz = np.frombuffer(data, dtype="<f2", count=int(c) * 3, offset=off).reshape(-1, 3)
        rgb = np.frombuffer(data, dtype=np.uint8, count=int(c) * 3, offset=off + int(c) * 6).reshape(-1, 3)
        frames.append((xyz, rgb))
        off += int(c) * 9 + (-(int(c) * 9) % 4)
    return hz, frames
