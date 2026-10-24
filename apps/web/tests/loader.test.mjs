// People ghosts (points-sequence, MRPS files) and primitive geometry.
import test from "node:test";
import assert from "node:assert/strict";
import { DataUtils, Group, Points, Vector3 } from "three";
import { createPointsSequence, disposeObject, parsePointsSequence, pointsFrameAt, primitiveGeometry, proxyGeometry } from "../.test-dist/loader.js";

const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

/** The MRPS layout as pipeline/memreplay/handoff.py write_points_sequence writes it. frames: [[x, y, z, r, g, b], ...][] */
function mrps(frames, sampleHz, { magic = "MRPS", version = 1, pad = true, extra = 0 } = {}) {
  const size = frames.reduce((n, points) => { const bytes = points.length * 9; return n + bytes + (pad ? -bytes & 3 : 0); }, 16 + 4 * frames.length) + extra;
  const buffer = new ArrayBuffer(size), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i);
  view.setUint32(4, version, true); view.setUint32(8, frames.length, true); view.setFloat32(12, sampleHz, true);
  frames.forEach((points, k) => view.setUint32(16 + 4 * k, points.length, true));
  let offset = 16 + 4 * frames.length;
  for (const points of frames) {
    points.forEach((point, i) => { for (let c = 0; c < 3; c++) view.setUint16(offset + (i * 3 + c) * 2, DataUtils.toHalfFloat(point[c]), true); });
    points.forEach((point, i) => { for (let c = 0; c < 3; c++) bytes[offset + points.length * 6 + i * 3 + c] = point[3 + c]; });
    offset += points.length * 9 + (pad ? -(points.length * 9) & 3 : 0);
  }
  return buffer;
}
const ghostFrames = [
  [[0.5, 1.25, -2, 255, 0, 0]],
  [[1, 2, 3, 0, 255, 0], [-1.5, 0.75, 0.25, 0, 0, 255]],
  [],
];
const visual = { kind: "points-sequence", url: "ghost.bin", frameCount: 3, sampleHz: 10 };

test("MRPS parsing reads the header, per-frame float16 positions and uint8 colours, and the 4-byte padding", () => {
  const data = parsePointsSequence(mrps(ghostFrames, 10));
  assert.equal(data.version, 1); close(data.sampleHz, 10); assert.equal(data.frames.length, 3); assert.equal(data.maxCount, 2);
  assert.deepEqual(data.frames.map(f => f.count), [1, 2, 0]);
  assert.deepEqual([...data.frames[0].positions].map(DataUtils.fromHalfFloat), [0.5, 1.25, -2]);
  assert.deepEqual([...data.frames[0].colors], [255, 0, 0]);
  assert.deepEqual([...data.frames[1].positions].map(DataUtils.fromHalfFloat), [1, 2, 3, -1.5, 0.75, 0.25]);
  assert.deepEqual([...data.frames[1].colors], [0, 255, 0, 0, 0, 255]);
  // Frame 1 starts after the 16-byte header, 3 counts (12 bytes) and frame 0's 9 bytes plus 3 padding: 40.
  assert.equal(data.frames[1].positions.byteOffset, 40);
});

test("MRPS parsing rejects bad magic, versions, truncation, missing padding and trailing bytes", () => {
  assert.throws(() => parsePointsSequence(new ArrayBuffer(8)), /too short/);
  assert.throws(() => parsePointsSequence(mrps(ghostFrames, 10, { magic: "MRPX" })), /magic/);
  assert.throws(() => parsePointsSequence(mrps(ghostFrames, 10, { version: 2 })), /version 2/);
  assert.throws(() => parsePointsSequence(mrps(ghostFrames, 0)), /sampleHz/);
  assert.throws(() => parsePointsSequence(mrps([], 10)), /at least one frame/);
  assert.throws(() => parsePointsSequence(mrps(ghostFrames, 10).slice(0, 30)), /truncated/);
  assert.throws(() => parsePointsSequence(mrps(ghostFrames, 10, { pad: false })), /truncated/);
  assert.throws(() => parsePointsSequence(mrps(ghostFrames, 10, { extra: 4 })), /trailing/);
  const huge = mrps(ghostFrames, 10); new DataView(huge).setUint32(16, 0xffffffff, true);
  assert.throws(() => parsePointsSequence(huge), /truncated/);
});

test("the file's header wins over a manifest that disagrees, with a warning", () => {
  const warnings = [];
  const ghost = createPointsSequence({ ...visual, frameCount: 4, sampleHz: 12 }, mrps(ghostFrames, 10), message => warnings.push(message));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /3 frames, the manifest says 4/); assert.match(warnings[1], /10 Hz, the manifest says 12 Hz/);
  ghost.update(0.15); assert.equal(ghost.frameIndex(), 1, "timed by the file's 10 Hz");
  createPointsSequence({ ...visual, sampleHz: 29.97 }, mrps(ghostFrames, 29.97), message => warnings.push(message));
  assert.equal(warnings.length, 2, "float32 rounding of the rate is not a mismatch");
});

test("frame k shows from t = k / sampleHz, clamped to the clip", () => {
  assert.deepEqual([-1, 0, 0.0999, 0.1, 0.3, 0.29999999, 99].map(t => pointsFrameAt(t, 10, 5)), [0, 0, 0, 1, 3, 3, 4]);
});

test("a ghost renders as THREE.Points that switch frames in place and dispose cleanly", () => {
  const ghost = createPointsSequence(visual, mrps(ghostFrames, 10));
  const { points } = ghost, geometry = points.geometry;
  assert.ok(points instanceof Points); assert.equal(points.frustumCulled, false);
  const position = geometry.getAttribute("position"), color = geometry.getAttribute("color");
  assert.equal(position.isFloat16BufferAttribute, true);
  assert.equal(position.count, 2, "sized for the largest frame");
  ghost.update(0.15);
  assert.equal(ghost.frameIndex(), 1); assert.equal(geometry.drawRange.count, 2);
  assert.deepEqual([position.getX(1), position.getY(1), position.getZ(1)], [-1.5, 0.75, 0.25]);
  close(color.getY(0), 1); close(color.getZ(1), 1); close(color.getX(0), 0);
  assert.deepEqual(position.updateRanges, [{ start: 0, count: 6 }]);
  ghost.update(0.05);
  assert.equal(geometry.drawRange.count, 1); assert.deepEqual([position.getX(0), position.getY(0), position.getZ(0)], [0.5, 1.25, -2]);
  close(color.getX(0), 1);
  const version = position.version;
  ghost.update(5); assert.equal(ghost.frameIndex(), 2); assert.equal(geometry.drawRange.count, 0, "an empty frame draws nothing");
  assert.equal(position.version, version, "and uploads nothing");
  ghost.update(5); assert.equal(position.version, version, "no upload when the frame is unchanged");
  // sRGB video colours become linear vertex colours.
  const grey = createPointsSequence({ ...visual, frameCount: 1 }, mrps([[[0, 0, 0, 128, 128, 128]]], 10));
  grey.update(0); close(grey.points.geometry.getAttribute("color").getX(0), 0.2158605, 1e-4);
  const root = new Group(); root.add(points);
  let disposed = 0; geometry.addEventListener("dispose", () => disposed++); points.material.addEventListener("dispose", () => disposed++);
  disposeObject(root); assert.equal(disposed, 2);
});

test("primitive geometry uses full extents: sphere diameter, box sides, cylinder height along +Y", () => {
  const size = geometry => { geometry.computeBoundingBox(); return geometry.boundingBox.getSize(new Vector3()).toArray().map(x => +x.toFixed(4)); };
  assert.deepEqual(size(primitiveGeometry({ kind: "primitive", shape: "box", size: [0.2, 0.4, 0.6], color: "#fff" })), [0.2, 0.4, 0.6]);
  assert.deepEqual(size(primitiveGeometry({ kind: "primitive", shape: "sphere", size: [0.36, 0.36, 0.36], color: "#fff" })), [0.36, 0.36, 0.36]);
  assert.deepEqual(size(primitiveGeometry({ kind: "primitive", shape: "cylinder", size: [0.13, 0.24, 0.13], color: "#fff" })), [0.13, 0.24, 0.13]);
  // Uneven sizes: a sphere takes the largest extent, a cylinder the larger of x and z for its diameter.
  assert.deepEqual(size(primitiveGeometry({ kind: "primitive", shape: "sphere", size: [0.1, 0.3, 0.2], color: "#fff" })), [0.3, 0.3, 0.3]);
  assert.deepEqual(size(primitiveGeometry({ kind: "primitive", shape: "cylinder", size: [0.1, 0.5, 0.2], color: "#fff" })), [0.2, 0.5, 0.2]);
  // Collider proxies agree with the colliders: the mock can's cylinder matches its primitive.
  assert.deepEqual(size(proxyGeometry({ kind: "cylinder", halfHeight: 0.12, radius: 0.065 })), [0.13, 0.24, 0.13]);
  assert.deepEqual(size(proxyGeometry({ kind: "capsule", halfHeight: 0.2, radius: 0.1 })), [0.2, 0.6, 0.2]);
});
