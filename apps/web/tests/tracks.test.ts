// Keyframe velocity `v`: validation and the velocity physics starts from on pause.
import { test } from "vitest";
import assert from "node:assert/strict";
import type { Keyframe, Vec3 } from "@memreplay/shared";
import { keyframeVelocity, trackVelocity, validateTrack } from "../src/engine/tracks";
import { approx } from "./helpers";

const frame = (t: number, x: number, v?: Vec3): Keyframe => ({ t, p: [x, 1, 0], q: [0, 0, 0, 1], ...(v ? { v } : {}) });
const { vec } = approx(1e-9);

test("validateTrack accepts an absent or finite 3-vector v and rejects anything else", () => {
  validateTrack([frame(0, 0), frame(1, 1, [1, 0, -2.5])]);
  for (const v of [
    [NaN, 0, 0],
    [Infinity, 0, 0],
    [1, 2],
    [1, 2, 3, 4],
    "fast",
    null,
    { x: 1, y: 0, z: 0 },
    [1, "2", 3],
  ]) {
    assert.throws(() => validateTrack([{ ...frame(0, 0), v }], "ball"), /invalid v/, `v=${JSON.stringify(v)}`);
  }
});

test("keyframeVelocity uses the active keyframe's v, interpolated towards the next keyframe's v", () => {
  const track = [frame(0, 0, [2, 0, 0]), frame(1, 5, [4, 0, 2]), frame(2, 6, [0, 0, 0])];
  vec(keyframeVelocity(track, 0), [2, 0, 0]);
  vec(keyframeVelocity(track, 0.25), [2.5, 0, 0.5]);
  vec(keyframeVelocity(track, 1), [4, 0, 2]);
  vec(keyframeVelocity(track, 1.5), [2, 0, 1]);
  vec(trackVelocity(track, 0.25), [5, 0, 0]); // the finite difference disagrees: v wins
});

test("keyframeVelocity holds the active keyframe's v when the next keyframe has none", () => {
  vec(keyframeVelocity([frame(0, 0, [3, 1, 0]), frame(1, 5)], 0.5), [3, 1, 0]);
});

test("keyframeVelocity falls back to the finite difference when the active keyframe has no v", () => {
  const track = [frame(0, 0), frame(1, 5, [9, 9, 9]), frame(2, 6)];
  vec(keyframeVelocity(track, 0.5), [5, 0, 0]);
  vec(keyframeVelocity(track, 1.5), [9, 9, 9]);
  vec(keyframeVelocity([frame(0, 0), frame(2, 4)], 1), [2, 0, 0]);
});

test("keyframeVelocity is zero outside the recorded interval, like trackVelocity", () => {
  const track = [frame(1, 0, [2, 0, 0]), frame(2, 1, [2, 0, 0])];
  for (const t of [0, 2, 3]) vec(keyframeVelocity(track, t), [0, 0, 0]);
  vec(keyframeVelocity([frame(0, 0, [5, 0, 0])], 0), [0, 0, 0]);
  const out = keyframeVelocity(track, 1.5);
  assert.equal(keyframeVelocity(track, 1.5, out), out, "writes into out");
  vec(out, [2, 0, 0]);
});
