import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventDispatcher, Group, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { hitPanel, timelineFraction, placePanel, runPlaybackAction } from "../.test-dist/xr-panel.js";
import { XRInput } from "../.test-dist/input-xr.js";
import { Viewer } from "../.test-dist/viewer.js";
import { initPhysics } from "../.test-dist/physics.js";

await initPhysics();
const manifest = JSON.parse(await readFile(new URL("../public/mock/memory.json", import.meta.url)));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const flush = () => new Promise(resolve => setImmediate(resolve));

// The headset and canvas are the unavailable boundaries. Scene transforms, picking, playback, and physics are real.
const context = { clearRect() {}, fillRect() {}, beginPath() {}, roundRect() {}, fill() {}, fillText() {}, arc() {}, measureText(value) { return { width: value.length * 15 }; } };
globalThis.document = { createElement() { return { getContext: () => context }; } };
class Headset extends EventDispatcher {
  isPresenting = false;
  controllers = [new Group(), new Group()];
  grips = [new Group(), new Group()];
  hands = [Object.assign(new Group(), { joints: {} }), Object.assign(new Group(), { joints: {} })];
  session = Object.assign(new EventTarget(), { visibilityState: "visible" });
  getController(index) { return this.controllers[index]; }
  getControllerGrip(index) { return this.grips[index]; }
  getHand(index) { return this.hands[index]; }
  getSession() { return this.isPresenting ? this.session : null; }
}
function setup() {
  const scene = new Group(), rig = new Group(), root = new Group(); scene.add(rig, root);
  const camera = new PerspectiveCamera(); camera.position.set(0, 1.6, 2); rig.add(camera);
  const frame = t => ({ t, p: [0, 1, 0], q: [0, 0, 0, 1] });
  const definition = { ...structuredClone(manifest.objects[0]), id: "ball", track: [frame(0), frame(6)] };
  const object = { definition, root: new Group(), track: definition.track }; root.add(object.root);
  const viewer = new Viewer({ manifest, root, objects: [object], cameraTrack: [frame(0)], roomGeometry: [], warnings: [], dispose() {} }, () => {});
  viewer.seek(1);
  const xr = new Headset();
  const input = new XRInput({ xr }, rig, camera, viewer, { notice: () => "", openLibrary() {}, unlockAudio() {} });
  xr.isPresenting = true; xr.dispatchEvent({ type: "sessionstart" });
  xr.controllers[0].dispatchEvent({ type: "connected", data: { handedness: "right" } });
  input.update(1 / 60); input.update(1 / 60);
  const aim = target => {
    const controller = xr.controllers[0]; controller.position.set(0, 1.6, 2);
    controller.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), target.clone().sub(controller.position).normalize());
    scene.updateMatrixWorld(true);
  };
  const pointPanel = (x, y) => aim(new Vector3((x / 1200 - 0.5) * 1.12, 1.38 + (0.5 - y / 840) * 0.784, 0.6));
  const press = type => xr.controllers[0].dispatchEvent({ type });
  const click = (x, y) => { pointPanel(x, y); press("selectstart"); press("selectend"); };
  const dispose = () => { input.dispose(); viewer.dispose(); };
  return { viewer, xr, input, rig, camera, aim, click, pointPanel, press, dispose };
}

test("panel gaps and title do not accidentally activate playback", () => {
  assert.equal(hitPanel(0.5, 1 - 100 / 840), undefined);
  assert.equal(hitPanel(408 / 1200, 1 - 360 / 840), undefined);
  assert.equal(hitPanel(0.2, 1 - 360 / 840)?.action, "play");
  assert.equal(hitPanel(0.2, 1 - 360 / 840, false, true), undefined);
  assert.equal(hitPanel(0.2, 1 - 360 / 840, true), undefined);
  assert.equal(hitPanel(0.5, 1 - 750 / 840, true)?.action, "expand");
});

test("scrubbing reaches both endpoints without going outside the clip", () => {
  close(timelineFraction(0), 0); close(timelineFraction(1), 1); close(timelineFraction(0.5), 0.5);
  const app = setup();
  try {
    runPlaybackAction(app.viewer, "play"); assert.equal(app.viewer.timeline.playing, true);
    runPlaybackAction(app.viewer, "seek", 0.5);
    close(app.viewer.timeline.time, 3); assert.equal(app.viewer.timeline.playing, false);
    assert.equal(app.viewer.timeline.branches.length, 1);
  } finally { app.dispose(); }
});

test("recenter uses actual seated or standing eye height and world heading after rig turns", () => {
  for (const height of [1.1, 1.8]) {
    const world = new Group(), rig = new Group(), head = new PerspectiveCamera(), panel = new Group();
    world.add(rig); rig.add(head, panel); rig.position.set(5, 0.2, -3); rig.rotation.y = Math.PI / 2;
    head.position.set(0.3, height, 0.4); head.rotation.set(-0.7, -0.4, 0, "YXZ");
    placePanel(panel, head);
    const offset = panel.getWorldPosition(new Vector3()).sub(head.getWorldPosition(new Vector3()));
    close(offset.y, -0.22); close(Math.hypot(offset.x, offset.z), 1.4);
    close(new Vector3(0, 1, 0).applyQuaternion(panel.getWorldQuaternion(new Quaternion())).y, 1);
  }
});

test("takes can be switched in both directions and Original leaves alternate recordings intact", async () => {
  const app = setup();
  try {
    await app.viewer.grab("ball"); app.viewer.release(); runPlaybackAction(app.viewer, "play");
    const alternate = app.viewer.timeline.activeId;
    runPlaybackAction(app.viewer, "previous"); assert.equal(app.viewer.timeline.activeId, "original");
    runPlaybackAction(app.viewer, "next"); assert.equal(app.viewer.timeline.activeId, alternate);
    runPlaybackAction(app.viewer, "original"); assert.equal(app.viewer.timeline.activeId, "original");
    assert.ok(app.viewer.timeline.branches[1].tracks.get("ball").length > 1);
  } finally { app.dispose(); }
});

test("controller trigger operates playback and dragging the panel seeks without creating a take", () => {
  const app = setup();
  try {
    app.click(220, 365); assert.equal(app.viewer.timeline.playing, true);
    app.pointPanel(200, 245); app.press("selectstart");
    app.pointPanel(900, 245); app.input.update(0.1); app.press("selectend");
    close(app.viewer.timeline.time, timelineFraction(900 / 1200) * 6);
    assert.equal(app.viewer.timeline.playing, false); assert.equal(app.viewer.timeline.branches.length, 1);
  } finally { app.dispose(); }
});

test("grip cannot grab through the full panel, but hidden controls let an object be grabbed", async () => {
  const app = setup();
  try {
    app.aim(new Vector3(0, 1, 0)); app.press("squeezestart"); await flush();
    assert.equal(app.viewer.held, null); app.press("squeezeend");
    app.click(1080, 78); app.aim(new Vector3(0, 1, 0)); app.press("squeezestart"); await flush();
    assert.equal(app.viewer.held?.definition.id, "ball");
    assert.equal(app.viewer.timeline.branches.length, 2);
    app.press("selectend"); assert.ok(app.viewer.held, "unrelated trigger release must not drop the grip-held object");
    app.press("squeezeend"); assert.equal(app.viewer.held, null); assert.equal(app.viewer.recording, true);
  } finally { app.dispose(); }
});

test("a controller grip moves the object, and playback buttons cannot interrupt a hold", async () => {
  const app = setup();
  try {
    app.click(1080, 78); app.aim(new Vector3(0, 1, 0)); app.press("squeezestart"); await flush();
    const x = app.viewer.held.root.position.x;
    app.xr.grips[0].position.x += 0.25; app.input.update(1 / 60); app.viewer.update(1 / 60);
    close(app.viewer.held.root.position.x, x + 0.25);
    runPlaybackAction(app.viewer, "play"); assert.equal(app.viewer.timeline.playing, false); assert.ok(app.viewer.held);
  } finally { app.dispose(); }
});

test("leaving VR cancels a pending grab before it can fork a take", async () => {
  const app = setup(); let grant;
  app.viewer.setAuthority({ acquire: () => new Promise(resolve => { grant = resolve; }), release() {} });
  try {
    app.click(1080, 78); app.aim(new Vector3(0, 1, 0)); app.press("squeezestart");
    assert.ok(grant); app.xr.isPresenting = false; app.xr.dispatchEvent({ type: "sessionend" });
    grant(true); await flush();
    assert.equal(app.viewer.held, null); assert.equal(app.viewer.timeline.branches.length, 1);
  } finally { app.dispose(); }
});

test("opening the system menu releases the held object", async () => {
  const app = setup();
  try {
    app.click(1080, 78); app.aim(new Vector3(0, 1, 0)); app.press("squeezestart"); await flush();
    assert.ok(app.viewer.held);
    app.xr.session.visibilityState = "visible-blurred"; app.xr.session.dispatchEvent(new Event("visibilitychange"));
    assert.equal(app.viewer.held, null);
  } finally { app.dispose(); }
});
