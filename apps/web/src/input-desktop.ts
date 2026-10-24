import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Viewer } from "./viewer.js";

/** Desktop verification controls. Dedicated phone locomotion/tap interaction belongs to P4. */
export function desktopInput(canvas: HTMLCanvasElement, camera: THREE.Camera, controls: OrbitControls, viewer: Viewer): void {
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(), plane = new THREE.Plane();
  const hitPoint = new THREE.Vector3(), offset = new THREE.Vector3(), normal = new THREE.Vector3();
  let activePointer: number | null = null, version = 0, lastMove = 0;
  function updateRay(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    ray.setFromCamera(pointer, camera);
  }
  canvas.addEventListener("pointerdown", async event => {
    if (event.button !== 0 || viewer.timeline.playing || activePointer !== null) return;
    updateRay(event);
    const hit = viewer.pick(ray);
    if (!hit) return;
    event.stopImmediatePropagation(); event.preventDefault(); controls.enabled = false;
    activePointer = event.pointerId; canvas.setPointerCapture(event.pointerId);
    const request = ++version;
    if (!await viewer.grab(hit.object.userData.objectId)) { if (version === request) end(); return; }
    if (version !== request || activePointer === null) { viewer.release(); return; }
    camera.getWorldDirection(normal);
    plane.setFromNormalAndCoplanarPoint(normal, hit.point);
    offset.copy(viewer.held!.root.position).sub(hit.point); lastMove = performance.now();
  }, { capture: true });
  canvas.addEventListener("pointermove", event => {
    if (activePointer !== event.pointerId || !viewer.held) return;
    event.stopImmediatePropagation(); updateRay(event);
    if (ray.ray.intersectPlane(plane, hitPoint)) {
      const now = performance.now();
      viewer.moveHeld(hitPoint.add(offset), viewer.held.root.quaternion, (now - lastMove) / 1000); lastMove = now;
    }
  }, { capture: true });
  function end() {
    ++version;
    const pointerId = activePointer; activePointer = null;
    viewer.release(); controls.enabled = true;
    if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  }
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    canvas.addEventListener(name, event => { if (activePointer === event.pointerId) end(); }, { capture: true });
  }
  window.addEventListener("blur", end);
  window.addEventListener("keydown", event => {
    if ((event.target as HTMLElement)?.matches("input, select, textarea, button")) return;
    if (event.code === "Space") { event.preventDefault(); viewer.togglePlay(); }
    if (event.code === "ArrowLeft") { event.preventDefault(); viewer.seek(viewer.timeline.time - 0.5); }
    if (event.code === "ArrowRight") { event.preventDefault(); viewer.seek(viewer.timeline.time + 0.5); }
    if (event.code === "Escape") end();
  });
}
