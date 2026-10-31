"""Python mirror of packages/shared/src/manifest.ts. Keep both in sync."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Vec3 = tuple[float, float, float]
Quat = tuple[float, float, float, float]  # x, y, z, w
SplatFormat = Literal["spz", "ply", "splat", "ksplat", "sog"]


class Keyframe(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)  # the viewer rejects NaN poses
    t: float
    p: Vec3
    q: Quat
    s: float | None = None
    v: Vec3 | None = None  # linear velocity m/s (objects), handed to physics on pause
    e: list[float] | None = (
        None  # camera keyframes: exposure [gr, gg, gb, br, bg, bb] (sRGB gain and bias) that maps the room splat's colours onto this frame
    )


class UrlRef(BaseModel):
    url: str


class Source(BaseModel):
    device: str
    videoUrl: str | None = None
    audioUrl: str | None = None  # clip audio (.m4a), played in sync with the timeline
    durationSec: float
    fps: float
    width: int
    height: int


class World(BaseModel):
    up: Literal["+y"] = "+y"
    units: Literal["meters"] = "meters"
    floorY: float = 0.0


class Timeline(BaseModel):
    durationSec: float
    sampleHz: float
    gaps: list[tuple[float, float]] | None = None  # [from, to] s where camera tracking was lost (viewer fades out)


class Background(BaseModel):
    kind: Literal["splat"] = "splat"
    url: str
    format: SplatFormat
    splatCount: int
    colliderUrl: str | None = None


class Camera(BaseModel):
    track: list[Keyframe] | UrlRef
    fovYDeg: float


class MeshVisual(BaseModel):
    kind: Literal["mesh"] = "mesh"
    url: str


class SplatVisual(BaseModel):
    kind: Literal["splat"] = "splat"
    url: str
    format: SplatFormat


class SplatSequenceVisual(BaseModel):
    kind: Literal["splat-sequence"] = "splat-sequence"
    urlPattern: str
    frameCount: int
    format: SplatFormat


class PrimitiveVisual(BaseModel):
    kind: Literal["primitive"] = "primitive"
    shape: Literal["sphere", "box", "cylinder"]
    size: Vec3  # full extents in meters; cylinder axis is +Y
    color: str  # "#rrggbb"


class PointsSequenceVisual(BaseModel):
    kind: Literal["points-sequence"] = "points-sequence"
    url: (
        str  # binary layout in handoff.py (POINTS_SEQUENCE_LAYOUT); points in world coords, frame k at t = k / sampleHz
    )
    frameCount: int
    sampleHz: float


class BoxCollider(BaseModel):
    kind: Literal["box"] = "box"
    halfExtents: Vec3


class SphereCollider(BaseModel):
    kind: Literal["sphere"] = "sphere"
    radius: float


class CapsuleCollider(BaseModel):
    kind: Literal["capsule"] = "capsule"
    halfHeight: float
    radius: float


class CylinderCollider(BaseModel):
    kind: Literal["cylinder"] = "cylinder"
    halfHeight: float
    radius: float


class ConvexCollider(BaseModel):
    kind: Literal["convex"] = "convex"
    url: str


class DynamicObject(BaseModel):
    id: str
    label: str
    visual: MeshVisual | SplatVisual | SplatSequenceVisual | PrimitiveVisual | PointsSequenceVisual = Field(
        discriminator="kind"
    )
    collider: BoxCollider | SphereCollider | CapsuleCollider | CylinderCollider | ConvexCollider = Field(
        discriminator="kind"
    )
    mass: float
    grabbable: bool = True
    visibleFrom: float
    visibleTo: float
    track: list[Keyframe] | UrlRef


class MemoryManifest(BaseModel):
    version: Literal[1] = 1
    id: str
    title: str
    createdAt: str
    source: Source
    world: World
    timeline: Timeline
    background: Background
    camera: Camera
    objects: list[DynamicObject]
