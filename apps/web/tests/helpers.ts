// Helpers shared by the web app's tests: keyframes, tolerant comparisons, the mock memory, a one-ball fixture, and
// the browser pieces the VR panel needs in Node.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Group, type Vector3 } from "three";
import type { DynamicObject, Keyframe, MemoryManifest } from "@memreplay/shared";
import type { LoadedMemory, LoadedObject } from "../src/loader";
import { STEP } from "../src/physics";
import type { Viewer } from "../src/viewer";

/** A keyframe at time t and position (x, y, z), unrotated; `extra` adds fields such as `v`. */
export const frame = (t: number, x: number, y = 1, z = 0, extra: Partial<Keyframe> = {}): Keyframe => ({
  t,
  p: [x, y, z],
  q: [0, 0, 0, 1],
  ...extra,
});

/** The times of a track's keyframes. */
export const times = (track: readonly Keyframe[]): number[] => track.map((f) => f.t);

/**
 * `close(a, b, tolerance?)` and `vec(vector, expected, tolerance?)` assertions that fail with "a != b". The test files
 * differ in the default tolerance and in whether a difference of exactly the tolerance passes (`inclusive`), so each
 * file makes its own pair.
 */
export function approx(defaultTolerance: number, { inclusive = false } = {}) {
  const close = (a: number, b: number, tolerance = defaultTolerance): void =>
    assert.ok(inclusive ? Math.abs(a - b) <= tolerance : Math.abs(a - b) < tolerance, `${a} != ${b}`);
  const vec = (vector: Vector3, expected: readonly number[], tolerance = defaultTolerance): void =>
    expected.forEach((x, i) => close(vector.toArray()[i], x, tolerance));
  return { close, vec };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** public/mock/memory.json, the memory the engine tests build on. */
export async function mockManifest(): Promise<MemoryManifest> {
  return JSON.parse(await readFile(new URL("../public/mock/memory.json", import.meta.url), "utf8"));
}

/** An object definition with its track inline, as in every test memory (its LoadedObject shares the array). */
export type Definition = Omit<DynamicObject, "track"> & { track: Keyframe[] };

/** The mock's first object as a 0.12 m sphere moving from x = 0 to 3 over 6 s, alone in a copy of the mock memory. */
export function fixture(manifest: MemoryManifest): { memory: LoadedMemory; object: LoadedObject } {
  const definition: Definition = {
    ...structuredClone(manifest.objects[0]),
    collider: { kind: "sphere", radius: 0.12 },
    track: [frame(0, 0), frame(6, 3)],
  };
  const object: LoadedObject = { definition, root: new Group(), track: definition.track };
  const root = new Group();
  root.add(object.root);
  const memory: LoadedMemory = {
    manifest: structuredClone(manifest),
    root,
    objects: [object],
    cameraTrack: [frame(0, 0)],
    roomGeometry: [],
    warnings: [],
    dispose() {},
  };
  return { memory, object };
}

/** Step the viewer until its throw preview has finished recording (at most 1200 physics steps). */
export async function settle(viewer: Viewer): Promise<void> {
  for (let i = 0; i < 1200 && viewer.recording; i++) viewer.update(STEP);
  assert.equal(viewer.recording, false);
}

/**
 * The id of the object the viewer holds. Read through a call, because after `assert.equal(viewer.held, null)`
 * TypeScript keeps `viewer.held` narrowed to null, though a grab has changed it since.
 */
export const heldId = (viewer: Viewer): string | undefined => viewer.held?.definition.id;

/**
 * Replace `document` with one whose canvases have a 2D context that draws nothing and measures text at 15 px a
 * character. The VR panel draws on canvases; the tests run in Node, without a DOM.
 */
export function stubCanvasDocument(): void {
  const context = new Proxy<Record<string | symbol, unknown>>(
    {
      measureText: (value: string) => ({ width: value.length * 15 }),
      createLinearGradient: () => ({ addColorStop() {} }),
    },
    { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true },
  );
  globalThis.document = {
    createElement: () => ({ getContext: () => context, width: 0, height: 0 }),
  } as unknown as Document;
}
