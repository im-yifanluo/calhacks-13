import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SplatMesh, type SplatFileType } from "@sparkjsdev/spark";
import {
  type DynamicObject,
  type Keyframe,
  type MemoryManifest,
  validateManifest,
  validateTrack,
} from "@memreplay/shared";

export interface GeometryData {
  vertices: Float32Array;
  indices: Uint32Array;
}
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

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status} loading ${url}`);
  return response.json();
}

async function binary(url: string): Promise<ArrayBuffer> {
  // A ghost file is up to tens of megabytes (15k points per frame at 10 Hz); allow for venue Wi-Fi.
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${response.status} loading ${url}`);
  return response.arrayBuffer();
}

type PointsVisual = Extract<DynamicObject["visual"], { kind: "points-sequence" }>;
export interface PointsFrame {
  count: number;
  positions: Uint16Array;
  colors: Uint8Array;
}
export interface PointsSequenceData {
  version: number;
  sampleHz: number;
  frames: PointsFrame[];
  maxCount: number;
}

/**
 * Parse an MRPS points-sequence (people ghosts). The layout is owned by pipeline/memreplay/handoff.py
 * (POINTS_SEQUENCE_LAYOUT): little-endian; "MRPS", u32 version (1), u32 frameCount, f32 sampleHz,
 * u32 counts[frameCount]; then for each frame float16 xyz[count·3] (world meters) and uint8 rgb[count·3], the frame's
 * block zero-padded to a multiple of 4 bytes. The frames are views into `buffer`, not copies.
 */
export function parsePointsSequence(buffer: ArrayBuffer): PointsSequenceData {
  const fail = (why: string): never => {
    throw new Error(`points-sequence: ${why}`);
  };
  if (buffer.byteLength < 16) fail("file too short for the header");
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== "MRPS") fail("missing MRPS magic");
  const version = view.getUint32(4, true),
    frameCount = view.getUint32(8, true),
    sampleHz = view.getFloat32(12, true);
  if (version !== 1) fail(`unsupported version ${version}`);
  if (frameCount < 1 || !positive(sampleHz)) fail("needs at least one frame and a positive sampleHz");
  let offset = 16 + 4 * frameCount;
  if (offset > buffer.byteLength) fail("truncated frame counts");
  const frames: PointsFrame[] = [];
  let maxCount = 0;
  for (let k = 0; k < frameCount; k++) {
    const count = view.getUint32(16 + 4 * k, true),
      bytes = count * 9,
      padded = bytes + (-bytes & 3);
    if (offset + padded > buffer.byteLength) fail(`frame ${k} is truncated`);
    frames.push({
      count,
      positions: new Uint16Array(buffer, offset, count * 3),
      colors: new Uint8Array(buffer, offset + count * 6, count * 3),
    });
    offset += padded;
    maxCount = Math.max(maxCount, count);
  }
  if (offset !== buffer.byteLength) fail(`${buffer.byteLength - offset} unexpected trailing bytes`);
  return { version, sampleHz, frames, maxCount };
}

/** sRGB video colours (0–255) to the linear values three.js expects in vertex colours. */
const srgbToLinear = Float32Array.from(
  { length: 256 },
  (_, i) => new THREE.Color().setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r,
);

/** The ghost frame shown at time t: frame k covers [k / sampleHz, (k + 1) / sampleHz) from the clip start, clamped. */
export function pointsFrameAt(time: number, sampleHz: number, frameCount: number): number {
  return Math.max(0, Math.min(frameCount - 1, Math.floor(time * sampleHz + 1e-6)));
}

/**
 * A ghost as one THREE.Points sized for its largest frame. Showing another frame rewrites only that frame's part of
 * the attributes, so GPU memory stays at one frame however long the clip is. Positions are float16 (as in the file),
 * colours linear float. Points are in world coordinates (the object's track is identity). The file's header is
 * authoritative; a manifest that disagrees about frameCount or sampleHz gets a warning.
 */
export function createPointsSequence(
  visual: PointsVisual,
  buffer: ArrayBuffer,
  warn: (message: string) => void = () => {},
) {
  const data = parsePointsSequence(buffer);
  if (data.frames.length !== visual.frameCount)
    warn(
      `points-sequence: the file has ${data.frames.length} frames, the manifest says ${visual.frameCount}; using the file`,
    );
  if (Math.abs(data.sampleHz - visual.sampleHz) > 1e-4 * visual.sampleHz)
    warn(`points-sequence: the file is ${data.sampleHz} Hz, the manifest says ${visual.sampleHz} Hz; using the file`);
  const size = Math.max(1, data.maxCount) * 3;
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.Float16BufferAttribute(size, 3).setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.BufferAttribute(new Float32Array(size), 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", position);
  geometry.setAttribute("color", color);
  geometry.setDrawRange(0, 0);
  // dot size follows the point budget: a person drawn with 1,500 points needs ~4 cm dots to read as a body, one with
  // 12,000 points is fine at 1.5 cm (the pipeline spreads a fixed byte budget over all the people in a clip)
  const dot = Math.min(0.045, Math.max(0.015, 0.015 * Math.sqrt(12000 / Math.max(500, data.maxCount))));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ size: dot, vertexColors: true, sizeAttenuation: true }),
  );
  points.name = "points-sequence";
  points.frustumCulled = false; // the bounds change every frame
  let current = -1;
  const update = (time: number) => {
    const index = pointsFrameAt(time, data.sampleHz, data.frames.length);
    if (index === current) return;
    current = index;
    const frame = data.frames[index],
      n = frame.count * 3,
      colors = color.array as Float32Array;
    geometry.setDrawRange(0, frame.count);
    if (!n) return; // an empty frame (the person is out of view) draws nothing and uploads nothing
    (position.array as Uint16Array).set(frame.positions);
    for (let i = 0; i < n; i++) colors[i] = srgbToLinear[frame.colors[i]];
    for (const attribute of [position, color]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, n);
      attribute.needsUpdate = true;
    }
  };
  return { points, update, frameIndex: () => current, data };
}

const isIdentity = (track: Keyframe[]) =>
  track.every(
    (f) =>
      f.p.every((x) => Math.abs(x) < 1e-6) &&
      Math.abs(Math.abs(f.q[3]) - Math.hypot(...f.q)) < 1e-6 &&
      Math.abs((f.s ?? 1) - 1) < 1e-6,
  );

async function track(
  value: Keyframe[] | { url: string },
  resolveAsset: (url: string) => string,
  label: string,
): Promise<Keyframe[]> {
  const data = Array.isArray(value) ? value : await json(resolveAsset(value.url));
  validateTrack(data, label);
  return data;
}

export function meshGeometry(root: THREE.Object3D): GeometryData[] {
  const result: GeometryData[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
    const position = geometry.getAttribute("position");
    if (!position) {
      geometry.dispose();
      return;
    }
    const vertices = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++)
      vertices.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
    const indices = geometry.index
      ? Uint32Array.from(geometry.index.array)
      : Uint32Array.from({ length: position.count }, (_, i) => i);
    result.push({ vertices, indices });
    geometry.dispose();
  });
  return result;
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof SplatMesh) node.dispose();
    else if (node instanceof THREE.Mesh || node instanceof THREE.Points || node instanceof THREE.Line) {
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

async function splat(url: string, format?: string): Promise<SplatMesh> {
  const mesh = new SplatMesh({
    url,
    fileType: format && format !== "sog" ? (format as SplatFileType) : undefined,
    raycastable: false,
  });
  try {
    await mesh.initialized;
    return mesh;
  } catch (error) {
    mesh.dispose();
    throw error;
  }
}

/** Only three sequence frames are retained, with one request in flight. No unbounded GPU cache. */
function sequence(
  root: THREE.Group,
  visual: Extract<DynamicObject["visual"], { kind: "splat-sequence" }>,
  resolveAsset: (url: string) => string,
  start: number,
  hz: number,
  warn: (message: string) => void,
) {
  const cache = new Map<number, SplatMesh>();
  const failed = new Set<number>();
  let pending = false,
    disposed = false,
    desired = 0;
  const update = (time: number) => {
    desired = Math.max(0, Math.min(visual.frameCount - 1, Math.floor((time - start) * hz)));
    for (const [index, mesh] of cache) mesh.visible = index === desired;
    if (cache.has(desired) || pending || failed.has(desired) || disposed) return;
    const index = desired;
    pending = true;
    void splat(resolveAsset(visual.urlPattern.replace("{frame}", String(index))), visual.format)
      .then((mesh) => {
        if (disposed) {
          mesh.dispose();
          return;
        }
        root.add(mesh);
        cache.set(index, mesh);
        mesh.visible = index === desired;
        while (cache.size > 3) {
          const oldest = cache.keys().next().value!;
          const old = cache.get(oldest)!;
          root.remove(old);
          old.dispose();
          cache.delete(oldest);
        }
      })
      .catch((error) => {
        failed.add(index);
        warn(`Sequence frame ${index}: ${String(error)}`);
      })
      .finally(() => {
        pending = false;
      });
  };
  return {
    update,
    dispose: () => {
      disposed = true;
    },
  };
}

export interface MemorySource {
  manifest: MemoryManifest;
  resolveAsset: (path: string) => string;
}

export async function loadMemory(
  url: string,
  demo = false,
  onWarning: (message: string) => void = () => {},
  source?: MemorySource,
): Promise<LoadedMemory> {
  const base = new URL(url, location.href).href;
  const manifest = source?.manifest ?? ((await json(base)) as MemoryManifest);
  const resolveAsset = source?.resolveAsset ?? ((path: string) => new URL(path, base).href);
  validateManifest(manifest);
  if (!demo && manifest.background.splatCount > 1_000_000)
    throw new Error("Background exceeds the 1,000,000-splat safety limit. Reduce it in the pipeline.");
  const root = new THREE.Group();
  const warnings: string[] = [];
  const cleanups: (() => void)[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    onWarning(message);
  };
  try {
    const cameraTrack = await track(manifest.camera.track, resolveAsset, "camera");
    if (demo) {
      const bg = new SplatMesh({
        constructSplats: (packed) => {
          const scale = new THREE.Vector3(0.045, 0.045, 0.045),
            rotation = new THREE.Quaternion();
          for (let x = -30; x <= 30; x++)
            for (let z = -20; z <= 20; z++) {
              if ((x + z) % 3 !== 0) continue;
              packed.pushSplat(
                new THREE.Vector3(x * 0.12, manifest.world.floorY - 0.01, z * 0.12),
                scale,
                rotation,
                0.65,
                new THREE.Color().setHSL(0.52 + x / 500, 0.55, 0.22),
              );
            }
        },
      });
      await bg.initialized;
      root.add(bg);
    } else {
      root.add(await splat(resolveAsset(manifest.background.url), manifest.background.format));
    }
    const roomGeometry: GeometryData[] = [];
    if (manifest.background.colliderUrl) {
      const room = (await gltf.loadAsync(resolveAsset(manifest.background.colliderUrl))).scene;
      roomGeometry.push(...meshGeometry(room));
      disposeObject(room);
    }
    const objects: LoadedObject[] = [];
    for (const definition of manifest.objects) {
      // Omit plain placeholder shapes entirely: no visual, pick target, or physics body.
      // Keep these interactive shapes only in the built-in practice demo.
      if (!demo && definition.visual.kind === "primitive") continue;
      const group = new THREE.Group();
      group.name = definition.id;
      root.add(group);
      const loaded: LoadedObject = {
        definition,
        root: group,
        track: await track(definition.track, resolveAsset, definition.id),
      };
      if (definition.collider.kind === "convex") {
        const hull = (await gltf.loadAsync(resolveAsset(definition.collider.url))).scene;
        const parts = meshGeometry(hull);
        loaded.hull = new Float32Array(parts.reduce((n, part) => n + part.vertices.length, 0));
        let offset = 0;
        for (const part of parts) {
          loaded.hull.set(part.vertices, offset);
          offset += part.vertices.length;
        }
        disposeObject(hull);
      }
      if (demo) {
        const color = definition.id === "ball-1" ? 0xffb975 : 0x7edbd1;
        group.add(
          new THREE.Mesh(
            proxyGeometry(definition.collider),
            new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.15 }),
          ),
        );
      } else if (definition.visual.kind === "splat-sequence") {
        const player = sequence(
          group,
          definition.visual,
          resolveAsset,
          definition.visibleFrom,
          manifest.timeline.sampleHz,
          warn,
        );
        loaded.updateVisual = player.update;
        cleanups.push(player.dispose);
      } else if (definition.visual.kind === "splat") {
        group.add(await splat(resolveAsset(definition.visual.url), definition.visual.format));
      } else if (definition.visual.kind === "points-sequence") {
        // A ghost that fails to load is a warning, like a missing sequence frame: the memory stays usable without it.
        try {
          const ghost = createPointsSequence(
            definition.visual,
            await binary(resolveAsset(definition.visual.url)),
            (message) => warn(`${definition.id}: ${message}`),
          );
          group.add(ghost.points);
          loaded.updateVisual = ghost.update;
          if (!isIdentity(loaded.track))
            warn(
              `${definition.id}: a points-sequence track should be identity (its points are already in world coordinates)`,
            );
        } catch (error) {
          warn(`${definition.id}: ghost not shown: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (definition.visual.kind === "mesh") {
        group.add((await gltf.loadAsync(resolveAsset(definition.visual.url))).scene);
      }
      objects.push(loaded);
    }
    let count = 0;
    root.traverse((node) => {
      if (node instanceof SplatMesh) count += node.splats?.getNumSplats() ?? 0;
    });
    if (count > 1_000_000)
      throw new Error("Scene exceeds the 1,000,000-splat safety limit. Reduce it in the pipeline.");
    if (count > 500_000)
      warn(`${count.toLocaleString()} splats exceeds the 500,000 Quest target. Reduce assets before the device demo.`);
    return {
      manifest,
      root,
      objects,
      cameraTrack,
      roomGeometry,
      warnings,
      dispose: () => {
        cleanups.forEach((fn) => fn());
        disposeObject(root);
        root.removeFromParent();
      },
    };
  } catch (error) {
    cleanups.forEach((fn) => fn());
    disposeObject(root);
    throw error;
  }
}
