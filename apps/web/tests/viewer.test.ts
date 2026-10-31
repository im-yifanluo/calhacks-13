// Viewer behaviour: ghosts, keyframe v, visibility, the held final pose, revocation, the status line, the floor.
import { test } from "vitest";
import assert from "node:assert/strict";
import { Euler, Group, Quaternion, Vector3 } from "three";
import type { DynamicObject, Keyframe } from "@memreplay/shared";
import { colliderDepth, initPhysics, STEP } from "../src/engine/physics";
import { type LoadedMemory, type LoadedObject, validateManifest } from "../src/engine/loader";
import { AT_END, type GrabRequest, Viewer, type ViewerEvent, isGhost } from "../src/engine/viewer";
import { approx, type Definition, frame, mockManifest, settle } from "./helpers";

const { close } = approx(1e-5);
const manifest = await mockManifest();
await initPhysics();
/** The events that carry an object's pose and velocity at a grab, a throw or a rest. */
type ObjectEvent = Extract<ViewerEvent, { type: "grab" | "throw" | "rest" }>;

function build(definitions: Definition[], durationSec = 6): { memory: LoadedMemory; objects: LoadedObject[] } {
  const root = new Group();
  const objects = definitions.map((definition) => {
    const object = { definition, root: new Group(), track: definition.track };
    root.add(object.root);
    return object;
  });
  const memoryManifest = {
    ...structuredClone(manifest),
    timeline: { durationSec, sampleHz: 10 },
    objects: definitions,
  };
  validateManifest(memoryManifest);
  return {
    memory: {
      manifest: memoryManifest,
      root,
      objects,
      cameraTrack: [frame(0, 0)],
      roomGeometry: [],
      warnings: [],
      dispose() {},
    },
    objects,
  };
}
const ball = (track: Keyframe[], extra: Partial<Definition> = {}): Definition => ({
  id: "ball",
  label: "ball",
  visual: { kind: "primitive", shape: "sphere", size: [0.2, 0.2, 0.2], color: "#fff" },
  collider: { kind: "sphere", radius: 0.1 },
  mass: 0.4,
  grabbable: true,
  visibleFrom: 0,
  visibleTo: 6,
  track,
  ...extra,
});
const can: Definition = {
  id: "can",
  label: "can",
  visual: { kind: "primitive", shape: "cylinder", size: [0.13, 0.24, 0.13], color: "#fff" },
  collider: { kind: "cylinder", halfHeight: 0.12, radius: 0.065 },
  mass: 0.8,
  grabbable: true,
  visibleFrom: 0,
  visibleTo: 6,
  track: [frame(0, 1, 0.12, 0), frame(6, 1, 0.12, 0)],
};
const ghost: Definition = {
  id: "person-0",
  label: "person",
  visual: { kind: "points-sequence", url: "world/ghosts/person-0.bin", frameCount: 60, sampleHz: 10 },
  collider: { kind: "capsule", halfHeight: 0.6, radius: 0.25 },
  mass: 0,
  grabbable: false,
  visibleFrom: 0,
  visibleTo: 6,
  track: [{ t: 0, p: [0, 0, 0], q: [0, 0, 0, 1] }],
};
const still = (y = 1) => ball([frame(0, 0, y, 0), frame(6, 0, y, 0)]);
/** Grab, move the hand once, throw, and let the preview come to rest. */
async function throwBall(viewer: Viewer, to = new Vector3(0.2, 1.5, 0)) {
  assert.equal(await viewer.grab("ball"), true);
  viewer.moveHeld(to, new Quaternion(), 1 / 60);
  viewer.release();
  await settle(viewer);
}

test("ghosts take no part in physics or picking: no phantom collider at their origin", async () => {
  assert.equal(isGhost(ghost), true);
  assert.equal(
    isGhost({ ...ghost, visual: { kind: "primitive", shape: "box", size: [1, 1, 1], color: "#fff" } }),
    true,
    "not grabbable, mass 0",
  );
  assert.equal(isGhost(still()), false);
  assert.equal(isGhost({ ...still(), grabbable: false, mass: 30 }), false, "a heavy fixed object is still an obstacle");
  const rests = [];
  for (const withGhost of [false, true]) {
    // The ball drops from above the ghost's identity-track origin, where its capsule collider used to catch it.
    const { memory } = build(withGhost ? [still(3), ghost] : [still(3)]);
    const viewer = new Viewer(memory, () => {});
    try {
      assert.equal(viewer.pickables.length, 1);
      viewer.seek(1);
      assert.equal(await viewer.grab("ball"), true);
      assert.equal(viewer.physics.bodies.has("person-0"), false);
      viewer.release();
      await settle(viewer);
      rests.push(viewer.timeline.active.tracks.get("ball")!.at(-1)!.p[1]);
    } finally {
      viewer.dispose();
    }
  }
  close(rests[0], 0.1, 0.02);
  close(rests[1], rests[0], 1e-6);
});

test("a grab hands physics the active keyframe's v, interpolated, instead of the finite difference", async () => {
  const { memory } = build([
    ball([
      frame(0, 0, 1, 0, { v: [2, 0, 0] }),
      frame(2, 0, 1, 0, { v: [4, 0, 0] }),
      frame(6, 0, 1, 0, { v: [4, 0, 0] }),
    ]),
  ]);
  const viewer = new Viewer(memory, () => {});
  const events: ViewerEvent[] = [];
  viewer.subscribe((e) => events.push(e));
  try {
    viewer.seek(1);
    await viewer.grab("ball");
    assert.deepEqual(
      events.find((e): e is ObjectEvent => e.type === "grab")!.velocity.map((x) => +x.toFixed(6)),
      [3, 0, 0],
    );
    close(viewer.physics.bodies.get("ball")!.body.linvel().x, 3); // the seeded body carries it too
    viewer.release(); // a still hand keeps the recorded momentum
    assert.deepEqual(
      events.find((e): e is ObjectEvent => e.type === "throw")!.velocity.map((x) => +x.toFixed(6)),
      [3, 0, 0],
    );
  } finally {
    viewer.dispose();
  }
});

test("a grab without v still uses the track's finite difference", async () => {
  const { memory } = build([ball([frame(0, 0), frame(6, 3)])]);
  const viewer = new Viewer(memory, () => {});
  const events: ViewerEvent[] = [];
  viewer.subscribe((e) => events.push(e));
  try {
    viewer.seek(1);
    await viewer.grab("ball");
    assert.deepEqual(
      events.find((e): e is ObjectEvent => e.type === "grab")!.velocity.map((x) => +x.toFixed(6)),
      [0.5, 0, 0],
    );
  } finally {
    viewer.dispose();
  }
});

test("an object stays visible past visibleTo while a take's recording drives it; the original still hides it", async () => {
  const { memory, objects } = build([ball([frame(0, 0, 0.1), frame(6, 0, 0.1)], { visibleTo: 3 })]);
  const viewer = new Viewer(memory, () => {});
  try {
    viewer.seek(2.5);
    await throwBall(viewer);
    const take = viewer.timeline.activeId;
    viewer.seek(2.9);
    assert.equal(objects[0].root.visible, true);
    viewer.seek(3.5);
    assert.equal(objects[0].root.visible, true, "its recording drives it");
    viewer.seek(5.9);
    assert.equal(objects[0].root.visible, true, "and holds its final pose until the end");
    viewer.seek(2);
    assert.equal(objects[0].root.visible, true, "before the edit it is the original, still visible");
    viewer.selectBranch("original");
    viewer.seek(3.5);
    assert.equal(objects[0].root.visible, false);
    viewer.selectBranch(take);
    viewer.seek(4);
    assert.equal(objects[0].root.visible, true);
  } finally {
    viewer.dispose();
  }
});

test("after a throw preview ends, its final pose is held instead of snapping back to the release pose", async () => {
  const { memory, objects } = build([still()]);
  const viewer = new Viewer(memory, () => {});
  const root = objects[0].root;
  try {
    viewer.seek(1);
    await throwBall(viewer);
    const recording = viewer.timeline.active.tracks.get("ball")!,
      last = new Vector3(...recording.at(-1)!.p);
    assert.ok(last.distanceTo(new Vector3(...recording[0].p)) > 0.3, "it landed somewhere else");
    for (let i = 0; i < 30; i++) viewer.update(STEP);
    assert.ok(root.position.distanceTo(last) < 1e-6, "rests where it landed");
    close(viewer.timeline.time, 1);
    viewer.applyClock(1, false, 1, viewer.timeline.activeId);
    viewer.update(STEP);
    assert.ok(root.position.distanceTo(last) < 1e-6, "an identical clock (an echo) keeps the hold");
    viewer.seek(1);
    assert.ok(root.position.distanceTo(new Vector3(...recording[0].p)) < 1e-6, "seeking ends the hold");
  } finally {
    viewer.dispose();
  }
});

test("play, a take change and an applied clock end the hold too", async () => {
  for (const end of ["play", "take", "clock"]) {
    const { memory, objects } = build([still()]);
    const viewer = new Viewer(memory, () => {});
    const root = objects[0].root;
    try {
      viewer.seek(1);
      await throwBall(viewer);
      const first = new Vector3(...viewer.timeline.active.tracks.get("ball")![0].p);
      if (end === "play") viewer.togglePlay();
      if (end === "take") viewer.selectBranch(viewer.timeline.activeId);
      if (end === "clock") viewer.applyClock(1, true, 1, viewer.timeline.activeId);
      assert.ok(root.position.distanceTo(first) < 1e-6, `${end}: replays from the release pose`);
    } finally {
      viewer.dispose();
    }
  }
});

test("grabbing during the hold catches the preview at its rest time, so nothing jumps", async () => {
  const { memory, objects } = build([still()]);
  const viewer = new Viewer(memory, () => {});
  const root = objects[0].root;
  const requests: GrabRequest[] = [];
  viewer.setAuthority({
    acquire: async (request) => {
      requests.push(request);
      return true;
    },
    release() {},
  });
  try {
    viewer.seek(1);
    assert.equal(await viewer.grab("ball"), true);
    viewer.release();
    await settle(viewer); // dropped
    const rest = viewer.timeline.active.tracks.get("ball")!.at(-1)!,
      position = root.position.clone();
    assert.ok(rest.t < 6, "came to rest before the clip end");
    close(rest.p[1], 0.1, 0.01);
    assert.equal(await viewer.grab("ball"), true);
    close(viewer.timeline.time, rest.t);
    close(requests[1].time, rest.t);
    assert.ok(root.position.distanceTo(position) < 1e-6);
    assert.deepEqual(
      requests[1].pose.p.map((x) => +x.toFixed(6)),
      rest.p.map((x) => +x.toFixed(6)),
    );
  } finally {
    viewer.dispose();
  }
});

test("a preview that ran to the clip end cannot be caught: the next grab edits at the paused time", async () => {
  const { memory } = build([ball([frame(0, 0, 3, 0), frame(1.2, 0, 3, 0)], { visibleTo: 1.2 })], 1.2);
  const viewer = new Viewer(memory, () => {});
  try {
    viewer.seek(1);
    await viewer.grab("ball");
    viewer.release();
    await settle(viewer);
    close(viewer.timeline.active.tracks.get("ball")!.at(-1)!.t, 1.2); // still falling when the clip ended
    assert.equal(await viewer.grab("ball"), true);
    close(viewer.timeline.time, 1);
  } finally {
    viewer.dispose();
  }
});

test("revokeOwnership cancels only a pending grab of that same object", async () => {
  for (const revoked of ["can", "ball"]) {
    const { memory } = build([still(), can]);
    const viewer = new Viewer(memory, () => {});
    const released: string[] = [];
    let grant: ((granted: boolean) => void) | undefined;
    viewer.setAuthority({
      acquire: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
      release: (id) => released.push(id),
    });
    try {
      viewer.seek(1);
      const pending = viewer.grab("ball");
      viewer.revokeOwnership(revoked); // e.g. the server cleared an earlier hold
      grant!(true);
      const granted = await pending;
      if (revoked === "can") {
        assert.equal(granted, true);
        assert.equal(viewer.held?.definition.id, "ball");
        assert.deepEqual(released, []);
      } else {
        assert.equal(granted, false);
        assert.equal(viewer.held, null);
        assert.deepEqual(released, ["ball"]);
      }
    } finally {
      viewer.dispose();
    }
  }
});

test("the status line reports the finished recording instead of keeping 'Recording this throw'", async () => {
  const { memory } = build([still()]);
  const reports: string[] = [];
  const viewer = new Viewer(memory, (message) => reports.push(message));
  try {
    viewer.seek(1);
    assert.equal(await viewer.grab("ball"), true);
    viewer.moveHeld(new Vector3(0.2, 1.5, 0), new Quaternion(), 1 / 60);
    viewer.release();
    assert.match(reports.at(-1)!, /^Recording this throw/);
    await settle(viewer);
    assert.equal(reports.at(-1), "Throw recorded. Press Play to replay this take.");
    viewer.seek(1);
    assert.equal(await viewer.grab("ball"), true);
    viewer.release();
    viewer.seek(2); // finishes the preview at once
    assert.equal(reports.at(-1), "Throw recorded.");
  } finally {
    viewer.dispose();
  }
});

test("a grab at the very end is refused with a message saying what to do", async () => {
  const { memory } = build([still()]);
  const reports: string[] = [];
  const viewer = new Viewer(memory, (message) => reports.push(message));
  try {
    viewer.seek(6);
    assert.equal(await viewer.grab("ball"), false);
    assert.equal(reports.at(-1), AT_END);
    assert.equal(viewer.timeline.branches.length, 1);
  } finally {
    viewer.dispose();
  }
});

test("collider depth below the origin follows the rotation and scale", () => {
  const turn = (x: number, y: number, z: number) => new Quaternion().setFromEuler(new Euler(x, y, z));
  close(colliderDepth({ kind: "sphere", radius: 0.1 }, turn(1, 2, 3), 2), 0.2);
  const box: DynamicObject["collider"] = { kind: "box", halfExtents: [0.1, 0.2, 0.3] };
  close(colliderDepth(box, turn(0, 0, 0), 1), 0.2);
  close(colliderDepth(box, turn(0, 0, Math.PI / 2), 1), 0.1, 1e-9); // lying on its side
  close(colliderDepth(box, turn(0, 0, Math.PI / 4), 1), (0.1 + 0.2) * Math.SQRT1_2, 1e-9);
  const cylinder: DynamicObject["collider"] = { kind: "cylinder", halfHeight: 0.12, radius: 0.065 };
  close(colliderDepth(cylinder, turn(0, 0, 0), 1), 0.12);
  close(colliderDepth(cylinder, turn(Math.PI / 2, 0, 0), 1), 0.065, 1e-9);
  close(colliderDepth(cylinder, turn(Math.PI / 4, 0, 0), 1), (0.12 + 0.065) * Math.SQRT1_2, 1e-9);
  const capsule: DynamicObject["collider"] = { kind: "capsule", halfHeight: 0.2, radius: 0.1 };
  close(colliderDepth(capsule, turn(0, 0, 0), 1), 0.3);
  close(colliderDepth(capsule, turn(Math.PI / 2, 0, 0), 1), 0.1, 1e-9);
  const hull = new Float32Array([-0.1, 0, -0.1, 0.1, 0, -0.1, 0, 0, 0.1, 0, 0.2, 0]); // a tetrahedron standing on its base
  close(colliderDepth({ kind: "convex", url: "hull.glb" }, turn(0, 0, 0), 2, hull), 0);
  close(colliderDepth({ kind: "convex", url: "hull.glb" }, turn(Math.PI, 0, 0), 2, hull), 0.4, 1e-6); // upside down
});

test("a held object is kept above the floor, and its take never falls through it", async () => {
  const { memory, objects } = build([still(), can]);
  const viewer = new Viewer(memory, () => {});
  const root = objects[0].root;
  try {
    viewer.seek(1);
    assert.equal(await viewer.grab("ball"), true);
    viewer.moveHeld(new Vector3(0.5, -3, 0), new Quaternion(), 1 / 60); // dragged far below the floor
    close(root.position.y, 0.1);
    close(root.position.x, 0.5);
    viewer.moveHeld(new Vector3(0.6, -2, 0), new Quaternion(), 1 / 60);
    close(viewer.physics.bodies.get("ball")!.body.translation().y, 0.1);
    viewer.release();
    await settle(viewer);
    const take = viewer.timeline.active.tracks.get("ball")!;
    assert.ok(
      take.every((f) => f.p[1] > 0.1 - 0.01),
      `lowest ${Math.min(...take.map((f) => f.p[1]))}`,
    );
    // A rotated can is clamped by its rotated extent: lying on its side, by its radius.
    viewer.seek(1);
    assert.equal(await viewer.grab("can"), true);
    viewer.moveHeld(new Vector3(1, -1, 0), new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0)), 1 / 60);
    close(objects[1].root.position.y, 0.065);
  } finally {
    viewer.dispose();
  }
});

test("an object released unmoved from under the floor is lifted onto it first", async () => {
  const { memory } = build([still(-0.5)]); // bad pipeline data: the ball's track is half a metre under the floor
  const viewer = new Viewer(memory, () => {});
  const events: ViewerEvent[] = [];
  viewer.subscribe((e) => events.push(e));
  try {
    viewer.seek(1);
    assert.equal(await viewer.grab("ball"), true);
    viewer.release();
    await settle(viewer);
    close(events.find((e): e is ObjectEvent => e.type === "throw")!.pose.p[1], 0.1);
    close(viewer.timeline.active.tracks.get("ball")!.at(-1)!.p[1], 0.1, 0.01);
  } finally {
    viewer.dispose();
  }
});

test("let go while paused, an object is placed: it stays put with the throw it was given, and Play releases it", async () => {
  const { memory, objects } = build([still()]);
  const reports: string[] = [];
  const viewer = new Viewer(memory, (message) => reports.push(message));
  const root = objects[0].root;
  try {
    viewer.seek(1);
    assert.equal(await viewer.grab("ball"), true);
    viewer.moveHeld(new Vector3(0.1, 1.2, 0), new Quaternion(), 1 / 60);
    viewer.moveHeld(new Vector3(0.2, 1.4, 0), new Quaternion(), 1 / 60); // moving right and up
    viewer.place();
    assert.equal(viewer.isPlaced, true);
    assert.equal(viewer.recording, false);
    assert.match(reports.at(-1)!, /placed\. Press Play/);
    const at = root.position.clone();
    for (let i = 0; i < 60; i++) viewer.update(STEP);
    assert.ok(root.position.distanceTo(at) < 1e-9, "frozen with the rest of the scene");
    viewer.togglePlay();
    assert.equal(viewer.held, null);
    assert.equal(viewer.timeline.playing, true);
    const take = viewer.timeline.active.tracks.get("ball")!;
    close(take[0].t, 1);
    close(take[0].p[0], at.x);
    close(take[0].p[1], at.y);
    for (let i = 0; i < 12; i++) viewer.update(STEP);
    assert.ok(root.position.x > at.x + 0.02, "it carries on with the throw it was given");
    assert.match(reports.at(-1)!, /^Playing your take/);
  } finally {
    viewer.dispose();
  }
});

test("grabbing a placed object again carries on the same edit; another object releases it into the take first", async () => {
  const { memory } = build([still(), can]);
  const viewer = new Viewer(memory, () => {});
  try {
    viewer.seek(1);
    assert.equal(await viewer.grab("ball"), true);
    viewer.moveHeld(new Vector3(0.3, 1.2, 0), new Quaternion(), 1 / 60);
    viewer.place();
    assert.equal(await viewer.grab("ball"), true);
    assert.equal(viewer.timeline.branches.length, 2, "no new take");
    assert.equal(viewer.isPlaced, false);
    viewer.moveHeld(new Vector3(0.5, 1.2, 0), new Quaternion(), 1 / 60);
    viewer.place();
    assert.equal(await viewer.grab("can"), true);
    assert.equal(viewer.held!.definition.id, "can");
    const ballTake = viewer.timeline.branches[1].tracks.get("ball");
    assert.ok(ballTake && ballTake.length > 1, "the ball's throw was recorded into its take");
    close(ballTake[0].t, 1);
    close(ballTake[0].p[0], 0.5);
  } finally {
    viewer.dispose();
  }
});

test("a seek or a take change releases a placed object into its take, like Play", async () => {
  for (const change of ["seek", "take"]) {
    const { memory } = build([still()]);
    const viewer = new Viewer(memory, () => {});
    try {
      viewer.seek(1);
      await viewer.grab("ball");
      viewer.moveHeld(new Vector3(0.2, 1.5, 0), new Quaternion(), 1 / 60);
      viewer.place();
      const take = viewer.timeline.activeId;
      if (change === "seek") viewer.seek(2);
      else viewer.selectBranch("original");
      assert.equal(viewer.held, null);
      assert.ok(viewer.timeline.branches.find((b) => b.id === take)!.tracks.get("ball")!.length > 1, change);
    } finally {
      viewer.dispose();
    }
  }
});
