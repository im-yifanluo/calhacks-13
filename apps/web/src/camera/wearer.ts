import { PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Keyframe } from "@memreplay/shared";
import { sampleTrack } from "../engine/tracks";

/** Lock immediately, even while paused or between animation frames. */
export function wearerPose(camera: PerspectiveCamera, track: Keyframe[], time: number, fov: number) {
  sampleTrack(track, time, camera);
  camera.fov = fov;
  camera.updateProjectionMatrix();
}

/** Start exploring from the current recorded pose, never from an earlier free camera. */
export function releaseWearer(camera: PerspectiveCamera, controls: OrbitControls) {
  const position = camera.position.clone(),
    rotation = camera.quaternion.clone();
  // Flush any unfinished orbit/pan/zoom from before the lock, then replace its pose.
  const damping = controls.enableDamping,
    autoRotate = controls.autoRotate;
  controls.enableDamping = false;
  controls.autoRotate = false;
  controls.update();
  camera.position.copy(position);
  camera.quaternion.copy(rotation);
  camera.up.set(0, 1, 0).applyQuaternion(rotation);
  controls.target.copy(position).add(new Vector3(0, 0, -1).applyQuaternion(rotation).multiplyScalar(1.5));
  controls.update();
  controls.enableDamping = damping;
  controls.autoRotate = autoRotate;
  // Keep the captured field of view, avoiding a zoom jump on the toggle.
}
