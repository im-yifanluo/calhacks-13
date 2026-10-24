// The contract between the reconstruction pipeline (Python) and the viewer (web).
// The pipeline writes one `memory.json` per memory; the viewer only reads this file
// plus the asset URLs inside it. Keep pipeline/memreplay/manifest.py in sync.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

/** One pose sample on an object's or camera's track. `t` is seconds from clip start. */
export interface Keyframe {
  t: number;
  p: Vec3;
  q: Quat;
  /** uniform scale, default 1 */
  s?: number;
}

export type SplatFormat = "spz" | "ply" | "splat" | "ksplat" | "sog";

export interface MemoryManifest {
  version: 1;
  id: string;
  title: string;
  createdAt: string; // ISO time
  source: {
    device: string; // e.g. "ray-ban-meta-gen2"
    videoUrl?: string; // original clip (optional, for the "watch original" panel)
    durationSec: number;
    fps: number;
    width: number;
    height: number;
  };
  /** World frame: +Y up, meters. Pipeline is responsible for gravity-aligning and scaling. */
  world: {
    up: "+y";
    units: "meters";
    /** floor height in world coords, used for the physics ground plane */
    floorY: number;
  };
  timeline: {
    durationSec: number;
    /** rate the tracks were sampled at (viewer interpolates between samples) */
    sampleHz: number;
  };
  /** Static scene with dynamic objects removed (inpainted or just masked out). */
  background: {
    kind: "splat";
    url: string;
    format: SplatFormat;
    splatCount: number;
    /** optional coarse collision mesh for the room (walls, tables) */
    colliderUrl?: string; // .glb
  };
  /** The wearer's head path, for "see it from my eyes" mode. */
  camera: {
    track: Keyframe[] | { url: string };
    fovYDeg: number;
  };
  objects: DynamicObject[];
}

export interface DynamicObject {
  id: string; // stable id, used as a key in SpacetimeDB tables
  label: string; // from the segmentation text prompt, e.g. "dog", "ball"
  visual:
    | { kind: "mesh"; url: string } // .glb, preferred for physics objects
    | { kind: "splat"; url: string; format: SplatFormat }
    | { kind: "splat-sequence"; urlPattern: string; frameCount: number; format: SplatFormat }; // per-frame splats (people, deforming things)
  collider:
    | { kind: "box"; halfExtents: Vec3 }
    | { kind: "sphere"; radius: number }
    | { kind: "capsule"; halfHeight: number; radius: number }
    | { kind: "convex"; url: string }; // .glb simplified hull
  /** kg, rough guess from label/size. Used once time is paused. */
  mass: number;
  /** false for people and huge things: they replay but can't be grabbed */
  grabbable: boolean;
  /** seconds the object is in the scene */
  visibleFrom: number;
  visibleTo: number;
  track: Keyframe[] | { url: string };
}
