import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Viewer } from "./viewer.js";

/** A press on an object turns into a grab once the pointer has moved more than this many CSS pixels… */
export const DRAG_START_PX = 6;
/** …or has stayed down this long (ms). A quicker tap does nothing, so in a room it never leaves an empty take. */
export const HOLD_START_MS = 150;
/** Drag-plane hits farther than this from the camera (m) are ignored: the ray is almost parallel to the plane. */
export const MAX_DRAG_DISTANCE = 20;

export function pressStartsGrab(dx: number, dy: number, heldMs: number): boolean {
  return Math.hypot(dx, dy) > DRAG_START_PX || heldMs >= HOLD_START_MS;
}

const toHit = new THREE.Vector3();
/** Where the pointer ray meets the drag plane, or null when that point is behind the camera or absurdly far away. */
export function dragPoint(ray: THREE.Ray, plane: THREE.Plane, out: THREE.Vector3): THREE.Vector3 | null {
  if (!ray.intersectPlane(plane, out)) return null;
  const distance = toHit.copy(out).sub(ray.origin).dot(ray.direction);
  return distance > 0 && distance <= MAX_DRAG_DISTANCE ? out : null;
}

/**
 * Mouse and touch: drag a paused object to throw it. Phone locomotion is the WALK pad (phone-joystick.ts).
 * Pressing an object holds the camera still; the grab starts only once the press moves or is held (pressStartsGrab).
 * The viewer keeps the held object above the floor.
 */
export function desktopInput(canvas: HTMLCanvasElement, camera: THREE.Camera, controls: OrbitControls, viewer: Viewer): void {
  const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(), plane = new THREE.Plane();
  const hitPoint = new THREE.Vector3(), offset = new THREE.Vector3(), normal = new THREE.Vector3(), grabPoint = new THREE.Vector3();
  let activePointer: number | null = null, version = 0, lastMove = 0;
  /** A press on an object that has not turned into a grab yet. */
  let press: { objectId: string; x: number; y: number; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  function updateRay(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    ray.setFromCamera(pointer, camera);
  }
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || viewer.timeline.playing || activePointer !== null) return;
    updateRay(event);
    const hit = viewer.pick(ray);
    if (!hit) return;
    event.stopImmediatePropagation(); event.preventDefault();
    // If the browser refuses the capture (an unknown pointer id), drop the press instead of leaving input stuck.
    try { canvas.setPointerCapture(event.pointerId); } catch { return; }
    controls.enabled = false; activePointer = event.pointerId;
    grabPoint.copy(hit.point);
    press = { objectId: hit.object.userData.objectId, x: event.clientX, y: event.clientY, at: performance.now(), timer: setTimeout(() => void begin(), HOLD_START_MS) };
  }, { capture: true });
  async function begin() {
    const pending = press;
    if (!pending) return;
    clearTimeout(pending.timer); press = null;
    const request = ++version;
    if (!await viewer.grab(pending.objectId)) { if (version === request) end(); return; }
    if (version !== request || activePointer === null) { viewer.place(); return; }
    camera.getWorldDirection(normal);
    plane.setFromNormalAndCoplanarPoint(normal, grabPoint);
    offset.copy(viewer.held!.root.position).sub(grabPoint); lastMove = performance.now();
  }
  canvas.addEventListener("pointermove", event => {
    if (activePointer !== event.pointerId) return;
    if (press) {
      event.stopImmediatePropagation();
      if (pressStartsGrab(event.clientX - press.x, event.clientY - press.y, performance.now() - press.at)) void begin();
      return;
    }
    if (!viewer.held) return;
    event.stopImmediatePropagation(); updateRay(event);
    if (dragPoint(ray.ray, plane, hitPoint)) {
      const now = performance.now();
      viewer.moveHeld(hitPoint.add(offset), viewer.held.root.quaternion, (now - lastMove) / 1000); lastMove = now;
    }
  }, { capture: true });
  function end() {
    ++version;
    if (press) { clearTimeout(press.timer); press = null; } // a tap: nothing was grabbed
    const pointerId = activePointer; activePointer = null;
    // Time is paused: the object stays where it was let go until Play, keeping the throw the drag gave it.
    viewer.place(); controls.enabled = true;
    if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  }
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    canvas.addEventListener(name, event => { if (activePointer === event.pointerId) end(); }, { capture: true });
  }
  window.addEventListener("blur", end);
  // Walking: W/A/S/D (or the up/down arrows) move along the view direction on the floor plane, Q/E lower and
  // raise, Shift runs. Camera and orbit target move together so a drag still orbits around what is in front of
  // you; guided mode's corridor clamp in main.ts applies afterwards, so this never walks out of the known area.
  const held = new Set<string>();
  const WALK = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown"]);
  const forward = new THREE.Vector3(), right = new THREE.Vector3(), step = new THREE.Vector3();
  let last = performance.now();
  const walk = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (held.size && controls.enabled) {
      const speed = (held.has("ShiftLeft") || held.has("ShiftRight") ? 4 : 1.5) * dt;
      camera.getWorldDirection(forward); forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1); else forward.normalize();
      right.set(-forward.z, 0, forward.x);
      step.set(0, 0, 0);
      if (held.has("KeyW") || held.has("ArrowUp")) step.add(forward);
      if (held.has("KeyS") || held.has("ArrowDown")) step.sub(forward);
      if (held.has("KeyD")) step.add(right);
      if (held.has("KeyA")) step.sub(right);
      if (held.has("KeyE")) step.y += 1;
      if (held.has("KeyQ")) step.y -= 1;
      if (step.lengthSq() > 0) { step.normalize().multiplyScalar(speed); camera.position.add(step); controls.target.add(step); }
    }
    requestAnimationFrame(walk);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(walk);   // (absent in the node tests)
  window.addEventListener("keyup", event => held.delete(event.code));
  window.addEventListener("blur", () => held.clear());
  window.addEventListener("keydown", event => {
    // Keys typed into the room sheet, a menu or a button are theirs (from Andrew Eng's frontend-phone).
    if (event.target instanceof Element && event.target.closest("input, select, textarea, button, summary, dialog[open], [contenteditable='true']")) return;
    if (event.code === "Space") { event.preventDefault(); viewer.togglePlay(); }
    if (event.code === "ArrowLeft") { event.preventDefault(); viewer.seek(viewer.timeline.time - 0.5); }
    if (event.code === "ArrowRight") { event.preventDefault(); viewer.seek(viewer.timeline.time + 0.5); }
    if (WALK.has(event.code) || event.code.startsWith("Shift")) { if (WALK.has(event.code)) event.preventDefault(); held.add(event.code); }
    if (event.code === "BracketLeft" || event.code === "BracketRight") {
      // [ and ] step through the takes.
      event.preventDefault();
      const takes = viewer.timeline.branches, count = takes.length, step = event.code === "BracketRight" ? 1 : -1;
      if (count > 1) viewer.selectBranch(takes[(takes.findIndex(b => b.id === viewer.timeline.activeId) + step + count) % count].id);
    }
    if (event.code === "Escape") end();
  });
}
