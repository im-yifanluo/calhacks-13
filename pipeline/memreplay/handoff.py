"""Frozen file formats between P1 (World) and P2 (Things). See docs/PLAN.md section 2.2.

Change a model here only when P1 and P2 both agree; both sides import from this file.
One clip per memory (no separate room sweep). One work dir per memory; upload it as-is,
because memory.json uses URLs relative to it:

  <work>/clip.mp4                   the original glasses video
  <work>/frames/full/<idx>.jpg      S0  P1  full resolution (SAM 3, SAM 3D, gsplat)
  <work>/frames/small/<idx>.jpg     S0  P1  long side ~640 px (ViPE)
  <work>/frames.json                S0  P1  FramesIndex: every stage keys frames on `idx`
  <work>/nouns.json                 S1  P2  Nouns: also ViPE's masking phrases
  <work>/masks/tracks.json          S2  P2  MaskTracks (COCO RLE per object per frame)
  <work>/masks/dyn/<idx>.png        S2  P2  union of all moving pixels, dilated 12 px (255 = moving)
  <work>/world/cameras.json         S3  P1  Cameras
  <work>/world/depth.npz            S3  P1  depth: float16 meters [N,H,W]; idx: int32 [N] (same order as cameras)
  <work>/world/world.json           S4  P1  WorldInfo
  <work>/world/bg.spz               S5  P1  background splat (L0: fused depth points; L1: gsplat)
  <work>/world/ghosts.json          S6  P1  ObjectsFragment: people as non-grabbable splat sequences
  <work>/world/ghosts/<id>/<n>.spz  S6  P1  per-frame ghost splats; ghosts.json urlPattern points here
  <work>/objects/<id>/gs.spz        S7  P2  object splat in its own metric frame
  <work>/objects/<id>/hull.glb      S7  P2  convex hull collider (<= 64 vertices)
  <work>/objects/objects.json       S8  P2  ObjectsFragment: visuals, colliders, mass, tracks
  <work>/memory.json                S9  merge
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .manifest import DynamicObject

Mat3 = list[float]  # row-major 3x3
Mat4 = list[float]  # row-major 4x4


# --- S0 · P1 -> everyone -------------------------------------------------------------------
class FrameEntry(BaseModel):
    idx: int  # stable index; never renumbered, even if `kept` changes
    t_us: int  # media time from the clip's own timestamps, microseconds
    file: str  # "frames/full/<idx>.jpg"; the small copy has the same name under frames/small/
    blur: float  # Laplacian variance; higher = sharper
    kept: bool  # False = not the sharpest in its 100 ms window; skip it everywhere


class FramesIndex(BaseModel):
    source: str  # "clip.mp4"
    target_fps: float = 10.0  # one kept frame per 1/target_fps seconds
    width: int  # full-resolution frame size
    height: int
    small_long_side: int = 640
    frames: list[FrameEntry]


# --- S1 · P2 -> P1 (ViPE masking phrases) and P2 (SAM 3 prompts) ----------------------------
class Noun(BaseModel):
    noun: str  # SAM 3 / ViPE text prompt, e.g. "cardboard box"
    kind: Literal["object", "person", "hand"]
    size_min_m: float  # longest side, used to clamp SAM 3D scale
    size_max_m: float
    density_kg_m3: float  # mass = density x hull volume
    grabbable: bool


class Nouns(BaseModel):
    nouns: list[Noun]  # always includes "person" and "hand"


# --- S2 · P2 -> P1 (background + ghosts) ----------------------------------------------------
class Rle(BaseModel):
    size: tuple[int, int]  # [height, width], COCO convention
    counts: str  # pycocotools.mask.encode(...)["counts"].decode()


class MaskFrame(BaseModel):
    idx: int
    rle: Rle
    held: bool = False  # a hand covers it here; S8 interpolates instead of trusting this frame


class MaskTrack(BaseModel):
    id: str  # "<noun>:<n>", e.g. "cardboard box:0". Stitch re-entries so one object keeps one id.
    # Folder names and DynamicObject.id use object_slug(id), e.g. "cardboard-box-0".
    noun: str
    kind: Literal["object", "person", "ego-hand", "hand"]  # ego-hand = the wearer's own
    frames: list[MaskFrame]


class MaskTracks(BaseModel):
    width: int  # mask resolution (= full frames)
    height: int
    tracks: list[MaskTrack]


# --- S3/S4 · P1 -> P2 (lift masks and points into the world) --------------------------------
class CameraFrame(BaseModel):
    idx: int
    t_us: int
    w: int  # resolution K and depth refer to
    h: int
    model: Literal["pinhole", "mei"]  # mei = ViPE's unified wide-angle model
    K: Mat3 = Field(min_length=9, max_length=9)
    dist: list[float] = []  # mei: [alpha]; pinhole: []
    # Camera-to-world. Camera axes use the OpenCV convention (x right, y down, z forward).
    c2w: Mat4 = Field(min_length=16, max_length=16)


class Cameras(BaseModel):
    solve: Literal["v0", "final"]
    # True once S4 has been applied (+Y up, meters, floor at WorldInfo.floorY).
    # Before that P2 should keep working in camera coordinates.
    in_world_frame: bool
    frames: list[CameraFrame]


class WorldInfo(BaseModel):
    T_vipe_to_world: Mat4 = Field(min_length=16, max_length=16)  # already applied to cameras/depth
    scale: float  # metric correction already applied (eye height / median camera height)
    eye_height_m: float  # measured on the wearer
    floorY: float = 0.0
    up: tuple[float, float, float] = (0.0, 1.0, 0.0)
    boundsMin: tuple[float, float, float]
    boundsMax: tuple[float, float, float]
    bgSplatCount: int = 0  # filled in by S5


# --- S6/S8 -> merge -----------------------------------------------------------------------
def object_slug(mask_track_id: str) -> str:
    """MaskTrack.id -> path-safe id for objects/<id>/ and DynamicObject.id: "cardboard box:0" -> "cardboard-box-0"."""
    return "-".join("".join(c if c.isalnum() else " " for c in mask_track_id.lower()).split())


class ObjectsFragment(BaseModel):
    """The `objects` part of memory.json, produced separately by P2 (objects) and P1 (ghosts).
    All url fields are relative to <work>, e.g. "objects/cardboard-box-0/gs.spz"."""

    objects: list[DynamicObject]
