// Quest locomotion (input-xr.ts): left-stick direction and snap turn from the user camera under the rig.
import test from "node:test";
import assert from "node:assert/strict";
import { ArrayCamera, Euler, Group, PerspectiveCamera, Vector3 } from "three";
import { headForward, snapTurn, stickMove } from "../.test-dist/input-xr.js";

// No Quest is available, so these check the locomotion math against the scene graph main.ts builds, with the head
// pose WebXRManager.updateUserCamera writes into the user camera on each render (the viewer pose relative to the rig).
const close = (a, b, tolerance) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const vec = (vector, expected, tolerance = 1e-12) =>
  expected.forEach((x, i) => close(vector.toArray()[i], x, tolerance));

function headset({ rigYaw = 0, rigPosition = [0, 0, 0], head = [0.4, 1.6, 0.3], headYaw = 0, headPitch = 0 } = {}) {
  const scene = new Group(),
    rig = new Group(),
    camera = new PerspectiveCamera();
  scene.add(rig);
  rig.add(camera);
  rig.position.fromArray(rigPosition);
  rig.rotation.set(0, rigYaw, 0);
  camera.position.fromArray(head);
  camera.quaternion.setFromEuler(new Euler(headPitch, headYaw, 0, "YXZ"));
  scene.updateMatrixWorld(true);
  return { rig, camera };
}
const worldHead = (camera) => camera.getWorldPosition(new Vector3());

test("the stick direction includes the rig's spawn yaw and earlier snap turns", () => {
  vec(headForward(headset({ rigYaw: Math.PI / 2 }).camera), [-1, 0, 0]); // spawned facing -X
  vec(headForward(headset({ rigYaw: Math.PI / 2, headYaw: -Math.PI / 6 }).camera), [
    -Math.cos(Math.PI / 6),
    0,
    -Math.sin(Math.PI / 6),
  ]);
});

test("the stick direction stays horizontal and defined looking up or straight down", () => {
  vec(headForward(headset({ headPitch: -1.2 }).camera), [0, 0, -1]);
  vec(headForward(headset({ headPitch: Math.PI / 2 }).camera), [0, 0, -1], 1e-9);
  vec(headForward(headset({ rigYaw: Math.PI, headPitch: -Math.PI / 2 }).camera), [0, 0, 1], 1e-9);
});

test("left stick forward moves the rig along the head's world forward and x strafes to its right", () => {
  const { rig, camera } = headset({ rigYaw: Math.PI / 2, rigPosition: [5, 0, 5] });
  stickMove(rig, camera, 0, -1, 0.5); // stick pushed forward
  vec(rig.position, [4.5, 0, 5]);
  stickMove(rig, camera, 1, 0, 0.5); // facing -X with +Y up, the right hand points to -Z
  vec(rig.position, [4.5, 0, 4.5]);
  stickMove(rig, camera, 0.1, 0.15, 10); // inside the dead zone
  vec(rig.position, [4.5, 0, 4.5]);
});

test("a snap turn pivots about the head: the head stays put and the view turns 30° clockwise", () => {
  const { rig, camera } = headset({ rigYaw: Math.PI / 2, rigPosition: [5, 0, 5], head: [0.4, 1.6, 0.3] });
  const before = worldHead(camera),
    forward = headForward(camera).clone();
  snapTurn(rig, camera, -Math.PI / 6); // what input-xr does for the right stick pushed right
  vec(worldHead(camera), before.toArray());
  close(headForward(camera).angleTo(forward), Math.PI / 6, 1e-12);
  assert.ok(
    new Vector3().crossVectors(forward, headForward(camera)).y < 0,
    "clockwise seen from above, i.e. a right turn",
  );
  for (let i = 0; i < 11; i++) snapTurn(rig, camera, -Math.PI / 6);
  vec(worldHead(camera), before.toArray(), 1e-9);
  vec(headForward(camera), forward.toArray(), 1e-9);
});

test("why not renderer.xr.getCamera(): during the animation callback it holds the rig-local pose", () => {
  // WebXRManager copies view.transform into its parentless ArrayCamera every frame (matrix, then decompose). World
  // queries on it rebuild matrixWorld from that local pose and ignore the rig.
  const { rig, camera } = headset({ rigYaw: Math.PI / 2, rigPosition: [5, 0, 5] });
  const xrCamera = new ArrayCamera();
  xrCamera.matrix.compose(camera.position, camera.quaternion, new Vector3(1, 1, 1));
  xrCamera.matrix.decompose(xrCamera.position, xrCamera.quaternion, xrCamera.scale);
  const wrong = xrCamera.getWorldDirection(new Vector3()).setY(0).normalize();
  vec(wrong, [0, 0, -1]); // rig-local forward, though the user faces -X in the world
  vec(headForward(camera), [-1, 0, 0]);
  // Its "world" position ignores the rig turning, so the old snap-turn correction was always zero.
  const a = xrCamera.getWorldPosition(new Vector3());
  rig.rotateY(-Math.PI / 6);
  rig.updateMatrixWorld(true);
  vec(xrCamera.getWorldPosition(new Vector3()), a.toArray(), 0);
});
