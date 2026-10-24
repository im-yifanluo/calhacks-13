import { beforeEach, expect, test } from "vitest";
import {
  createModuleTestHarness,
  TestAuth,
  TestClock,
} from "spacetimedb/server/test-utils";
import { ConnectionId, Identity, Timestamp, TimeDuration } from "spacetimedb";
import db, * as mod from "../server/spacetime/src/index";
const auth = (name: string, id: bigint) =>
  TestAuth.fromJwtPayload(
    JSON.stringify({
      sub: name,
      iss: "https://tests.example",
      aud: "spacetimedb",
    }),
    new ConnectionId(id),
  );
const alice = auth("alice", 1n),
  bob = auth("bob", 2n);
let h: ReturnType<typeof createModuleTestHarness<typeof db.schemaType>>;
const pose = {
  px: 0,
  py: 1,
  pz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  vx: 1,
  vy: 0,
  vz: 0,
};
function call(who: typeof alice, fn: any, args: any = {}) {
  return h.withReducerTx(who, (ctx) => fn(ctx, args));
}
function me(who: typeof alice) {
  return h.withReducerTx(who, (ctx) => ctx.sender);
}
function memory(who = alice) {
  call(who, mod.createMemory, {
    requestId: `memory-${me(who)}`,
    title: "Test",
    sourceUrl: "",
    manifestUrl: "https://assets.example/memory.json",
    pipelineIdentity: me(who),
    durationUs: 6_000_000n,
  });
  return [...h.db.memory.iter()].find((m) => m.owner.isEqual(me(who)))!;
}
function room() {
  const m = memory();
  call(alice, mod.createRoom, {
    memoryId: m.id,
    name: "Alice",
    device: "phone",
  });
  return [...h.db.room.iter()][0];
}
beforeEach(() => {
  h = createModuleTestHarness(db, mod, {
    clock: new TestClock(new Timestamp(1_000_000n)),
  });
});
test("rooms share clock anchors and clamp at duration", () => {
  const r = room();
  expect(r.joinCode).toMatch(/^[A-Z0-9]{7}$/);
  call(bob, mod.joinRoom, {
    joinCode: r.joinCode.toLowerCase(),
    name: "Bob",
    device: "quest",
  });
  h.clock.advance(new TimeDuration(2_000_000n));
  call(bob, mod.setPaused, { paused: true });
  expect(h.db.timeline.roomId.find(r.id)?.anchorMediaUs).toBe(2_000_000n);
  expect(() => call(bob, mod.seek, { mediaUs: 7_000_000n })).toThrow();
});
test("grabs fork atomically, reject competitors and keep throw authority until rest", () => {
  const r = room();
  call(bob, mod.joinRoom, {
    joinCode: r.joinCode,
    name: "Bob",
    device: "phone",
  });
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  expect(h.db.timeline.roomId.find(r.id)?.branchId).not.toBe(0n);
  expect(() => call(bob, mod.grab, { objectId: "ball", ...pose })).toThrow();
  call(alice, mod.release, { objectId: "ball", rest: false, ...pose });
  call(alice, mod.moveObject, { objectId: "ball", ...pose, px: 1 });
  call(alice, mod.release, { objectId: "ball", rest: true, ...pose });
  call(bob, mod.grab, { objectId: "ball", ...pose });
});
test("cross-room branch writes and pipeline impersonation are rejected", () => {
  const r = room();
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.forkBranch, { name: "A" });
  const branchId = h.db.timeline.roomId.find(r.id)!.branchId;
  const m = memory(bob);
  call(bob, mod.createRoom, { memoryId: m.id, name: "Bob", device: "phone" });
  expect(() => call(bob, mod.setBranch, { branchId })).toThrow();
  const original = [...h.db.memory.iter()].find((m) =>
    m.owner.isEqual(me(alice)),
  )!;
  expect(() =>
    call(bob, mod.setMemoryStatus, {
      memoryId: original.id,
      status: "ready",
      progress: 1,
      manifestUrl: original.manifestUrl,
      error: "",
    }),
  ).toThrow();
});
test("recorded chunks validate owner, time, and idempotency", () => {
  room();
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  const branchId = [...h.db.branch.iter()][0].id;
  const args = {
    branchId,
    objectId: "ball",
    startMediaUs: 0n,
    keyframesJson: JSON.stringify([
      { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1] },
      { t: 1, p: [1, 1, 0], q: [0, 0, 0, 1] },
    ]),
  };
  call(alice, mod.saveBranchKeyframes, args);
  call(alice, mod.saveBranchKeyframes, args);
  expect([...h.db.branchKeyframes.iter()]).toHaveLength(1);
  expect(() => call(bob, mod.saveBranchKeyframes, args)).toThrow();
  expect(() =>
    call(alice, mod.moveObject, { objectId: "ball", ...pose, px: NaN }),
  ).toThrow();
});
test("disconnect releases authority only after the last connection closes", () => {
  room();
  call(alice, mod.onConnect);
  const second = auth("alice", 3n);
  call(second, mod.onConnect);
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  call(alice, mod.onDisconnect);
  expect([...h.db.objectState.iter()][0].simOwner).toBeDefined();
  call(second, mod.onDisconnect);
  expect([...h.db.objectState.iter()][0].simOwner).toBeUndefined();
  expect(h.db.player.identity.find(me(alice))?.online).toBe(false);
});
test("upload completion remains idempotent after the worker publishes a manifest", () => {
  const args = {
    requestId: "upload-retry",
    title: "Video",
    sourceUrl: "https://assets.example/clip.mp4",
    manifestUrl: "",
    pipelineIdentity: me(alice),
    durationUs: 6_000_000n,
  };
  call(alice, mod.createMemory, args);
  const m = [...h.db.memory.iter()][0];
  call(alice, mod.setMemoryStatus, {
    memoryId: m.id,
    status: "processing",
    progress: 0.5,
    manifestUrl: "",
    error: "",
  });
  call(alice, mod.setMemoryStatus, {
    memoryId: m.id,
    status: "ready",
    progress: 1,
    manifestUrl: "https://assets.example/memory.json",
    error: "",
  });
  call(alice, mod.createMemory, args);
  expect([...h.db.memory.iter()]).toHaveLength(1);
  expect(h.db.memory.id.find(m.id)?.status).toBe("ready");
  expect(() => call(bob, mod.createMemory, args)).toThrow();
});
test("editing a resting object forks without replacing its recorded trajectory", () => {
  const r = room();
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  const first = h.db.timeline.roomId.find(r.id)!.branchId;
  call(alice, mod.saveBranchKeyframes, {
    branchId: first,
    objectId: "ball",
    startMediaUs: 0n,
    keyframesJson: JSON.stringify([{ t: 0, p: [0, 1, 0], q: [0, 0, 0, 1] }]),
  });
  call(alice, mod.release, { objectId: "ball", rest: true, ...pose });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  const child = h.db.timeline.roomId.find(r.id)!.branchId;
  expect(child).not.toBe(first);
  expect(h.db.branch.id.find(child)?.parentId).toBe(first);
  expect([...h.db.branchKeyframes.iter()]).toHaveLength(1);
});
