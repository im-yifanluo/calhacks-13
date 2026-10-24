// The viewer hooks the network adapter (src/net/adapter.ts) relies on: Timeline.setRecording and Viewer.applyClock.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Group, Quaternion, Vector3 } from "three";
import { Timeline } from "../.test-dist/timeline.js";
import { initPhysics, STEP } from "../.test-dist/physics.js";
import { Viewer } from "../.test-dist/viewer.js";

const frame = (t, x, y = 1, z = 0) => ({ t, p: [x, y, z], q: [0, 0, 0, 1] });
const times = frames => frames.map(f => f.t);
const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const manifest = JSON.parse(await readFile(new URL("../public/mock/memory.json", import.meta.url)));
await initPhysics();

function fixture() {
  const definition = { ...structuredClone(manifest.objects[0]), collider: { kind: "sphere", radius: 0.12 }, track: [frame(0, 0), frame(6, 3)] };
  const object = { definition, root: new Group(), track: definition.track };
  const root = new Group(); root.add(object.root);
  const memory = { manifest: structuredClone(manifest), root, objects: [object], cameraTrack: [frame(0, 0)], roomGeometry: [], warnings: [], dispose() {} };
  return { memory, object };
}
async function settle(viewer) { for (let i = 0; i < 1200 && viewer.recording; i++) viewer.update(STEP); assert.equal(viewer.recording, false); }

test("setRecording replaces, copies and clears a branch's recording of one object", () => {
  const timeline = new Timeline(6);
  timeline.upsertBranch({ id: "7", parentId: "original", name: "Take", forkTime: 1 });
  const branch = timeline.branches.find(b => b.id === "7");
  timeline.appendRecording("7", "ball", [frame(1, 1), frame(2, 1), frame(3, 1)]);
  const frames = [{ ...frame(1.5, 7), v: [1, 2, 3] }, frame(2.5, 8)];
  timeline.setRecording("7", "ball", frames);
  assert.deepEqual(times(branch.tracks.get("ball")), [1.5, 2.5], "replaced, not merged");
  frames[0].p[0] = 99; frames[0].v[0] = 99;
  assert.equal(branch.tracks.get("ball")[0].p[0], 7, "stored a copy"); assert.equal(branch.tracks.get("ball")[0].v[0], 1);
  timeline.setRecording("7", "ball", null); assert.equal(branch.tracks.has("ball"), false);
  timeline.setRecording("7", "ball", [frame(1, 1)]); timeline.setRecording("7", "ball", []);
  assert.equal(branch.tracks.has("ball"), false, "an empty array clears too");
  timeline.setRecording("7", "cube", null); // clearing nothing is fine
});

test("setRecording accepts a branch's own frames before its fork time, inside the clip only", () => {
  const timeline = new Timeline(6);
  timeline.upsertBranch({ id: "7", parentId: "original", name: "Take", forkTime: 3 });
  timeline.setRecording("7", "ball", [frame(0, 1), frame(1, 2)]); // seek back on the take, grab: the server takes it
  timeline.select("7"); timeline.seek(0.5);
  assert.deepEqual(times(timeline.track("ball", [frame(0, 0)])), [0, 1], "the take's own edit replays before its fork time");
  for (const invalid of [[frame(2, 0), frame(1, 0)], [frame(1, NaN)], [frame(1, 0), frame(6.5, 0)], [frame(-1, 0)]]) {
    assert.throws(() => timeline.setRecording("7", "ball", invalid));
  }
  assert.deepEqual(times(timeline.branches.find(b => b.id === "7").tracks.get("ball")), [0, 1], "a rejected recording keeps the old one");
  assert.throws(() => timeline.setRecording("original", "ball", [frame(1, 0)]));
  assert.throws(() => timeline.setRecording("original", "ball", null));
  assert.throws(() => timeline.setRecording("missing", "ball", null));
});

test("networked grab: the server's fork clock row arriving inside acquire() does not cancel the grab", async () => {
  // jerry-p4's grab reducer forks and moves the room's timeline to the new branch in the same transaction, so a
  // network layer sees that timeline row, and may apply it, before acquire() resolves.
  const { memory } = fixture(); const viewer = new Viewer(memory, () => {}); const released = []; const events = [];
  const branch = { id: "7", parentId: "original", name: "First edit", forkTime: 1 };
  try {
    viewer.seek(1); viewer.subscribe(e => events.push(e.type));
    viewer.setAuthority({
      acquire: async request => {
        await null;
        viewer.applyClock(request.time, false, 1, viewer.timeline.activeId); // our own pause/seek, echoed
        viewer.timeline.upsertBranch(branch);
        viewer.applyClock(request.time + 0.0004, false, 1, "7"); // the fork row: same paused instant (µs rounding), new branch
        return { branch };
      },
      release: id => released.push(id),
    });
    assert.equal(await viewer.grab("ball-1"), true);
    assert.equal(viewer.held?.definition.id, "ball-1"); assert.deepEqual(released, []);
    assert.equal(viewer.timeline.activeId, "7"); close(viewer.timeline.time, 1);
    assert.ok(!events.includes("clock"), "applyClock never echoes a clock event");
    viewer.applyClock(1, false, 1, "7"); assert.equal(viewer.held?.definition.id, "ball-1", "a late duplicate is a no-op");
    viewer.moveHeld(new Vector3(0.4, 1.2, 0), new Quaternion(), 1 / 60); viewer.release(); await settle(viewer);
    assert.deepEqual(released, ["ball-1"]);
    assert.ok(viewer.timeline.branches.find(b => b.id === "7").tracks.get("ball-1").length > 2);
  } finally { viewer.dispose(); }
});

test("a different clock while a grab is pending (another player's seek or play) still cancels it", async () => {
  for (const [time, playing] of [[3, false], [1, true]]) {
    const { memory } = fixture(); const viewer = new Viewer(memory, () => {}); const released = [];
    try {
      viewer.seek(1);
      viewer.setAuthority({ acquire: async () => { await null; viewer.applyClock(time, playing, 1, "original"); return true; }, release: id => released.push(id) });
      assert.equal(await viewer.grab("ball-1"), false);
      assert.equal(viewer.held, null); assert.deepEqual(released, ["ball-1"]);
      close(viewer.timeline.time, time); assert.equal(viewer.timeline.playing, playing);
    } finally { viewer.dispose(); }
  }
});

test("an identical clock is a no-op: a held object stays held and a running preview keeps running", async () => {
  const { memory, object } = fixture(); const viewer = new Viewer(memory, () => {}); const events = [];
  try {
    viewer.seek(1); await viewer.grab("ball-1"); viewer.subscribe(e => events.push(e.type));
    viewer.applyClock(1.0005, false, 1, viewer.timeline.activeId);
    assert.equal(viewer.held?.definition.id, "ball-1"); assert.deepEqual(events, []);
    viewer.moveHeld(new Vector3(0.5, 2, 0), new Quaternion(), 1 / 60); viewer.release();
    for (let i = 0; i < 6; i++) viewer.update(STEP);
    const midair = object.root.position.clone();
    viewer.applyClock(1, false, 1, viewer.timeline.activeId);
    assert.equal(viewer.recording, true, "the preview is not finished by an echo");
    assert.ok(object.root.position.distanceTo(midair) < 1e-9);
    viewer.applyClock(2, false, 1, viewer.timeline.activeId); // a genuine change finishes it
    assert.equal(viewer.recording, false); close(viewer.timeline.time, 2);
  } finally { viewer.dispose(); }
});

test("an unknown branch in a clock is reported and ignored, never thrown; invalid numbers are ignored", async () => {
  const { memory } = fixture(); const reports = []; const viewer = new Viewer(memory, message => reports.push(message));
  try {
    viewer.seek(1); await viewer.grab("ball-1");
    assert.doesNotThrow(() => viewer.applyClock(4, true, 1, "99"));
    assert.ok(reports.at(-1).includes("99"));
    assert.equal(viewer.held?.definition.id, "ball-1"); close(viewer.timeline.time, 1); assert.equal(viewer.timeline.playing, false);
    for (const [time, speed] of [[NaN, 1], [1, 0], [1, -1], [Infinity, 1]]) viewer.applyClock(time, true, speed);
    assert.equal(viewer.timeline.playing, false);
  } finally { viewer.dispose(); }
});

test("setAuthority(undefined) returns the viewer to local takes", async () => {
  const { memory } = fixture(); const viewer = new Viewer(memory, () => {});
  try {
    viewer.setAuthority({ acquire: async () => false, release() {} }); viewer.seek(1);
    assert.equal(await viewer.grab("ball-1"), false);
    viewer.setAuthority(undefined);
    assert.equal(await viewer.grab("ball-1"), true); assert.match(viewer.timeline.activeId, /^local-/);
  } finally { viewer.dispose(); }
});
