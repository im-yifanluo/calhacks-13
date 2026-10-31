import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Group, Object3D, Quaternion, Vector3 } from "three";
import { sampleTrack, trackVelocity, validateTrack } from "../src/tracks";
import { Timeline } from "../src/timeline";
import { initPhysics, Physics, STEP } from "../src/physics";
import { validateManifest } from "../src/loader";
import { Viewer } from "../src/viewer";

const frame = (t, x, y = 1, z = 0) => ({ t, p: [x, y, z], q: [0, 0, 0, 1] });
const track = [frame(0, 0), { ...frame(2, 2), q: [0, 1, 0, 0], s: 2 }];
const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const manifest = JSON.parse(await readFile(new URL("../public/mock/memory.json", import.meta.url)));
await initPhysics();

function fixture() {
  const definition = {
    ...structuredClone(manifest.objects[0]),
    collider: { kind: "sphere", radius: 0.12 },
    track: [frame(0, 0), frame(6, 3)],
  };
  const object = { definition, root: new Group(), track: definition.track };
  const root = new Group();
  root.add(object.root);
  const memory = {
    manifest: structuredClone(manifest),
    root,
    objects: [object],
    cameraTrack: [frame(0, 0)],
    roomGeometry: [],
    warnings: [],
    dispose() {},
  };
  return { memory, object };
}

test("track clamps endpoints, interpolates translation, normalized rotation, and scale", () => {
  const object = new Object3D();
  sampleTrack(track, -5, object);
  close(object.position.x, 0);
  close(object.scale.x, 1);
  sampleTrack(track, 1, object);
  close(object.position.x, 1);
  close(object.scale.x, 1.5);
  close(object.quaternion.y, Math.SQRT1_2);
  close(object.quaternion.w, Math.SQRT1_2);
  sampleTrack(track, 9, object);
  close(object.position.x, 2);
  close(object.scale.x, 2);
  sampleTrack([frame(0, 3)], 4, object);
  close(object.position.x, 3);
});

test("track validation rejects duplicate times, nonfinite values, empty tracks, and zero quaternions", () => {
  for (const invalid of [[], [frame(0, 0), frame(0, 2)], [frame(0, NaN)], [{ ...frame(0, 1), q: [0, 0, 0, 0] }]]) {
    assert.throws(() => validateTrack(invalid));
  }
  validateTrack(track);
});

test("track velocity preserves momentum and is zero outside the recorded interval", () => {
  close(trackVelocity(track, 1).x, 1);
  close(trackVelocity(track, 2).length(), 0);
  close(trackVelocity(track, -1).length(), 0);
  close(trackVelocity([frame(0, 0)], 0).length(), 0);
});

test("forks inherit earlier history and untouched objects without mutating their parent", () => {
  const timeline = new Timeline(6);
  timeline.seek(2);
  const parent = timeline.fork();
  const parentTrack = [frame(2, 5), frame(3, 6)];
  parent.tracks.set("ball", parentTrack);
  timeline.seek(3);
  const child = timeline.fork();
  const childTrack = [frame(3, 7), frame(4, 8)];
  child.tracks.set("ball", childTrack);
  assert.equal(timeline.track("ball", track, 1), track);
  assert.equal(timeline.track("ball", track, 2.5), parentTrack);
  assert.equal(timeline.track("ball", track, 4), childTrack);
  assert.equal(timeline.track("cup", track, 4), track);
  timeline.select(parent.id);
  assert.equal(timeline.track("ball", track, 4), parentTrack);
  timeline.select("original");
  assert.equal(timeline.track("ball", track, 4), track);
});

test("clock pauses, clamps seeking, and stops at the end instead of wrapping a throw", () => {
  const timeline = new Timeline(6);
  timeline.tick(2);
  close(timeline.time, 2);
  timeline.playing = false;
  timeline.tick(10);
  close(timeline.time, 2);
  timeline.seek(-3);
  close(timeline.time, 0);
  timeline.seek(99);
  close(timeline.time, 6);
  timeline.seek(5);
  timeline.playing = true;
  timeline.tick(3);
  close(timeline.time, 6);
  assert.equal(timeline.playing, false);
});

test("late join imports branch ancestors and overlapping recording chunks without changing original", () => {
  const timeline = new Timeline(6);
  timeline.upsertBranch({ id: "10", parentId: "original", name: "Remote take", forkTime: 1 });
  timeline.appendRecording("10", "ball", [frame(1, 2), frame(2, 3)]);
  timeline.appendRecording("10", "ball", [frame(2, 3), frame(3, 4)]);
  timeline.upsertBranch({ id: "11", parentId: "10", name: "Child take", forkTime: 2 });
  timeline.select("11");
  assert.equal(timeline.track("ball", track, 2).length, 3);
  assert.equal(timeline.track("ball", track, 0), track);
  assert.throws(() => timeline.upsertBranch({ id: "10", parentId: "11", name: "cycle", forkTime: 1 }));
  assert.throws(() => timeline.appendRecording("original", "ball", [frame(1, 2)]));
  assert.throws(() => timeline.appendRecording("10", "ball", [frame(0, 2)]));
});

test("incoming clocks select known branches without emitting clock echoes", () => {
  const { memory } = fixture();
  const viewer = new Viewer(memory, () => {});
  const events = [];
  try {
    viewer.subscribe((event) => events.push(event));
    viewer.timeline.upsertBranch({ id: "12", parentId: "original", name: "Remote", forkTime: 1 });
    viewer.applyClock(2, true, 0.5, "12");
    viewer.update(1);
    assert.equal(viewer.timeline.activeId, "12");
    close(viewer.timeline.time, 2.5);
    assert.equal(events.length, 0);
  } finally {
    viewer.dispose();
  }
});

test("manifest rejects unsupported world frames, invalid colliders, and duplicate object ids", () => {
  validateManifest(manifest);
  const badWorld = structuredClone(manifest);
  badWorld.world.up = "-y";
  assert.throws(() => validateManifest(badWorld));
  const badCollider = structuredClone(manifest);
  badCollider.objects[0].collider = { kind: "sphere", radius: -1 };
  assert.throws(() => validateManifest(badCollider));
  const duplicates = structuredClone(manifest);
  duplicates.objects.push(duplicates.objects[0]);
  assert.throws(() => validateManifest(duplicates));
});

test("real Rapier simulation collides with a raised floor and clears bodies safely", () => {
  const { object } = fixture();
  object.root.position.set(0, 2, 0);
  const physics = new Physics(0.5, []);
  try {
    physics.add(object, new Vector3(), true);
    for (let i = 0; i < 360; i++) physics.step();
    close(object.root.position.y, 0.62, 0.02);
    physics.clear();
    assert.equal(physics.bodies.size, 0);
  } finally {
    physics.dispose();
  }
});

test("sphere, box, capsule, cylinder, and convex hull colliders all support scaled bodies", () => {
  for (const shape of [
    { kind: "sphere", radius: 0.1 },
    { kind: "box", halfExtents: [0.1, 0.1, 0.1] },
    { kind: "capsule", radius: 0.1, halfHeight: 0.2 },
    { kind: "cylinder", radius: 0.1, halfHeight: 0.2 },
    { kind: "convex", url: "hull.glb" },
  ]) {
    const { object } = fixture();
    object.definition.collider = shape;
    object.root.position.y = 2;
    object.root.scale.setScalar(2);
    object.hull = new Float32Array([-0.1, 0, -0.1, 0.1, 0, -0.1, 0, 0, 0.1, 0, 0.2, 0]);
    const physics = new Physics(0, []);
    try {
      physics.add(object, new Vector3(), true);
      for (let i = 0; i < 180; i++) physics.step();
      assert.ok(object.root.position.y >= -0.02);
    } finally {
      physics.dispose();
    }
  }
});

test("paused grab creates a branch; release records physics; original and replay stay distinct", async () => {
  const { memory, object } = fixture();
  const events = [];
  const viewer = new Viewer(memory, () => {});
  viewer.subscribe((e) => events.push(e));
  try {
    assert.equal(await viewer.grab(object.definition.id), false, "cannot edit while playing");
    viewer.seek(1);
    const original = object.root.position.clone();
    assert.equal(await viewer.grab(object.definition.id), true);
    const branchId = viewer.timeline.activeId;
    viewer.moveHeld(new Vector3(-1, 2, 0), new Quaternion(), 1 / 60);
    viewer.release();
    for (let i = 0; i < 360; i++) viewer.update(STEP);
    const saved = viewer.timeline.active.tracks.get(object.definition.id);
    assert.ok(saved.length > 2);
    assert.ok(saved.every((f, i) => i === 0 || f.t > saved[i - 1].t));
    assert.ok(events.some((e) => e.type === "recording"));
    assert.ok(events.some((e) => e.type === "rest"));
    viewer.seek(2);
    const firstReplay = object.root.position.clone();
    viewer.seek(1);
    viewer.seek(2);
    assert.ok(object.root.position.distanceTo(firstReplay) < 1e-6);
    viewer.selectBranch("original");
    viewer.seek(1);
    assert.ok(object.root.position.distanceTo(original) < 1e-6);
    viewer.selectBranch(branchId);
    viewer.seek(2);
    assert.ok(object.root.position.distanceTo(firstReplay) < 1e-6);
    assert.equal(viewer.physics.bodies.size, 0);
  } finally {
    viewer.dispose();
  }
});

test("ownership rejection never forks; a late grant after seeking is released", async () => {
  const { memory, object } = fixture();
  const viewer = new Viewer(memory, () => {});
  try {
    viewer.seek(1);
    viewer.setAuthority({ acquire: async () => false, release() {} });
    assert.equal(await viewer.grab(object.definition.id), false);
    assert.equal(viewer.timeline.branches.length, 1);
    let grant;
    const released = [];
    viewer.setAuthority({
      acquire: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
      release: (id) => released.push(id),
    });
    const pending = viewer.grab(object.definition.id);
    viewer.seek(3);
    grant(true);
    assert.equal(await pending, false);
    assert.deepEqual(released, [object.definition.id]);
    assert.equal(viewer.timeline.branches.length, 1);
  } finally {
    viewer.dispose();
  }
});

test("simulation ownership is retained after hand release until recording completes", async () => {
  const { memory, object } = fixture();
  const viewer = new Viewer(memory, () => {});
  const released = [];
  try {
    viewer.setAuthority({ acquire: async () => true, release: (id) => released.push(id) });
    viewer.seek(1);
    await viewer.grab(object.definition.id);
    viewer.release();
    assert.equal(released.length, 0);
    viewer.togglePlay();
    assert.deepEqual(released, [object.definition.id]);
    assert.equal(viewer.timeline.playing, true);
  } finally {
    viewer.dispose();
  }
});

test("network grants use the canonical server branch instead of creating a local duplicate", async () => {
  const { memory, object } = fixture();
  const viewer = new Viewer(memory, () => {});
  try {
    viewer.seek(1);
    viewer.setAuthority({
      acquire: async () => ({ branch: { id: "42", parentId: "original", name: "Shared take", forkTime: 1 } }),
      release() {},
    });
    assert.equal(await viewer.grab(object.definition.id), true);
    assert.equal(viewer.timeline.activeId, "42");
    assert.equal(viewer.timeline.branches.length, 2);
    viewer.release();
    viewer.togglePlay();
    assert.ok(viewer.timeline.active.tracks.get(object.definition.id).length > 1);
  } finally {
    viewer.dispose();
  }
});

test("catching a local preview forks at its preview time without jumping to the initial release pose", async () => {
  const { memory, object } = fixture();
  const viewer = new Viewer(memory, () => {});
  try {
    viewer.seek(1);
    await viewer.grab(object.definition.id);
    viewer.release();
    for (let i = 0; i < 12; i++) viewer.update(STEP);
    const caught = object.root.position.clone();
    assert.equal(await viewer.grab(object.definition.id), true);
    close(viewer.timeline.time, 1.2);
    assert.ok(object.root.position.distanceTo(caught) < 1e-5);
    assert.equal(viewer.timeline.branches.length, 3);
  } finally {
    viewer.dispose();
  }
});

test("ownership revocation emits the recorded prefix and stops all later local pose/rest writes", async () => {
  const { memory, object } = fixture();
  const viewer = new Viewer(memory, () => {});
  const events = [];
  const releases = [];
  try {
    viewer.setAuthority({ acquire: async () => true, release: (id) => releases.push(id) });
    viewer.subscribe((e) => events.push(e));
    viewer.seek(1);
    await viewer.grab(object.definition.id);
    viewer.release();
    for (let i = 0; i < 12; i++) viewer.update(STEP);
    viewer.revokeOwnership(object.definition.id);
    assert.equal(events.at(-1).type, "recording");
    const count = events.length;
    for (let i = 0; i < 120; i++) viewer.update(STEP);
    assert.equal(events.length, count);
    assert.equal(releases.length, 0);
    assert.equal(viewer.recording, false);
  } finally {
    viewer.dispose();
  }
});

test("editing an existing canonical branch retains the prior recorded prefix", async () => {
  const { memory, object } = fixture();
  const viewer = new Viewer(memory, () => {});
  const branch = { id: "42", parentId: "original", name: "Shared take", forkTime: 1 };
  try {
    viewer.timeline.upsertBranch(branch);
    viewer.timeline.appendRecording("42", object.definition.id, [frame(1, 5), frame(2, 6), frame(3, 7)]);
    viewer.applyClock(2, false, 1, "42");
    viewer.setAuthority({ acquire: async () => ({ branch }), release() {} });
    await viewer.grab(object.definition.id);
    viewer.release();
    viewer.togglePlay();
    const saved = viewer.timeline.active.tracks.get(object.definition.id);
    close(saved[0].t, 1);
    close(saved[0].p[0], 5);
    assert.ok(saved.some((f) => f.t > 2));
    assert.ok(saved.every((f, i) => i === 0 || f.t > saved[i - 1].t));
  } finally {
    viewer.dispose();
  }
});
