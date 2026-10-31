import type { Keyframe, MemoryManifest } from "./manifest";

// Runtime checks of the scene format, shared by the viewer, the library's scene import and the test suites. They
// throw an Error naming the first problem. The pipeline's pydantic models (pipeline/memreplay/manifest.py) check
// the same rules when they write memory.json.

const positive = (v: number) => Number.isFinite(v) && v > 0;

export function validateManifest(m: MemoryManifest): void {
  if (
    !m ||
    m.version !== 1 ||
    typeof m.id !== "string" ||
    typeof m.title !== "string" ||
    m.world?.up !== "+y" ||
    m.world.units !== "meters" ||
    !Number.isFinite(m.world.floorY) ||
    !positive(m.timeline?.durationSec) ||
    !positive(m.timeline?.sampleHz) ||
    !m.camera ||
    !positive(m.camera.fovYDeg) ||
    m.camera.fovYDeg >= 180 ||
    !m.background ||
    typeof m.background.url !== "string" ||
    !Array.isArray(m.objects)
  ) {
    throw new Error("Invalid memory.json: expected version 1, +Y up, meters, and a valid timeline/camera/background");
  }
  const ids = new Set<string>();
  for (const o of m.objects) {
    if (
      !o ||
      typeof o.id !== "string" ||
      ids.has(o.id) ||
      !o.collider ||
      !o.visual ||
      !Number.isFinite(o.mass) ||
      o.mass < 0 ||
      (o.grabbable && o.mass === 0) ||
      !Number.isFinite(o.visibleFrom) ||
      !Number.isFinite(o.visibleTo) ||
      o.visibleFrom < 0 ||
      o.visibleTo < o.visibleFrom ||
      o.visibleTo > m.timeline.durationSec
    ) {
      throw new Error(`Invalid or duplicate object: ${o?.id}`);
    }
    ids.add(o.id);
    const c = o.collider;
    if (
      (c.kind === "box" && (!tuple(c.halfExtents, 3) || !c.halfExtents.every(positive))) ||
      (c.kind === "sphere" && !positive(c.radius)) ||
      (c.kind === "capsule" && (!positive(c.radius) || !Number.isFinite(c.halfHeight) || c.halfHeight < 0)) ||
      (c.kind === "cylinder" && (!positive(c.radius) || !positive(c.halfHeight))) ||
      (c.kind === "convex" && typeof c.url !== "string") ||
      !["box", "sphere", "capsule", "cylinder", "convex"].includes(c.kind)
    )
      throw new Error(`Invalid collider: ${o.id}`);
    const v = o.visual;
    if (v.kind === "splat-sequence") {
      if (!Number.isInteger(v.frameCount) || v.frameCount < 1 || !v.urlPattern.includes("{frame}")) {
        throw new Error(`${o.id}: sequence requires frameCount and a zero-based {frame} URL pattern`);
      }
    } else if (v.kind === "points-sequence") {
      if (typeof v.url !== "string" || !Number.isInteger(v.frameCount) || v.frameCount < 1 || !positive(v.sampleHz)) {
        throw new Error(`${o.id}: points-sequence requires url, frameCount and sampleHz`);
      }
    } else if (v.kind === "primitive") {
      if (
        !["sphere", "box", "cylinder"].includes(v.shape) ||
        !tuple(v.size, 3) ||
        !v.size.every(positive) ||
        typeof v.color !== "string"
      ) {
        throw new Error(`${o.id}: primitive requires shape, three positive sizes and a color`);
      }
    } else if (!["mesh", "splat"].includes(v.kind) || typeof v.url !== "string") {
      throw new Error(`Invalid visual: ${o.id}`);
    }
  }
}

export function validateTrack(value: unknown, label = "track"): asserts value is Keyframe[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label}: expected nonempty keyframes`);
  let previous = -Infinity;
  for (const frame of value) {
    if (
      !frame ||
      !Number.isFinite(frame.t) ||
      frame.t < 0 ||
      frame.t <= previous ||
      !tuple(frame.p, 3) ||
      !tuple(frame.q, 4) ||
      Math.hypot(...frame.q) < 1e-8 ||
      (frame.s !== undefined && (!Number.isFinite(frame.s) || frame.s <= 0))
    ) {
      throw new Error(`${label}: invalid pose or timestamps (must strictly increase)`);
    }
    // Optional velocity in m/s. Absent means "derive it from the track". Anything else malformed (null, two numbers,
    // NaN) is rejected, because it would reach Rapier's setLinvel. The pipeline omits unset fields (exclude_none).
    if (frame.v !== undefined && !tuple(frame.v, 3)) {
      throw new Error(`${label}: keyframe at t=${frame.t} has an invalid v (expected three finite numbers)`);
    }
    previous = frame.t;
  }
}

export function tuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}
