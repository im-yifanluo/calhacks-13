// Follow mode (follow.ts): the eyes ride the recorded path while the memory plays, are free while paused, and glide
// back onto the path on resume (or when the clock jumps while playing).
import test from "node:test";
import assert from "node:assert/strict";
import { Euler, Group, PerspectiveCamera, Vector3 } from "three";
import { GLIDE_SECONDS, PathFollower, pathPosition, placeHead } from "../.test-dist/follow.js";

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const vec = (vector, expected, tolerance = 1e-9) => expected.forEach((x, i) => close(vector.toArray()[i], x, tolerance));
const q = [0, 0, 0, 1];
// A 2 s walk along +x then +z, at eye height.
const track = [{ t: 0, p: [0, 1.6, 0], q }, { t: 1, p: [2, 1.6, 0], q }, { t: 2, p: [2, 1.8, 4], q }];

test("pathPosition interpolates position between keyframes and holds the ends", () => {
  vec(pathPosition(track, 0), [0, 1.6, 0]);
  vec(pathPosition(track, 0.25), [0.5, 1.6, 0]);
  vec(pathPosition(track, 1.5), [2, 1.7, 2]);
  vec(pathPosition(track, -3), [0, 1.6, 0]);
  vec(pathPosition(track, 9), [2, 1.8, 4]);
  vec(pathPosition([track[1]], 5), [2, 1.6, 0]);
});

test("locked and already on the path, the follower rides it frame by frame", () => {
  const follower = new PathFollower(track), out = new Vector3(), eyes = new Vector3(0, 1.6, 0);
  let t = 0;
  for (let frame = 0; frame < 60; frame++) {
    const dt = 1 / 60; t = frame === 0 ? 0 : t + dt;
    assert.ok(follower.step(true, t, eyes, dt, out));
    eyes.copy(out);
  }
  vec(eyes, pathPosition(track, t).toArray(), 1e-9);
});

test("paused, nothing is moved; resuming glides from where you are onto the path in GLIDE_SECONDS", () => {
  const follower = new PathFollower(track), out = new Vector3();
  const eyes = new Vector3(0, 1.6, 0);
  follower.step(true, 0, eyes, 0, out);
  assert.equal(follower.step(false, 0.5, eyes, 1 / 60, out), null);      // paused: roam
  eyes.set(5, 1.6, -3);                                                  // walked away
  const dt = 1 / 60;
  let t = 0.5, first = follower.step(true, t, eyes, dt, out).clone();   // resume
  vec(first, [5, 1.6, -3]);                                              // the glide starts where you stand
  assert.ok(follower.gliding);
  let frames = 0;
  while (follower.gliding) { t += dt; eyes.copy(follower.step(true, t, eyes, dt, out)); frames++; assert.ok(frames < 200); }
  close(frames * dt, GLIDE_SECONDS, dt + 1e-9);
  vec(eyes, pathPosition(track, t).toArray());
  // Halfway through a glide it is between the two (eased), not on either end.
  const half = new PathFollower(track);
  half.step(true, 0, new Vector3(0, 1.6, 0), 0, out);
  half.step(false, 0, out, 0, out);
  const start = new Vector3(0, 1.6, 10);
  half.step(true, 0, start, 0, out);
  for (let k = 0; k < 18; k++) half.step(true, 0, start, 1 / 60, out);   // time held at 0 (a paused room clock replayed)
  assert.ok(out.z > 0.5 && out.z < 9.5, `mid-glide z=${out.z}`);
});

test("a jump in the clock while playing glides instead of snapping; normal playback never does", () => {
  const follower = new PathFollower(track), out = new Vector3(), eyes = new Vector3(0, 1.6, 0);
  follower.step(true, 0, eyes, 0, out); eyes.copy(out);
  follower.step(true, 0.1, eyes, 0.1, out); eyes.copy(out);
  assert.equal(follower.gliding, false);
  follower.step(true, 1.8, eyes, 1 / 60, out);                           // someone in the room scrubbed ahead
  assert.ok(follower.gliding);
  vec(out, eyes.toArray());
  // At double speed a frame advances 2·dt: still playback.
  const fast = new PathFollower(track);
  fast.step(true, 0, eyes.set(0, 1.6, 0), 0, out);
  fast.step(true, 0.2, out, 0.1, out, 2);
  assert.equal(fast.gliding, false);
});

test("placeHead moves the VR rig so the headset lands on the target, keeping the rig's turn", () => {
  const scene = new Group(), rig = new Group(), camera = new PerspectiveCamera();
  scene.add(rig); rig.add(camera);
  rig.position.set(1, 0, -2); rig.rotation.set(0, Math.PI / 3, 0);
  camera.position.set(0.3, 1.55, -0.2); camera.quaternion.setFromEuler(new Euler(0.2, 0.7, 0, "YXZ"));
  scene.updateMatrixWorld(true);
  const target = new Vector3(4, 1.8, 5);
  placeHead(rig, camera, target);
  vec(camera.getWorldPosition(new Vector3()), target.toArray(), 1e-9);
  close(rig.rotation.y, Math.PI / 3);
});
