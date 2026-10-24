import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SplatMesh } from "@sparkjsdev/spark";
import type { DynamicObject, Keyframe, MemoryManifest } from "@memreplay/shared";
import { tuple, validateTrack } from "./tracks.js";

export interface GeometryData { vertices: Float32Array; indices: Uint32Array }
export interface LoadedObject {
  definition: DynamicObject;
  root: THREE.Group;
  track: Keyframe[];
  hull?: Float32Array;
  updateVisual?: (time: number) => void;
}
export interface LoadedMemory {
  manifest: MemoryManifest;
  root: THREE.Group;
  objects: LoadedObject[];
  cameraTrack: Keyframe[];
  roomGeometry: GeometryData[];
  warnings: string[];
  dispose: () => void;
}

const gltf = new GLTFLoader();
const positive = (v: number) => Number.isFinite(v) && v > 0;

export function validateManifest(m: MemoryManifest): void {
  if (!m || m.version !== 1 || typeof m.id !== "string" || typeof m.title !== "string" ||
    m.world?.up !== "+y" || m.world.units !== "meters" || !Number.isFinite(m.world.floorY) ||
    !positive(m.timeline?.durationSec) || !positive(m.timeline?.sampleHz) ||
    !m.camera || !positive(m.camera.fovYDeg) || m.camera.fovYDeg >= 180 ||
    !m.background || typeof m.background.url !== "string" || !Array.isArray(m.objects)) {
    throw new Error("Invalid memory.json: expected version 1, +Y up, meters, and a valid timeline/camera/background");
  }
  const ids = new Set<string>();
  for (const o of m.objects) {
    if (!o || typeof o.id !== "string" || ids.has(o.id) || !o.collider || !o.visual ||
      !Number.isFinite(o.mass) || o.mass < 0 || (o.grabbable && o.mass === 0) ||
      !Number.isFinite(o.visibleFrom) || !Number.isFinite(o.visibleTo) ||
      o.visibleFrom < 0 || o.visibleTo < o.visibleFrom || o.visibleTo > m.timeline.durationSec) {
      throw new Error(`Invalid or duplicate object: ${o?.id}`);
    }
    ids.add(o.id);
    const c = o.collider;
    if ((c.kind === "box" && (!tuple(c.halfExtents, 3) || !c.halfExtents.every(positive))) ||
      (c.kind === "sphere" && !positive(c.radius)) ||
      (c.kind === "capsule" && (!positive(c.radius) || !Number.isFinite(c.halfHeight) || c.halfHeight < 0)) ||
      (c.kind === "cylinder" && (!positive(c.radius) || !positive(c.halfHeight))) ||
      (c.kind === "convex" && typeof c.url !== "string") ||
      !["box", "sphere", "capsule", "cylinder", "convex"].includes(c.kind)) throw new Error(`Invalid collider: ${o.id}`);
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
      if (!["sphere", "box", "cylinder"].includes(v.shape) || !tuple(v.size, 3) || !v.size.every(positive) || typeof v.color !== "string") {
        throw new Error(`${o.id}: primitive requires shape, three positive sizes and a color`);
      }
    } else if (!["mesh", "splat"].includes(v.kind) || typeof v.url !== "string") {
      throw new Error(`Invalid visual: ${o.id}`);
    }
  }
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status} loading ${url}`);
  return response.json();
}

async function track(value: Keyframe[] | { url: string }, base: string, label: string): Promise<Keyframe[]> {
  const data = Array.isArray(value) ? value : await json(new URL(value.url, base).href);
  validateTrack(data, label);
  return data;
}

export function meshGeometry(root: THREE.Object3D): GeometryData[] {
  const result: GeometryData[] = [];
  root.updateMatrixWorld(true);
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
    const position = geometry.getAttribute("position");
    if (!position) { geometry.dispose(); return; }
    const vertices = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) vertices.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
    const indices = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: position.count }, (_, i) => i);
    result.push({ vertices, indices });
    geometry.dispose();
  });
  return result;
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse(node => {
    if (node instanceof SplatMesh) node.dispose();
    else if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
    }
  });
}

export function proxyGeometry(c: DynamicObject["collider"]): THREE.BufferGeometry {
  if (c.kind === "sphere") return new THREE.SphereGeometry(c.radius, 24, 16);
  if (c.kind === "capsule") return new THREE.CapsuleGeometry(c.radius, c.halfHeight * 2, 6, 16);
  if (c.kind === "cylinder") return new THREE.CylinderGeometry(c.radius, c.radius, c.halfHeight * 2, 24);
  const h = c.kind === "box" ? c.halfExtents : [0.15, 0.15, 0.15];
  return new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2);
}

/** A simple tinted shape from the pipeline (`visual.kind === "primitive"`). size = full extents; cylinder axis is +Y. */
export function primitiveGeometry(v: Extract<DynamicObject["visual"], { kind: "primitive" }>): THREE.BufferGeometry {
  const [x, y, z] = v.size;
  if (v.shape === "sphere") return new THREE.SphereGeometry(Math.max(x, y, z) / 2, 24, 16);
  if (v.shape === "cylinder") return new THREE.CylinderGeometry(Math.max(x, z) / 2, Math.max(x, z) / 2, y, 24);
  return new THREE.BoxGeometry(x, y, z);
}

async function splat(url: string): Promise<SplatMesh> {
  const mesh = new SplatMesh({ url, raycastable: false });
  try { await mesh.initialized; return mesh; }
  catch (error) { mesh.dispose(); throw error; }
}

/** Only three sequence frames are retained, with one request in flight. No unbounded GPU cache. */
function sequence(root: THREE.Group, visual: Extract<DynamicObject["visual"], { kind: "splat-sequence" }>,
  base: string, start: number, hz: number, warn: (message: string) => void) {
  const cache = new Map<number, SplatMesh>();
  const failed = new Set<number>();
  let pending = false, disposed = false, desired = 0;
  const update = (time: number) => {
    desired = Math.max(0, Math.min(visual.frameCount - 1, Math.floor((time - start) * hz)));
    for (const [index, mesh] of cache) mesh.visible = index === desired;
    if (cache.has(desired) || pending || failed.has(desired) || disposed) return;
    const index = desired;
    pending = true;
    void splat(new URL(visual.urlPattern.replace("{frame}", String(index)), base).href).then(mesh => {
      if (disposed) { mesh.dispose(); return; }
      root.add(mesh); cache.set(index, mesh); mesh.visible = index === desired;
      while (cache.size > 3) {
        const oldest = cache.keys().next().value!;
        const old = cache.get(oldest)!;
        root.remove(old); old.dispose(); cache.delete(oldest);
      }
    }).catch(error => { failed.add(index); warn(`Sequence frame ${index}: ${String(error)}`); })
      .finally(() => { pending = false; });
  };
  return { update, dispose: () => { disposed = true; } };
}

export async function loadMemory(url: string, demo = false, onWarning: (message: string) => void = () => {}): Promise<LoadedMemory> {
  const base = new URL(url, location.href).href;
  const manifest = await json(base) as MemoryManifest;
  validateManifest(manifest);
  if (!demo && manifest.background.splatCount > 1_000_000) throw new Error("Background exceeds the 1,000,000-splat safety limit. Reduce it in the pipeline.");
  const root = new THREE.Group();
  const warnings: string[] = [];
  const cleanups: (() => void)[] = [];
  const warn = (message: string) => { warnings.push(message); onWarning(message); };
  try {
    const cameraTrack = await track(manifest.camera.track, base, "camera");
    if (demo) {
      const bg = new SplatMesh({ constructSplats: packed => {
        const scale = new THREE.Vector3(0.045, 0.045, 0.045), rotation = new THREE.Quaternion();
        for (let x = -30; x <= 30; x++) for (let z = -20; z <= 20; z++) {
          if ((x + z) % 3 !== 0) continue;
          packed.pushSplat(new THREE.Vector3(x * 0.12, manifest.world.floorY - 0.01, z * 0.12), scale, rotation, 0.65,
            new THREE.Color().setHSL(0.52 + x / 500, 0.55, 0.22));
        }
      } });
      await bg.initialized; root.add(bg);
    } else {
      root.add(await splat(new URL(manifest.background.url, base).href));
    }
    const roomGeometry: GeometryData[] = [];
    if (manifest.background.colliderUrl) {
      const room = (await gltf.loadAsync(new URL(manifest.background.colliderUrl, base).href)).scene;
      roomGeometry.push(...meshGeometry(room)); disposeObject(room);
    }
    const objects: LoadedObject[] = [];
    for (const definition of manifest.objects) {
      const group = new THREE.Group(); group.name = definition.id; root.add(group);
      const loaded: LoadedObject = { definition, root: group, track: await track(definition.track, base, definition.id) };
      if (definition.collider.kind === "convex") {
        const hull = (await gltf.loadAsync(new URL(definition.collider.url, base).href)).scene;
        const parts = meshGeometry(hull);
        loaded.hull = new Float32Array(parts.reduce((n, part) => n + part.vertices.length, 0));
        let offset = 0;
        for (const part of parts) { loaded.hull.set(part.vertices, offset); offset += part.vertices.length; }
        disposeObject(hull);
      }
      if (demo) {
        const color = definition.id === "ball-1" ? 0xffb975 : 0x7edbd1;
        group.add(new THREE.Mesh(proxyGeometry(definition.collider), new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.15 })));
      } else if (definition.visual.kind === "splat-sequence") {
        const player = sequence(group, definition.visual, base, definition.visibleFrom, manifest.timeline.sampleHz, warn);
        loaded.updateVisual = player.update; cleanups.push(player.dispose);
      } else if (definition.visual.kind === "splat") {
        group.add(await splat(new URL(definition.visual.url, base).href));
      } else if (definition.visual.kind === "primitive") {
        group.add(new THREE.Mesh(primitiveGeometry(definition.visual),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(definition.visual.color), roughness: 0.45, metalness: 0.05 })));
      } else if (definition.visual.kind === "points-sequence") {
        // TODO(P3): render the MRPS point frames (layout: pipeline/memreplay/handoff.py). Proxy until then.
        group.add(new THREE.Mesh(proxyGeometry(definition.collider),
          new THREE.MeshStandardMaterial({ color: 0x9bd7ff, transparent: true, opacity: 0.35 })));
        warn(`${definition.id}: points-sequence ghosts are not rendered yet; showing a placeholder`);
      } else {
        group.add((await gltf.loadAsync(new URL(definition.visual.url, base).href)).scene);
      }
      objects.push(loaded);
    }
    let count = 0;
    root.traverse(node => { if (node instanceof SplatMesh) count += node.splats?.getNumSplats() ?? 0; });
    if (count > 1_000_000) throw new Error("Scene exceeds the 1,000,000-splat safety limit. Reduce it in the pipeline.");
    if (count > 500_000) warn(`${count.toLocaleString()} splats exceeds the 500,000 Quest target. Reduce assets before the device demo.`);
    return { manifest, root, objects, cameraTrack, roomGeometry, warnings,
      dispose: () => { cleanups.forEach(fn => fn()); disposeObject(root); root.removeFromParent(); } };
  } catch (error) { cleanups.forEach(fn => fn()); disposeObject(root); throw error; }
}
