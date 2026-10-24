// The VR follow panel (vr-panel.ts): layout hit testing, the scrubber and the lazy-follow rule, without a headset.
import test from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { FOLLOW, hitRegion, needsRecenter, PANEL, panelTarget, REGIONS, scrubTime } from "../.test-dist/vr-panel.js";

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
/** uv of a canvas pixel (three's PlaneGeometry uv: origin bottom-left). */
const uv = (x, y) => [x / PANEL.width, 1 - y / PANEL.height];

test("every region is hit at its centre, and the gaps between them hit nothing", () => {
  for (const region of REGIONS) assert.equal(hitRegion(...uv(region.x + region.w / 2, region.y + region.h / 2)), region.id);
  assert.equal(hitRegion(...uv(208, 60)), null); // between Play and −1 s
  assert.equal(hitRegion(...uv(600, 60)), null); // the time readout is not a button
  assert.equal(hitRegion(...uv(400, 340)), null); // the status line
  assert.equal(hitRegion(...uv(2, 2)), null);
});

test("the panel's top row is at the top of the plane (uv v = 1 is the canvas top)", () => {
  assert.equal(hitRegion(100 / PANEL.width, 0.85), "play"); // pixel row 58, inside Play (rows 20-108)
  assert.equal(hitRegion(60 / PANEL.width, 0.3), "prev-take"); // pixel row 269, inside the take row (rows 212-300)
  assert.equal(hitRegion(100 / PANEL.width, 0.97), null); // pixel row 12, the margin above the buttons
});

test("the scrubber maps its track ends to the clip ends and clamps beyond them", () => {
  close(scrubTime(56 / PANEL.width, 6), 0);
  close(scrubTime(968 / PANEL.width, 6), 6);
  close(scrubTime((56 + 968) / 2 / PANEL.width, 6), 3);
  close(scrubTime(0, 6), 0);
  close(scrubTime(1, 6), 6);
});

test("the panel sits 0.85 m ahead along the horizontal view and 0.3 m below the eyes", () => {
  const spot = panelTarget(new Vector3(1, 1.6, 2), new Vector3(0, 0, -1));
  close(spot.x, 1); close(spot.y, 1.6 - FOLLOW.drop); close(spot.z, 2 - FOLLOW.distance);
});

test("lazy follow: small turns and steps keep the panel put; turning past 35° or walking 0.5 m re-centres it", () => {
  const head = new Vector3(0, 1.6, 0), forward = new Vector3(0, 0, -1);
  const panel = panelTarget(head, forward);
  const turned = deg => new Vector3(-Math.sin(deg * Math.PI / 180), 0, -Math.cos(deg * Math.PI / 180));
  assert.equal(needsRecenter(panel, head, forward, head), false);
  assert.equal(needsRecenter(panel, head, turned(30), head), false);
  assert.equal(needsRecenter(panel, head, turned(40), head), true);
  assert.equal(needsRecenter(panel, head, turned(-120), head), true);
  assert.equal(needsRecenter(panel, new Vector3(0.3, 1.6, 0), forward, head), false);
  assert.equal(needsRecenter(panel, new Vector3(0.6, 1.6, 0), forward, head), true);
  assert.equal(needsRecenter(panel, new Vector3(0, 1.6, 0.6), forward, head), true, "walking backwards away from it");
  // Looking up or down (the forward stays horizontal) never moves it.
  assert.equal(needsRecenter(panel, new Vector3(0, 1.2, 0), forward, head), false, "crouching");
});
