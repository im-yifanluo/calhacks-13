// The VR panel (vr-panel.ts): layout hit testing, sizes from the design brief, the scrubber, the lazy-follow rule, and
// dragging it by its bar, without a headset.
import test from "node:test";
import assert from "node:assert/strict";
import { Group, Quaternion, Ray, Vector3 } from "three";
import {
  BODY, blocksRay, COMPACT_REGIONS, FOLLOW, HELP_REGIONS, hitRegion, needsRecenter, PANEL, PANEL_METERS_HIGH, panelTarget,
  REGIONS, scrubTime, VRPanel,
} from "../.test-dist/vr-panel.js";

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
/** uv of a canvas pixel (three's PlaneGeometry uv: origin bottom-left). */
const uv = (x, y) => [x / PANEL.width, 1 - y / PANEL.height];
const deg = radians => radians * 180 / Math.PI;

// The canvas is the only browser piece; drawing calls do nothing.
const context = new Proxy({ measureText: value => ({ width: value.length * 15 }), createLinearGradient: () => ({ addColorStop() {} }) },
  { get: (target, key) => key in target ? target[key] : () => {}, set: () => true });
globalThis.document = { createElement: () => ({ getContext: () => context, width: 0, height: 0 }) };

test("every region is hit at its centre in each mode, and the gaps between them hit nothing", () => {
  for (const [mode, regions] of [["full", REGIONS], ["help", HELP_REGIONS], ["compact", COMPACT_REGIONS]])
    for (const region of regions) assert.equal(hitRegion(...uv(region.x + region.w / 2, region.y + region.h / 2), mode), region.id, `${mode} ${region.id}`);
  assert.equal(hitRegion(...uv(248, 184)), null); // between Play and −1 s
  assert.equal(hitRegion(...uv(800, 184)), null); // the time readout is not a button
  assert.equal(hitRegion(...uv(400, 456)), null); // the status line
  assert.equal(hitRegion(...uv(300, 80)), null); // the title
  assert.equal(hitRegion(...uv(100, 184), "help"), null, "the help page has no Play button");
  assert.equal(hitRegion(...uv(100, 184), "compact"), null);
});

test("targets follow the brief: Play 96 px, others 80 px or more, at least 16 px apart", () => {
  for (const regions of [REGIONS, HELP_REGIONS, COMPACT_REGIONS]) {
    for (const r of regions) assert.ok(Math.min(r.w, r.h) >= 80, `${r.id} is ${r.w}×${r.h}`);
    for (const a of regions) for (const b of regions) {
      if (a === b) continue;
      const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      assert.ok(Math.max(dx, dy) >= 16, `${a.id} and ${b.id} are ${Math.max(dx, dy)} px apart`);
    }
  }
  assert.equal(REGIONS.find(r => r.id === "play").h, 96);
});

test("the panel's header is at the top of the plane (uv v = 1 is the canvas top)", () => {
  assert.equal(hitRegion(800 / PANEL.width, 1 - 80 / PANEL.height), "help");
  assert.equal(hitRegion(100 / PANEL.width, 1 - 184 / PANEL.height), "play");
  assert.equal(hitRegion(60 / PANEL.width, 1 - 384 / PANEL.height), "prev-take");
  assert.equal(hitRegion(100 / PANEL.width, 0.99), null); // the clear margin above the glass
});

test("rays stop at the glass but pass the clear margin, and a hidden panel lets everything through but its pill", () => {
  assert.equal(blocksRay(...uv(400, 456)), true, "blank glass blocks: no grabbing through the panel");
  assert.equal(blocksRay(...uv(10, 200)), false, "the shadow margin");
  assert.equal(blocksRay(...uv(BODY.x + 2, BODY.y + 2)), true);
  assert.equal(blocksRay(...uv(400, 200), "compact"), false);
  const pill = COMPACT_REGIONS[0];
  assert.equal(blocksRay(...uv(pill.x + pill.w / 2, pill.y + pill.h / 2), "compact"), true);
});

test("the scrubber maps its track ends to the clip ends and clamps beyond them", () => {
  close(scrubTime(72 / PANEL.width, 6), 0);
  close(scrubTime(952 / PANEL.width, 6), 6);
  close(scrubTime((72 + 952) / 2 / PANEL.width, 6), 3);
  close(scrubTime(0, 6), 0);
  close(scrubTime(1, 6), 6);
});

test("the panel opens 1.2 m ahead and 0.3 m down: about 14° below the eyes, 33° wide, ~31 canvas px per degree", () => {
  const head = new Vector3(1, 1.6, 2), spot = panelTarget(head, new Vector3(0, 0, -1));
  close(spot.x, 1); close(spot.y, 1.6 - FOLLOW.drop); close(spot.z, 2 - FOLLOW.distance);
  const sight = Math.hypot(FOLLOW.distance, FOLLOW.drop);
  const below = deg(Math.atan2(FOLLOW.drop, FOLLOW.distance)), wide = deg(2 * Math.atan(PANEL.metersWide / 2 / sight));
  assert.ok(below > 10 && below < 20, `${below}° below eye level`);
  assert.ok(wide > 30 && wide < 36, `${wide}° wide`);
  assert.ok(sight > 0.8, "outside the 0.5–0.8 m middle distance");
  const perDegree = PANEL.width / wide;
  assert.ok(24 / perDegree > 0.7, "the smallest text (24 px) is over 0.7°");
  assert.ok(80 / perDegree > 2.5, "an 80 px target is over 2.5°");
  close(PANEL_METERS_HIGH / PANEL.metersWide, PANEL.height / PANEL.width);
});

test("lazy follow: small turns and steps keep the panel put; turning past 30° or walking 0.5 m re-centres it", () => {
  const head = new Vector3(0, 1.6, 0), forward = new Vector3(0, 0, -1);
  const panel = panelTarget(head, forward);
  const turned = degrees => new Vector3(-Math.sin(degrees * Math.PI / 180), 0, -Math.cos(degrees * Math.PI / 180));
  assert.equal(needsRecenter(panel, head, forward, head), false);
  assert.equal(needsRecenter(panel, head, turned(25), head), false);
  assert.equal(needsRecenter(panel, head, turned(35), head), true);
  assert.equal(needsRecenter(panel, head, turned(-120), head), true);
  assert.equal(needsRecenter(panel, new Vector3(0.3, 1.6, 0), forward, head), false);
  assert.equal(needsRecenter(panel, new Vector3(0.6, 1.6, 0), forward, head), true);
  assert.equal(needsRecenter(panel, new Vector3(0, 1.6, 0.6), forward, head), true, "walking backwards away from it");
  assert.equal(needsRecenter(panel, new Vector3(0, 1.2, 0), forward, head), false, "crouching");
});

/** A panel under a rig that has been moved and turned, as after spawning at the wearer's first pose. */
function rigged() {
  const scene = new Group(), rig = new Group(); scene.add(rig);
  rig.position.set(2, 0, -1); rig.rotation.y = Math.PI / 3; scene.updateMatrixWorld(true);
  const panel = new VRPanel(rig);
  const head = new Vector3(0, 1.6, 0), forward = new Vector3(0, 0, -1);
  panel.follow(head, forward, 1 / 90);
  return { rig, panel, head, forward, eye: rig.localToWorld(head.clone()) };
}
const worldOf = (panel, x, y) => panel.mesh.localToWorld(new Vector3((x / PANEL.width - 0.5) * PANEL.metersWide, (0.5 - y / PANEL.height) * PANEL_METERS_HIGH, 0));

test("the panel is placed in the rig's frame and faces the eyes", () => {
  const { panel, head } = rigged();
  close(panel.mesh.position.x, 0, 1e-9); close(panel.mesh.position.z, -FOLLOW.distance, 1e-9); close(panel.mesh.position.y, head.y - FOLLOW.drop, 1e-9);
  // Its normal (+z) points back at the eye.
  const normal = new Vector3(0, 0, 1).applyQuaternion(panel.mesh.quaternion);
  const toEye = head.clone().sub(panel.mesh.position).normalize();
  close(normal.dot(toEye), 1, 1e-9);
});

test("while a ray is on it (hold), turning away does not move it", () => {
  const { panel, head } = rigged();
  const before = panel.mesh.position.clone();
  const away = new Vector3(-1, 0, 0);
  for (let i = 0; i < 30; i++) panel.follow(head, away, 1 / 90, true);
  close(panel.mesh.position.distanceTo(before), 0, 1e-12);
  for (let i = 0; i < 200; i++) panel.follow(head, away, 1 / 90, false);
  close(panel.mesh.position.x, -FOLLOW.distance, 1e-3);
});

test("dragging by the bar keeps the grabbed spot under the ray, the stick pushes it away, and it stays where dropped", () => {
  const { panel, head, forward, eye } = rigged();
  const grabbed = worldOf(panel, 512, 500);
  const hand = eye.clone().add(new Vector3(0.2, -0.4, 0));
  const ray = new Ray(hand, grabbed.clone().sub(hand).normalize());
  panel.beginDrag(ray, grabbed);
  assert.equal(panel.isDragging, true);
  // Swing the ray 25° to the right and pull the stick back (push < 0) for half a second.
  const swung = ray.direction.clone().applyAxisAngle(new Vector3(0, 1, 0), -25 * Math.PI / 180);
  const moved = new Ray(hand, swung);
  const distance = hand.distanceTo(grabbed);
  for (let i = 0; i < 45; i++) panel.dragTo(moved, eye, -1, 1 / 90);
  const expected = moved.at(Math.max(0.6, distance - 1.2 * 0.5), new Vector3());
  panel.mesh.updateWorldMatrix(true, false);
  close(worldOf(panel, 512, 500).distanceTo(expected), 0, 2e-3);
  const normal = new Vector3(0, 0, 1).applyQuaternion(panel.mesh.getWorldQuaternion(new Quaternion()));
  const toEye = eye.clone().sub(panel.mesh.getWorldPosition(new Vector3())).normalize();
  close(normal.dot(toEye), 1, 1e-6);
  panel.endDrag();
  assert.equal(panel.pinned, true);
  // Pinned: turning and walking away no longer move it.
  const dropped = panel.mesh.position.clone();
  for (let i = 0; i < 100; i++) panel.follow(new Vector3(1, 1.6, 1), new Vector3(1, 0, 0), 1 / 90);
  close(panel.mesh.position.distanceTo(dropped), 0, 1e-12);
  // Recenter brings it back in front and following again.
  panel.recenter(); panel.follow(head, forward, 1 / 90);
  assert.equal(panel.pinned, false);
  close(panel.mesh.position.z, -FOLLOW.distance, 1e-9);
});

test("the stick cannot push the panel nearer than 0.6 m or farther than 3 m", () => {
  const { panel, eye } = rigged();
  const grabbed = worldOf(panel, 512, 500), ray = new Ray(eye.clone(), grabbed.clone().sub(eye).normalize());
  panel.beginDrag(ray, grabbed);
  for (let i = 0; i < 400; i++) panel.dragTo(ray, eye, 1, 1 / 90);
  close(worldOf(panel, 512, 500).distanceTo(eye), 3, 1e-3);
  for (let i = 0; i < 400; i++) panel.dragTo(ray, eye, -1, 1 / 90);
  close(worldOf(panel, 512, 500).distanceTo(eye), 0.6, 1e-3);
});
