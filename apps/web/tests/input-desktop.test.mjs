// Mouse and touch input (input-desktop.ts) on the real Viewer, with a minimal fake DOM: a tap never grabs, a drag
// or a held press does, and drag-plane hits behind the camera, far away or under the floor are handled.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Group, PerspectiveCamera, Plane, Ray, Vector3 } from "three";
import { initPhysics } from "../.test-dist/physics.js";
import { Viewer } from "../.test-dist/viewer.js";
import { desktopInput, dragPoint, pressStartsGrab, HOLD_START_MS, MAX_DRAG_DISTANCE } from "../.test-dist/input-desktop.js";

const manifest = JSON.parse(await readFile(new URL("../public/mock/memory.json", import.meta.url)));
await initPhysics();
// desktopInput listens for blur and keys on window. Rapier's glue reads window.performance once a window exists.
globalThis.window ??= Object.assign(new EventTarget(), { performance: globalThis.performance });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

class FakeCanvas extends EventTarget {
  captured = new Set();
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}
const pointer = (type, x, y) => Object.assign(new Event(type), { button: 0, pointerId: 1, clientX: x, clientY: y });

/** A paused viewer with the ball at (0, 1, 0), straight ahead of a camera at (0, 1, 3): the canvas centre is on it. */
function setup() {
  const frame = t => ({ t, p: [0, 1, 0], q: [0, 0, 0, 1] });
  const definition = { ...structuredClone(manifest.objects[0]), id: "ball", track: [frame(0), frame(6)] };
  const object = { definition, root: new Group(), track: definition.track };
  const root = new Group(); root.add(object.root);
  const memory = { manifest: structuredClone(manifest), root, objects: [object], cameraTrack: [frame(0)], roomGeometry: [], warnings: [], dispose() {} };
  const viewer = new Viewer(memory, () => {});
  viewer.seek(1);
  const camera = new PerspectiveCamera(65, 800 / 600, 0.05, 200);
  camera.position.set(0, 1, 3); camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
  const canvas = new FakeCanvas(), controls = { enabled: true };
  desktopInput(canvas, camera, controls, viewer);
  return { viewer, canvas, controls, ball: object.root };
}

test("a press turns into a grab past 6 px of movement or after 150 ms held", () => {
  assert.equal(pressStartsGrab(6, 0, 0), false); assert.equal(pressStartsGrab(3, 4, 149), false);
  assert.equal(pressStartsGrab(6.1, 0, 0), true); assert.equal(pressStartsGrab(-5, 5, 10), true);
  assert.equal(pressStartsGrab(0, 0, HOLD_START_MS), true);
});

test("drag-plane hits behind the camera or absurdly far away are ignored", () => {
  const out = new Vector3(), facing = new Plane(new Vector3(0, 0, 1), 0); // the plane z = 0
  assert.ok(dragPoint(new Ray(new Vector3(0, 1, 3), new Vector3(0, 0, -1)), facing, out)); close(out.z, 0);
  assert.equal(dragPoint(new Ray(new Vector3(0, 1, 3), new Vector3(0, 0, 1)), facing, out), null, "behind the camera");
  const grazing = new Vector3(1, 0, -0.01).normalize(); // almost parallel to the plane: the hit is ~300 m away
  assert.equal(dragPoint(new Ray(new Vector3(0, 1, 3), grazing), facing, out), null);
  const steep = new Vector3(1, 0, -3 / (MAX_DRAG_DISTANCE - 1)).normalize(); // just inside the limit
  assert.ok(dragPoint(new Ray(new Vector3(0, 1, 3), steep), facing, out));
});

test("a quick tap on a paused object does nothing: no grab, no take, the camera controls come back", async () => {
  const { viewer, canvas, controls } = setup();
  const events = []; viewer.subscribe(e => events.push(e.type));
  try {
    canvas.dispatchEvent(pointer("pointerdown", 400, 300));
    assert.equal(controls.enabled, false, "pressing an object holds the camera still");
    await sleep(20);
    canvas.dispatchEvent(pointer("pointerup", 401, 300));
    await sleep(HOLD_START_MS + 50);
    assert.equal(viewer.held, null); assert.equal(viewer.busy, false);
    assert.equal(viewer.timeline.branches.length, 1); assert.deepEqual(events, []);
    assert.equal(controls.enabled, true); assert.equal(canvas.captured.size, 0);
  } finally { viewer.dispose(); }
});

test("a drag past the threshold grabs, follows the pointer and throws on release", async () => {
  const { viewer, canvas, ball } = setup();
  try {
    canvas.dispatchEvent(pointer("pointerdown", 400, 300));
    canvas.dispatchEvent(pointer("pointermove", 403, 300)); // within 6 px: still a press
    await sleep(0);
    assert.equal(viewer.busy, false);
    canvas.dispatchEvent(pointer("pointermove", 410, 300));
    await sleep(0);
    assert.equal(viewer.held?.definition.id, "ball"); assert.equal(viewer.timeline.branches.length, 2);
    canvas.dispatchEvent(pointer("pointermove", 480, 300));
    assert.ok(ball.position.x > 0.2, `the ball follows the pointer (x = ${ball.position.x})`);
    canvas.dispatchEvent(pointer("pointerup", 480, 300));
    assert.equal(viewer.held, null); assert.equal(viewer.recording, true);
  } finally { viewer.dispose(); }
});

test("holding the press still for 150 ms grabs without moving", async () => {
  const { viewer, canvas } = setup();
  try {
    canvas.dispatchEvent(pointer("pointerdown", 400, 300));
    await sleep(HOLD_START_MS + 30);
    assert.equal(viewer.held?.definition.id, "ball");
    canvas.dispatchEvent(pointer("pointerup", 400, 300));
    assert.equal(viewer.held, null);
  } finally { viewer.dispose(); }
});

test("dragging to the bottom of the screen keeps the ball on the floor, never under it", async () => {
  const { viewer, canvas, ball } = setup();
  try {
    canvas.dispatchEvent(pointer("pointerdown", 400, 300));
    canvas.dispatchEvent(pointer("pointermove", 400, 320));
    await sleep(0);
    assert.equal(viewer.held?.definition.id, "ball");
    // The drag plane faces the camera; the bottom edge of the view meets it about 0.85 m under the floor.
    for (let y = 340; y <= 600; y += 20) { canvas.dispatchEvent(pointer("pointermove", 400, y)); await sleep(2); }
    close(ball.position.y, manifest.objects[0].collider.radius);
    canvas.dispatchEvent(pointer("pointerup", 400, 600));
    for (let i = 0; i < 1200 && viewer.recording; i++) viewer.update(1 / 60);
    const take = viewer.timeline.active.tracks.get("ball");
    assert.ok(take.every(f => f.p[1] > 0.17), `lowest recorded y ${Math.min(...take.map(f => f.p[1]))}`);
  } finally { viewer.dispose(); }
});
