import { beforeEach, expect, test } from "vitest";
import { createModuleTestHarness, TestAuth, TestClock } from "spacetimedb/server/test-utils";
import { ConnectionId, Timestamp, TimeDuration } from "spacetimedb";
import db, * as mod from "../src/index";
const auth = (name: string, id: bigint, claims = {}) =>
  TestAuth.fromJwtPayload(
    JSON.stringify({
      sub: name,
      iss: "https://tests.example",
      aud: "spacetimedb",
      ...claims,
    }),
    new ConnectionId(id),
  );
const a = auth("Alice", 1n),
  b = auth("Bob", 2n),
  c = auth("Charlie", 3n),
  worker = auth("worker", 4n);
let h: ReturnType<typeof createModuleTestHarness<typeof db.schemaType>>;
const call = (who: TestAuth, fn: any, args: any = {}) => h.withReducerTx(who, (ctx) => fn(ctx, args));
const identity = (who: TestAuth) => h.withReducerTx(who, (ctx) => ctx.sender);
const room = () => [...h.db.room.iter()][0];
const clock = () => h.db.timeline.roomId.find(room().id)!;
function memory(sourceUrl = "", requestId = "demo") {
  call(a, mod.createMemory, {
    requestId,
    title: requestId,
    sourceUrl,
    manifestUrl: sourceUrl ? "" : "https://app.example/demo/memory.json",
    pipelineIdentity: identity(worker),
    durationUs: 6_000_000n,
  });
  return h.db.memory.requestId.find(requestId)!;
}
function join(who = b) {
  call(who, mod.joinRoom, {
    joinCode: room().joinCode.toLowerCase(),
    name: "Member",
    device: "phone",
  });
}
function party() {
  const m = memory();
  call(a, mod.createParty, {
    memoryId: m.id,
    name: "Alice",
    device: "desktop",
  });
  join();
}
beforeEach(() => {
  h = createModuleTestHarness(db, mod, {
    clock: new TestClock(new Timestamp(1_000_000n)),
  });
});

test("party permissions reject direct guest clock, branch, scene and leader writes", () => {
  party();
  const before = clock();
  for (const [fn, args] of [
    [mod.setPaused, { paused: true }],
    [mod.seek, { mediaUs: 2_000_000n }],
    [mod.setPlaybackSpeed, { speed: 2 }],
    [mod.forkBranch, { name: "Override" }],
    [mod.setBranch, { branchId: 0n }],
    [mod.attachPartyMemory, { memoryId: 0n }],
    [mod.transferLeadership, { identity: identity(b) }],
  ])
    expect(() => call(b, fn, args)).toThrow(/Only the party leader/);
  expect(clock()).toEqual(before);
  call(a, mod.setPaused, { paused: true });
  call(a, mod.seek, { mediaUs: 2_000_000n });
  call(a, mod.setPlaybackSpeed, { speed: 0.5 });
  join(c);
  expect(clock()).toMatchObject({
    paused: true,
    anchorMediaUs: 2_000_000n,
    speed: 0.5,
  });
  expect(() => call(a, mod.setPlaybackSpeed, { speed: NaN })).toThrow();
  expect(() => call(a, mod.setPlaybackSpeed, { speed: 10 })).toThrow();
});

test("transfer requires a connected member and immediately revokes the old leader", () => {
  party();
  expect(() => call(a, mod.transferLeadership, { identity: identity(c) })).toThrow(/connected/);
  call(a, mod.transferLeadership, { identity: identity(b) });
  expect(room().host.isEqual(identity(b))).toBe(true);
  expect(() => call(a, mod.seek, { mediaUs: 0n })).toThrow(/leader/);
  call(b, mod.seek, { mediaUs: 3_000_000n });
});

test("only the last connection's disconnect hands off leadership; reconnect does not steal it", () => {
  party();
  const second = auth("Alice", 9n);
  call(a, mod.onConnect);
  call(second, mod.onConnect);
  call(b, mod.onConnect);
  call(a, mod.onDisconnect);
  expect(room().host.isEqual(identity(a))).toBe(true);
  call(second, mod.onDisconnect);
  expect(room().host.isEqual(identity(b))).toBe(true);
  call(a, mod.onConnect);
  expect(room().host.isEqual(identity(b))).toBe(true);
});

test("empty party pauses, next visitor becomes leader, switching parties elects a replacement", () => {
  party();
  call(a, mod.leaveRoom);
  expect(room().host.isEqual(identity(b))).toBe(true);
  h.clock.advance(new TimeDuration(2_000_000n));
  call(b, mod.leaveRoom);
  expect(clock().paused).toBe(true);
  join(c);
  expect(room().host.isEqual(identity(c))).toBe(true);
  join(a);
  const old = room();
  call(c, mod.createParty, {
    memoryId: old.memoryId,
    name: "Elsewhere",
    device: "phone",
  });
  expect(h.db.room.id.find(old.id)!.host.isEqual(identity(a))).toBe(true);
});

test("pending reconstruction keeps the demo live and only the assigned worker can publish the scene", () => {
  party();
  const current = room().memoryId,
    video = memory("https://assets.example/video.mp4", "video");
  call(a, mod.attachPartyMemory, { memoryId: video.id });
  expect(room().memoryId).toBe(current);
  const update = {
    memoryId: video.id,
    status: "processing",
    progress: 0.4,
    manifestUrl: "",
    error: "",
  };
  expect(() => call(b, mod.setMemoryStatus, update)).toThrow(/assigned pipeline/);
  call(worker, mod.setMemoryStatus, update);
  expect(h.db.party.roomId.find(room().id)?.pendingMemoryId).toBe(video.id);
  call(worker, mod.setMemoryStatus, {
    ...update,
    status: "ready",
    progress: 1,
    manifestUrl: "https://assets.example/ready/memory.json",
  });
  expect(room().memoryId).toBe(video.id);
  expect(h.db.party.roomId.find(room().id)).toMatchObject({
    pendingMemoryId: 0n,
    sceneRevision: 1,
  });
  expect(clock()).toMatchObject({
    branchId: 0n,
    paused: true,
    anchorMediaUs: 0n,
    speed: 1,
  });
});

test("cancelled or replaced reconstruction cannot override the selected scene", () => {
  party();
  const original = room().memoryId,
    video = memory("https://assets.example/video.mp4", "video");
  call(a, mod.attachPartyMemory, { memoryId: video.id });
  call(a, mod.attachPartyMemory, { memoryId: 0n });
  call(worker, mod.setMemoryStatus, {
    memoryId: video.id,
    status: "processing",
    progress: 0,
    manifestUrl: "",
    error: "",
  });
  call(worker, mod.setMemoryStatus, {
    memoryId: video.id,
    status: "ready",
    progress: 1,
    manifestUrl: "https://assets.example/ready.json",
    error: "",
  });
  expect(room().memoryId).toBe(original);
  call(a, mod.setPaused, { paused: true });
  call(a, mod.forkBranch, { name: "Old scene take" });
  const oldBranch = clock().branchId;
  call(a, mod.attachPartyMemory, { memoryId: video.id });
  expect(() => call(a, mod.setBranch, { branchId: oldBranch })).toThrow(/outside/);
});

test("registered names survive reconnects and joining cannot replace them", () => {
  call(a, mod.onConnect);
  call(a, mod.registerAccount, { name: "  Alice  " });
  expect(h.db.profile.identity.find(identity(a))).toMatchObject({ provider: "key", displayName: "Alice" });
  call(a, mod.onDisconnect);
  call(a, mod.onConnect);
  expect(h.db.profile.identity.find(identity(a))?.displayName).toBe("Alice");
  const id = memory().id;
  call(a, mod.createParty, { memoryId: id, name: "Spoofed name", device: "desktop" });
  expect(h.db.player.identity.find(identity(a))?.name).toBe("Alice");
  call(a, mod.registerAccount, { name: "Alice" }); // retry is idempotent
  expect(() => call(a, mod.registerAccount, { name: "Impostor" })).toThrow(/already belongs/);
  expect(() => call(a, mod.setDisplayName, { displayName: "Impostor" })).toThrow(/already belongs/);
});

test("same display name does not give another identity access to the leader account", () => {
  call(a, mod.registerAccount, { name: "Alice" });
  call(b, mod.registerAccount, { name: "Alice" });
  const id = memory().id;
  call(a, mod.createParty, { memoryId: id, name: "Alice", device: "desktop" });
  join(b);
  expect(identity(a).isEqual(identity(b))).toBe(false);
  expect(() => call(b, mod.setPaused, { paused: false })).toThrow(/leader/);
  expect(h.db.profile.identity.find(identity(a))?.displayName).toBe("Alice");
  expect(h.db.profile.identity.find(identity(b))?.displayName).toBe("Alice");
});

test("account registration validates names and never puts keys in public profiles", () => {
  for (const name of ["", "   ", "x".repeat(41)])
    expect(() => call(a, mod.registerAccount, { name })).toThrow(/text length/);
  call(a, mod.registerAccount, { name: "Alice" });
  expect(Object.keys(h.db.profile.identity.find(identity(a))!).sort()).toEqual(["displayName", "identity", "provider"]);
});

test("legacy Google credentials are rejected instead of accepted without audience checks", () => {
  const google = auth("legacy", 10n, { iss: "https://accounts.google.com", aud: "any-app" });
  expect(() => call(google, mod.onConnect)).toThrow(/replaced/);
  expect(() => call(google, mod.registerAccount, { name: "Alice" })).toThrow(/replaced/);
});
