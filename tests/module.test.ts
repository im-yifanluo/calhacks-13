import { beforeEach, expect, test } from "vitest";
import {
  createModuleTestHarness,
  TestAuth,
  TestClock,
} from "spacetimedb/server/test-utils";
import { ConnectionId, Identity, Timestamp, TimeDuration } from "spacetimedb";
import { SenderError } from "spacetimedb/server";
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

// Regression tests for the integration fixes to the module.
const tl = (r: { id: bigint }) => h.db.timeline.roomId.find(r.id)!;
const seconds = (s: number) => new TimeDuration(BigInt(Math.round(s * 1e6)));
function rejects(who: typeof alice, fn: any, args: any, message: string) {
  let error: unknown;
  try {
    call(who, fn, args);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(SenderError);
  expect((error as Error).message).toBe(message);
}
function save(who: typeof alice, branchId: bigint, ...ts: number[]) {
  call(who, mod.saveBranchKeyframes, {
    branchId,
    objectId: "ball",
    startMediaUs: BigInt(Math.round(ts[0] * 1e6)),
    keyframesJson: JSON.stringify(
      ts.map((t) => ({ t, p: [0, 1, 0], q: [0, 0, 0, 1] })),
    ),
  });
}
/** The ball's chunks on a branch, in time order: [startUs, endUs, frame times]. */
function chunks(branchId: bigint) {
  return [...h.db.branchKeyframes.branchId.filter(branchId)]
    .filter((c) => c.objectId === "ball")
    .sort((a, b) => Number(a.startMediaUs - b.startMediaUs))
    .map((c) => [
      c.startMediaUs,
      c.endMediaUs,
      (JSON.parse(c.keyframesJson) as { t: number }[]).map((f) => f.t),
    ]);
}
/** Alice hosts, Bob joins and throws the ball; it is in "physics" mode, owned by Bob. */
function bobThrows() {
  const r = room();
  call(bob, mod.joinRoom, {
    joinCode: r.joinCode,
    name: "Bob",
    device: "phone",
  });
  call(bob, mod.setPaused, { paused: true });
  call(bob, mod.grab, { objectId: "ball", ...pose });
  call(bob, mod.release, { objectId: "ball", rest: false, ...pose });
  const branchId = tl(r).branchId;
  save(bob, branchId, 0, 0.5);
  return { r, branchId };
}
const simulationBlocked = "Wait for objects to settle or release them first";
const blockers: [string, (who: typeof alice) => unknown][] = [
  ["seek", (who) => call(who, mod.seek, { mediaUs: 0n })],
  ["forkBranch", (who) => call(who, mod.forkBranch, { name: "Retry" })],
  ["setBranch", (who) => call(who, mod.setBranch, { branchId: 0n })],
];

test("null and other non-object keyframes are rejected as SenderErrors", () => {
  const r = room();
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  const good = { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1] };
  for (const bad of [[null], [good, null], [1], ["frame"], [[0, 1]], [true]])
    rejects(
      alice,
      mod.saveBranchKeyframes,
      {
        branchId: tl(r).branchId,
        objectId: "ball",
        startMediaUs: 0n,
        keyframesJson: JSON.stringify(bad),
      },
      "Invalid keyframe",
    );
  save(alice, tl(r).branchId, 0, 1);
  expect(chunks(tl(r).branchId)).toEqual([[0n, 1_000_000n, [0, 1]]]);
});

test("re-grabbing an object with a 100-character id forks a take", () => {
  const r = room();
  call(alice, mod.setPaused, { paused: true });
  const id = "x".repeat(100);
  call(alice, mod.grab, { objectId: id, ...pose });
  call(alice, mod.release, { objectId: id, rest: true, ...pose });
  const first = tl(r).branchId;
  call(alice, mod.grab, { objectId: id, ...pose });
  const take = h.db.branch.id.find(tl(r).branchId)!;
  expect(take.parentId).toBe(first);
  expect(take.name).toBe(`Edit ${id}`.slice(0, 100));
  expect(
    h.db.objectState.key.find(`${take.id}:${id}`)?.simOwner?.isEqual(me(alice)),
  ).toBe(true);
});

test("catching your own throw lets the re-throw record from the same time", () => {
  const r = room();
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  call(alice, mod.release, { objectId: "ball", rest: false, ...pose });
  const branchId = tl(r).branchId;
  save(alice, branchId, 0, 0.25, 0.5);
  save(alice, branchId, 0.55, 1);
  // Before the fix, the re-throw's chunks were rejected: "Chunk already recorded" / "Overlapping".
  call(alice, mod.grab, { objectId: "ball", ...pose });
  expect(tl(r).branchId).toBe(branchId);
  expect(h.db.objectState.key.find(`${branchId}:ball`)?.mode).toBe("held");
  expect(chunks(branchId)).toEqual([]);
  call(alice, mod.release, { objectId: "ball", rest: false, ...pose });
  save(alice, branchId, 0, 0.4);
  save(alice, branchId, 0.45, 0.7);
  call(alice, mod.release, { objectId: "ball", rest: true, ...pose });
  expect(chunks(branchId)).toEqual([
    [0n, 400_000n, [0, 0.4]],
    [450_000n, 700_000n, [0.45, 0.7]],
  ]);
});

test("a self re-grab truncates the chunk that straddles its time and drops later ones", () => {
  const r = room();
  h.clock.advance(seconds(1));
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  call(alice, mod.release, { objectId: "ball", rest: false, ...pose });
  const branchId = tl(r).branchId;
  save(alice, branchId, 1, 1.4);
  save(alice, branchId, 1.5, 1.7, 1.8, 2);
  save(alice, branchId, 2.2, 2.6);
  // Play on for 0.8 s while the ball is still simulating, then catch it at 1.8 s.
  call(alice, mod.setPaused, { paused: false });
  h.clock.advance(seconds(0.8));
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  expect(tl(r).branchId).toBe(branchId);
  expect(h.db.objectState.key.find(`${branchId}:ball`)?.fromMediaUs).toBe(
    1_800_000n,
  );
  expect(chunks(branchId)).toEqual([
    [1_000_000n, 1_400_000n, [1, 1.4]],
    [1_500_000n, 1_700_000n, [1.5, 1.7]],
  ]);
  call(alice, mod.release, { objectId: "ball", rest: false, ...pose });
  save(alice, branchId, 1.8, 2.3);
  expect(chunks(branchId)).toHaveLength(3);
});

for (const [name, action] of blockers)
  test(`${name} settles a throw abandoned for more than 15 s`, () => {
    const { branchId } = bobThrows();
    h.clock.advance(seconds(15));
    h.clock.advance(new TimeDuration(1n));
    action(alice);
    const ball = h.db.objectState.key.find(`${branchId}:ball`)!;
    expect(ball.mode).toBe("rest");
    expect(ball.heldBy).toBeUndefined();
    expect(ball.simOwner).toBeUndefined();
    expect([ball.vx, ball.vy, ball.vz]).toEqual([0, 0, 0]);
    expect(ball.updatedAt.microsSinceUnixEpoch).toBe(
      h.clock.now().microsSinceUnixEpoch,
    );
    // Bob's partial recording is kept.
    expect(chunks(branchId)).toEqual([[0n, 500_000n, [0, 0.5]]]);
  });

test("anyone can grab a throw abandoned for more than 15 s; it forks a new take", () => {
  const { r, branchId } = bobThrows();
  h.clock.advance(seconds(15.001));
  call(alice, mod.grab, { objectId: "ball", ...pose, px: 2 });
  const take = h.db.branch.id.find(tl(r).branchId)!;
  expect(take.parentId).toBe(branchId);
  expect(take.name).toBe("Edit ball");
  const parent = h.db.objectState.key.find(`${branchId}:ball`)!;
  expect(parent.mode).toBe("rest");
  expect(parent.simOwner).toBeUndefined();
  const held = h.db.objectState.key.find(`${take.id}:ball`)!;
  expect(held.simOwner?.isEqual(me(alice))).toBe(true);
  expect(held.px).toBe(2);
  expect(chunks(branchId)).toHaveLength(1);
  rejects(
    bob,
    mod.moveObject,
    { objectId: "ball", ...pose },
    "Not the simulation owner",
  );
  // The owner coming back to its own abandoned throw also starts a new take.
  const again = bobThrows();
  h.clock.advance(seconds(16));
  call(bob, mod.grab, { objectId: "ball", ...pose });
  expect(h.db.branch.id.find(tl(again.r).branchId)?.parentId).toBe(
    again.branchId,
  );
});

test("a throw is live until 15 s after its owner's last write, and held objects never expire", () => {
  const { branchId } = bobThrows();
  h.clock.advance(seconds(15));
  for (const [, action] of blockers)
    expect(() => action(alice)).toThrow(simulationBlocked);
  // Catching another player's throw stays rejected (team decision 1).
  rejects(
    alice,
    mod.grab,
    { objectId: "ball", ...pose },
    "Object is owned by another player",
  );
  // Each write by the owner restarts the 15 s: a chunk, then a move.
  save(bob, branchId, 0.6, 1);
  h.clock.advance(seconds(10));
  expect(() => call(alice, mod.seek, { mediaUs: 0n })).toThrow(
    simulationBlocked,
  );
  call(bob, mod.moveObject, { objectId: "ball", ...pose });
  h.clock.advance(seconds(15));
  expect(() => call(alice, mod.seek, { mediaUs: 0n })).toThrow(
    simulationBlocked,
  );
  h.clock.advance(new TimeDuration(1n));
  call(alice, mod.seek, { mediaUs: 0n });
  expect(h.db.objectState.key.find(`${branchId}:ball`)?.mode).toBe("rest");
  // A held object never expires; leaving the room releases it.
  call(bob, mod.grab, { objectId: "cup", ...pose });
  h.clock.advance(seconds(600));
  expect(() => call(alice, mod.seek, { mediaUs: 0n })).toThrow(
    simulationBlocked,
  );
  rejects(
    alice,
    mod.grab,
    { objectId: "cup", ...pose },
    "Object is owned by another player",
  );
  call(bob, mod.leaveRoom);
  call(alice, mod.seek, { mediaUs: 0n });
});

test("join codes skip the biased first draw of the timestamp-seeded RNG", () => {
  const m = memory();
  const host = me(alice);
  const code = (u: number) =>
    (u >>> 0).toString(36).toUpperCase().padStart(7, "0");
  let biasedFirstDraws = 0;
  for (let seed = 1; seed <= 200; seed++) {
    h.rng.setSeed(seed);
    const first = code(h.withReducerTx(alice, (ctx) => ctx.random.uint32()));
    if (first.startsWith("000000")) biasedFirstDraws++;
    h.rng.setSeed(seed);
    call(alice, mod.createRoom, {
      memoryId: m.id,
      name: "Alice",
      device: "phone",
    });
    const joinCode = h.db.room.id.find(
      h.db.player.identity.find(host)!.roomId,
    )!.joinCode;
    expect(joinCode).toMatch(/^[A-Z0-9]{7}$/);
    expect(joinCode).not.toBe(first);
    expect(joinCode.startsWith("000")).toBe(false);
  }
  // The first draw really is biased (about 1 in 10); the codes no longer use it.
  expect(biasedFirstDraws).toBeGreaterThan(10);
});

test("leaving a room survives a reconnect, and joining again works", () => {
  const r = room();
  call(alice, mod.onConnect);
  call(alice, mod.setPaused, { paused: true });
  call(alice, mod.grab, { objectId: "ball", ...pose });
  const branchId = tl(r).branchId;
  call(alice, mod.leaveRoom);
  const out = { online: false, roomId: 0n };
  expect(h.db.player.identity.find(me(alice))).toMatchObject(out);
  expect(
    h.db.objectState.key.find(`${branchId}:ball`)?.simOwner,
  ).toBeUndefined();
  call(alice, mod.onDisconnect);
  call(auth("alice", 9n), mod.onConnect);
  expect(h.db.player.identity.find(me(alice))).toMatchObject(out);
  rejects(alice, mod.setPaused, { paused: false }, "Join a room first");
  rejects(alice, mod.grab, { objectId: "ball", ...pose }, "Join a room first");
  call(alice, mod.joinRoom, {
    joinCode: r.joinCode,
    name: "Alice",
    device: "quest",
  });
  expect(h.db.player.identity.find(me(alice))).toMatchObject({
    online: true,
    roomId: r.id,
    device: "quest",
  });
  call(alice, mod.setPaused, { paused: false });
  // createRoom after leaving works too.
  call(alice, mod.leaveRoom);
  call(alice, mod.createRoom, {
    memoryId: r.memoryId,
    name: "Alice",
    device: "phone",
  });
  expect(h.db.player.identity.find(me(alice))?.roomId).not.toBe(r.id);
  expect(h.db.player.identity.find(me(alice))?.online).toBe(true);
});

test("a dropped connection still resumes the room on reconnect", () => {
  const r = room();
  call(alice, mod.onConnect);
  call(alice, mod.onDisconnect);
  expect(h.db.player.identity.find(me(alice))).toMatchObject({
    online: false,
    roomId: r.id,
  });
  call(auth("alice", 9n), mod.onConnect);
  expect(h.db.player.identity.find(me(alice))).toMatchObject({
    online: true,
    roomId: r.id,
  });
  call(alice, mod.setPaused, { paused: true });
});
