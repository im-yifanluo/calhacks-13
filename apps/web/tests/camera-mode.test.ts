import { expect, test } from "vitest";
import { PerspectiveCamera, Quaternion, Euler, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { wearerPose, releaseWearer } from "../src/camera/wearer";

test("wearer lock samples the requested time immediately and free look keeps that pose", () => {
  const camera = new PerspectiveCamera(65),
    controls = new OrbitControls(camera);
  const q = new Quaternion().setFromEuler(new Euler(0.15, 0.8, 0.2));
  const track = [
    { t: 0, p: [0, 1, 0], q: q.toArray() },
    { t: 10, p: [10, 2, -4], q: q.toArray() },
  ] as any;
  camera.position.set(50, 50, 50);
  controls.target.set(0, 0, 0);
  wearerPose(camera, track, 6, 78);
  expect(camera.position.distanceTo(new Vector3(6, 1.6, -2.4))).toBeLessThan(1e-8);
  const expectedPosition = camera.position.clone(),
    expectedRotation = camera.quaternion.clone();
  releaseWearer(camera, controls);
  for (let i = 0; i < 30; i++) controls.update();
  expect(camera.position.distanceTo(expectedPosition)).toBeLessThan(1e-8);
  expect(camera.quaternion.angleTo(expectedRotation)).toBeLessThan(1e-7);
  expect(camera.fov).toBe(78);
  wearerPose(camera, track, 2, 78);
  expect(camera.position.x).toBe(2);
});
