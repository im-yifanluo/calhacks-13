// Headset controls (input-xr.ts with vr-panel.ts) against a simulated headset. Only the event boundary is fake: scene
// transforms, ray picking, playback, takes and physics are real. Adapted from Andrew Eng's frontend-quest tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventDispatcher, Group, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { XRInput } from "../.test-dist/input-xr.js";
import { COMPACT_REGIONS, FOLLOW, PANEL, PANEL_METERS_HIGH, REGIONS, scrubTime } from "../.test-dist/vr-panel.js";
import { Viewer } from "../.test-dist/viewer.js";
import { initPhysics } from "../.test-dist/physics.js";

await initPhysics();
const manifest = JSON.parse(await readFile(new URL("../public/mock/memory.json", import.meta.url)));
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const region = (id) => REGIONS.find((r) => r.id === id);

const context = new Proxy(
  { measureText: (value) => ({ width: value.length * 15 }), createLinearGradient: () => ({ addColorStop() {} }) },
  { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true },
);
globalThis.document = { createElement: () => ({ getContext: () => context, width: 0, height: 0 }) };

class Headset extends EventDispatcher {
  isPresenting = false;
  controllers = [new Group(), new Group()];
  grips = [new Group(), new Group()];
  hands = [Object.assign(new Group(), { joints: {} }), Object.assign(new Group(), { joints: {} })];
  session = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    ended: false,
    end() {
      this.ended = true;
      return Promise.resolve();
    },
  });
  getController(index) {
    return this.controllers[index];
  }
  getControllerGrip(index) {
    return this.grips[index];
  }
  getHand(index) {
    return this.hands[index];
  }
  getSession() {
    return this.isPresenting ? this.session : null;
  }
}
const gamepad = () => ({ axes: [0, 0, 0, 0], buttons: Array.from({ length: 6 }, () => ({ pressed: false })) });

function setup() {
  const scene = new Group(),
    rig = new Group(),
    root = new Group();
  scene.add(rig, root);
  const camera = new PerspectiveCamera();
  camera.position.set(0, 1.6, 2);
  rig.add(camera);
  const frame = (t) => ({ t, p: [0, 1, 0], q: [0, 0, 0, 1] });
  const definition = { ...structuredClone(manifest.objects[0]), id: "ball", track: [frame(0), frame(6)] };
  const object = { definition, root: new Group(), track: definition.track };
  root.add(object.root);
  const viewer = new Viewer(
    { manifest, root, objects: [object], cameraTrack: [frame(0)], roomGeometry: [], warnings: [], dispose() {} },
    () => {},
  );
  viewer.seek(1);
  const xr = new Headset(),
    right = gamepad(),
    left = gamepad();
  const input = new XRInput({ xr, capabilities: { getMaxAnisotropy: () => 1 } }, rig, camera, viewer, {
    status: () => "",
    room: () => "Solo",
    title: () => "Test room",
    gaps: () => [[2, 3]],
    unlockAudio() {},
  });
  xr.isPresenting = true;
  xr.dispatchEvent({ type: "sessionstart" });
  xr.controllers[0].dispatchEvent({ type: "connected", data: { handedness: "right", gamepad: right } });
  xr.controllers[1].dispatchEvent({ type: "connected", data: { handedness: "left", gamepad: left } });
  const step = (dt = 1 / 60) => {
    scene.updateMatrixWorld(true);
    input.update(dt);
    viewer.update(dt);
    scene.updateMatrixWorld(true);
  };
  for (let i = 0; i < 17; i++) step(); // the panel waits a few frames for a head pose, then opens in front
  const panel = rig.getObjectByName("vr-panel");
  /** Point controller 0 (held at the eyes) at a world point. */
  const aim = (target) => {
    const controller = xr.controllers[0];
    controller.position.set(0, 1.6, 2);
    controller.quaternion.setFromUnitVectors(
      new Vector3(0, 0, -1),
      target.clone().sub(controller.position).normalize(),
    );
    scene.updateMatrixWorld(true);
  };
  const pixel = (x, y) =>
    panel.localToWorld(
      new Vector3((x / PANEL.width - 0.5) * PANEL.metersWide, (0.5 - y / PANEL.height) * PANEL_METERS_HIGH, 0),
    );
  const pointAt = (x, y) => aim(pixel(x, y));
  const centre = (r) => pointAt(r.x + r.w / 2, r.y + r.h / 2);
  const press = (type) => xr.controllers[0].dispatchEvent({ type });
  const click = (r) => {
    centre(r);
    press("selectstart");
    press("selectend");
  };
  const ball = new Vector3(0, 1, 0);
  const dispose = () => {
    input.dispose();
    viewer.dispose();
  };
  return {
    viewer,
    xr,
    input,
    rig,
    camera,
    panel,
    aim,
    pointAt,
    centre,
    press,
    click,
    step,
    ball,
    right,
    left,
    pixel,
    dispose,
  };
}

test("the panel opens in front of and below the eyes once the headset reports a head pose", () => {
  const app = setup();
  try {
    assert.equal(app.panel.visible, true);
    close(app.panel.position.z, 2 - FOLLOW.distance);
    close(app.panel.position.y, 1.6 - FOLLOW.drop);
  } finally {
    app.dispose();
  }
});

test("the trigger on Play toggles playback; dragging along the scrubber seeks, at most 15 times a second, and makes no take", () => {
  const app = setup();
  try {
    app.click(region("play"));
    assert.equal(app.viewer.timeline.playing, true);
    const scrub = region("scrub"),
      y = scrub.y + scrub.h / 2;
    app.pointAt(100, y);
    app.press("selectstart");
    assert.equal(app.viewer.timeline.playing, false, "seeking pauses");
    const seeks = [];
    const seek = app.viewer.seek.bind(app.viewer);
    app.viewer.seek = (t) => {
      seeks.push(t);
      seek(t);
    };
    for (let i = 0; i < 30; i++) {
      app.pointAt(100 + i * 25, y);
      app.step(1 / 90);
    } // a third of a second at 90 Hz
    assert.ok(seeks.length >= 4 && seeks.length <= 6, `${seeks.length} seeks`);
    app.pointAt(900, y);
    app.press("selectend");
    close(app.viewer.timeline.time, scrubTime(900 / PANEL.width, app.viewer.timeline.duration), 1e-4);
    assert.equal(app.viewer.timeline.branches.length, 1);
  } finally {
    app.dispose();
  }
});

test("a grip on the panel grabs nothing behind it; once hidden, the object behind can be grabbed", async () => {
  const app = setup();
  try {
    app.aim(app.ball);
    app.press("squeezestart");
    await flush();
    assert.equal(app.viewer.held, null, "the panel is in the way");
    app.press("squeezeend");
    app.click(region("hide"));
    app.step();
    app.aim(app.ball);
    app.press("squeezestart");
    await flush();
    assert.equal(app.viewer.held?.definition.id, "ball");
    assert.equal(app.viewer.timeline.branches.length, 2);
    app.press("selectend");
    assert.ok(app.viewer.held, "letting go of the trigger must not drop an object held by the grip");
    app.press("squeezeend");
    assert.equal(app.viewer.isPlaced, true, "let go while paused: it stays where it was put");
    app.right.buttons[4].pressed = true;
    app.step();
    app.right.buttons[4].pressed = false;
    assert.equal(app.viewer.timeline.playing, true, "A/X plays");
    assert.equal(app.viewer.held, null, "and Play releases it");
  } finally {
    app.dispose();
  }
});

test("the held object follows the controller grip, and the left stick cannot move you while you hold it", async () => {
  const app = setup();
  try {
    app.click(region("hide"));
    app.step();
    app.aim(app.ball);
    app.press("squeezestart");
    await flush();
    const x = app.viewer.held.root.position.x;
    app.xr.grips[0].position.x += 0.25;
    app.step();
    close(app.viewer.held.root.position.x, x + 0.25);
    app.left.axes[3] = -1;
    const rig = app.rig.position.clone();
    for (let i = 0; i < 10; i++) app.step();
    close(app.rig.position.distanceTo(rig), 0, 1e-12);
    app.press("squeezeend");
    app.step();
    assert.ok(app.rig.position.distanceTo(rig) > 0.01, "the stick walks again after the throw");
  } finally {
    app.dispose();
  }
});

test("leaving VR cancels a pending grab before it can fork a take", async () => {
  const app = setup();
  let grant;
  app.viewer.setAuthority({
    acquire: () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
    release() {},
  });
  try {
    app.click(region("hide"));
    app.step();
    app.aim(app.ball);
    app.press("squeezestart");
    assert.ok(grant, "the grab is waiting on the room");
    app.xr.isPresenting = false;
    app.xr.dispatchEvent({ type: "sessionend" });
    grant(true);
    await flush();
    assert.equal(app.viewer.held, null);
    assert.equal(app.viewer.timeline.branches.length, 1);
  } finally {
    app.dispose();
  }
});

test("opening the system menu releases the held object", async () => {
  const app = setup();
  try {
    app.click(region("hide"));
    app.step();
    app.aim(app.ball);
    app.press("squeezestart");
    await flush();
    assert.ok(app.viewer.held);
    app.xr.session.visibilityState = "visible-blurred";
    app.xr.session.dispatchEvent(new Event("visibilitychange"));
    assert.equal(app.viewer.held, null);
  } finally {
    app.dispose();
  }
});

test("dragging the bar under the panel moves it; it stays where dropped until the right stick is clicked", () => {
  const app = setup();
  try {
    const bar = app.panel.localToWorld(new Vector3(0, -PANEL_METERS_HIGH / 2 - 0.004, 0));
    app.aim(bar);
    app.press("selectstart");
    // Swing the ray 30° to the left over a quarter second.
    const controller = app.xr.controllers[0],
      start = controller.quaternion.clone();
    for (let i = 1; i <= 20; i++) {
      controller.quaternion
        .copy(start)
        .premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (((30 * Math.PI) / 180) * i) / 20));
      app.step(1 / 80);
    }
    app.press("selectend");
    const dropped = app.panel.position.clone();
    assert.ok(dropped.x < -0.4, `moved left to x = ${dropped.x}`);
    // Turn the head away and walk: a pinned panel stays put.
    app.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    app.camera.position.x += 0.7;
    for (let i = 0; i < 60; i++) app.step();
    close(app.panel.position.distanceTo(dropped), 0, 1e-9);
    // Click the right stick: back in front of the (turned) head.
    app.right.buttons[3].pressed = true;
    app.step();
    app.right.buttons[3].pressed = false;
    app.step();
    const head = app.camera.position;
    close(app.panel.position.x, head.x - FOLLOW.distance, 1e-6);
    close(app.panel.position.z, head.z, 1e-6);
  } finally {
    app.dispose();
  }
});

test("B or Y hides the panel to a small pill and brings it back in front of you; the pill also shows it", () => {
  const app = setup();
  try {
    const tap = () => {
      app.right.buttons[5].pressed = true;
      app.step();
      app.right.buttons[5].pressed = false;
      app.step();
    };
    tap();
    const pill = COMPACT_REGIONS[0];
    app.centre(pill);
    app.step();
    app.press("selectstart");
    app.press("selectend");
    app.step();
    // Shown again by the pill: the controls work.
    app.click(region("play"));
    assert.equal(app.viewer.timeline.playing, true);
    tap();
    tap();
    app.click(region("play"));
    assert.equal(app.viewer.timeline.playing, false, "shown again by B/Y");
  } finally {
    app.dispose();
  }
});

test("Exit VR on the help page ends the session", () => {
  const app = setup();
  try {
    app.click(region("help"));
    app.step();
    app.click({ x: 728, y: 344, w: 256, h: 80 });
    assert.equal(app.xr.session.ended, true);
  } finally {
    app.dispose();
  }
});

test("a panel left out of view can be called back with the Bring controls here pill", () => {
  const app = setup();
  try {
    // Drag it far to the left and drop it, then keep looking ahead.
    const bar = app.panel.localToWorld(new Vector3(0, -PANEL_METERS_HIGH / 2 - 0.004, 0));
    app.aim(bar);
    app.press("selectstart");
    const controller = app.xr.controllers[0],
      start = controller.quaternion.clone();
    for (let i = 1; i <= 30; i++) {
      controller.quaternion
        .copy(start)
        .premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (((80 * Math.PI) / 180) * i) / 30));
      app.step(1 / 60);
    }
    app.press("selectend");
    const summon = app.rig.getObjectByName("vr-panel-summon");
    for (let i = 0; i < 180; i++) app.step(1 / 60);
    assert.equal(summon.visible, true, "offered after the panel was out of view for a while");
    app.aim(summon.getWorldPosition(new Vector3()));
    app.step();
    app.press("selectstart");
    app.press("selectend");
    app.step();
    assert.equal(summon.visible, false);
    close(app.panel.position.x, 0, 1e-6);
    close(app.panel.position.z, 2 - FOLLOW.distance, 1e-6);
  } finally {
    app.dispose();
  }
});

test("at the very end of the memory objects don't light up, and a grab says what to do instead of failing silently", async () => {
  const app = setup();
  try {
    app.click(region("hide"));
    app.step();
    app.viewer.seek(app.viewer.timeline.duration);
    app.aim(app.ball);
    app.step();
    assert.equal(app.input.pointingKeys[0], "", "the ball is not offered at the end");
    app.press("squeezestart");
    await flush();
    app.press("squeezeend");
    assert.equal(app.viewer.held, null);
    assert.equal(app.viewer.timeline.branches.length, 1, "no take was made");
    assert.match(app.input.toast.text, /end/);
    // Back a second, the same grab works.
    app.viewer.seek(app.viewer.timeline.duration - 1);
    app.aim(app.ball);
    app.step();
    assert.equal(app.input.pointingKeys[0], "object:ball");
    app.press("squeezestart");
    await flush();
    assert.equal(app.viewer.held?.definition.id, "ball");
  } finally {
    app.dispose();
  }
});

/** The ball's proxy as a world sphere. */
const ballSphere = (app) => {
  const proxy = app.viewer.pickables.find((p) => p.userData.objectId === "ball");
  proxy.updateWorldMatrix(true, false);
  if (!proxy.geometry.boundingSphere) proxy.geometry.computeBoundingSphere();
  return proxy.geometry.boundingSphere.clone().applyMatrix4(proxy.matrixWorld);
};

test("touching an object with the controller grabs it without pointing at it", async () => {
  const app = setup();
  try {
    const sphere = ballSphere(app);
    app.aim(new Vector3(0, 4, -5)); // the ray points up and away
    app.xr.grips[0].position.copy(sphere.center).add(new Vector3(0, 0, sphere.radius + 0.04));
    app.step();
    assert.equal(app.input.pointingKeys[0], "object:ball", "offered by touch");
    app.press("squeezestart");
    await flush();
    assert.equal(app.viewer.held?.definition.id, "ball");
  } finally {
    app.dispose();
  }
});

test("a ray that just misses a small object still offers it", async () => {
  const app = setup();
  try {
    app.click(region("hide"));
    app.step();
    const sphere = ballSphere(app),
      eye = new Vector3(0, 1.6, 2);
    // Aim 2° outside the ball's edge, to its right.
    const toBall = sphere.center.clone().sub(eye),
      edge = Math.asin(sphere.radius / toBall.length());
    const dir = toBall
      .clone()
      .normalize()
      .applyAxisAngle(new Vector3(0, 1, 0), -(edge + (2 * Math.PI) / 180));
    app.aim(eye.clone().add(dir));
    app.step();
    assert.equal(app.input.pointingKeys[0], "object:ball");
    // Far outside the assist cone it is not.
    app.aim(
      eye.clone().add(
        toBall
          .clone()
          .normalize()
          .applyAxisAngle(new Vector3(0, 1, 0), -(edge + (8 * Math.PI) / 180)),
      ),
    );
    app.step();
    assert.equal(app.input.pointingKeys[0], "");
  } finally {
    app.dispose();
  }
});

test("grabbing while the memory plays freezes time first", async () => {
  const app = setup();
  try {
    app.click(region("hide"));
    app.step();
    app.viewer.togglePlay();
    assert.equal(app.viewer.timeline.playing, true);
    app.aim(app.ball);
    app.step();
    assert.equal(app.input.pointingKeys[0], "object:ball", "offered while playing");
    app.press("squeezestart");
    await flush();
    assert.equal(app.viewer.timeline.playing, false);
    assert.equal(app.viewer.held?.definition.id, "ball");
    assert.equal(app.viewer.timeline.branches.length, 2);
  } finally {
    app.dispose();
  }
});

test("placed objects can be picked up again without a new take, and walking is free while one waits for Play", async () => {
  const app = setup();
  try {
    app.click(region("hide"));
    app.step();
    app.aim(app.ball);
    app.press("squeezestart");
    await flush();
    app.xr.grips[0].position.x += 0.3;
    app.step();
    app.press("squeezeend");
    app.step();
    assert.equal(app.viewer.isPlaced, true);
    const at = app.viewer.held.root.position.clone();
    for (let i = 0; i < 20; i++) app.step();
    assert.ok(app.viewer.held.root.position.distanceTo(at) < 1e-9, "stays put while paused");
    // Pick it up again (it is under the ray where it was left): same take.
    app.aim(at);
    app.step();
    assert.equal(app.input.pointingKeys[0], "object:ball");
    app.press("squeezestart");
    await flush();
    assert.equal(app.viewer.isPlaced, false);
    assert.equal(app.viewer.timeline.branches.length, 2, "no new take");
    app.press("squeezeend");
    app.step();
    app.left.axes[3] = -1;
    const rig = app.rig.position.clone();
    app.step();
    assert.ok(app.rig.position.distanceTo(rig) > 0.001, "the stick walks while the object waits for Play");
  } finally {
    app.dispose();
  }
});
