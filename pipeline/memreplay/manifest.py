"""Python mirror of packages/shared/src/manifest.ts. Keep both in sync."""
from __future__ import annotations

from typing import Literal, Union
from pydantic import BaseModel

Vec3 = tuple[float, float, float]
Quat = tuple[float, float, float, float]  # x, y, z, w
SplatFormat = Literal["spz", "ply", "splat", "ksplat", "sog"]


class Keyframe(BaseModel):
    t: float
    p: Vec3
    q: Quat
    s: float | None = None


class UrlRef(BaseModel):
    url: str


class Source(BaseModel):
    device: str
    videoUrl: str | None = None
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


class Background(BaseModel):
    kind: Literal["splat"] = "splat"
    url: str
    format: SplatFormat
    splatCount: int
    colliderUrl: str | None = None


class Camera(BaseModel):
    track: Union[list[Keyframe], UrlRef]
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


class ConvexCollider(BaseModel):
    kind: Literal["convex"] = "convex"
    url: str


class DynamicObject(BaseModel):
    id: str
    label: str
    visual: Union[MeshVisual, SplatVisual, SplatSequenceVisual]
    collider: Union[BoxCollider, SphereCollider, CapsuleCollider, ConvexCollider]
    mass: float
    grabbable: bool = True
    visibleFrom: float
    visibleTo: float
    track: Union[list[Keyframe], UrlRef]


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
