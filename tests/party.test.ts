import { beforeEach, expect, test, vi } from "vitest";
import {
  createModuleTestHarness,
  TestAuth,
  TestClock,
} from "spacetimedb/server/test-utils";
import { ConnectionId, Timestamp, TimeDuration } from "spacetimedb";
import db, * as mod from "../server/spacetime/src/index";
import { validateCredential } from "../apps/web/src/auth";
vi.mock("../server/spacetime/src/google-config", () => ({
  GOOGLE_CLIENT_ID: "123-test.apps.googleusercontent.com",
}));
const clientId = "123-test.apps.googleusercontent.com";
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
const call = (who: TestAuth, fn: any, args: any = {}) =>
  h.withReducerTx(who, (ctx) => fn(ctx, args));
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
  expect(() =>
    call(a, mod.transferLeadership, { identity: identity(c) }),
  ).toThrow(/connected/);
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
  expect(() => call(b, mod.setMemoryStatus, update)).toThrow(
    /assigned pipeline/,
  );
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
  expect(() => call(a, mod.setBranch, { branchId: oldBranch })).toThrow(
    /outside/,
  );
});

test("Google profiles come from verified issuer claims; audience and expiration apply to reducer calls too", () => {
  const google = auth("google-sub", 10n, {
    iss: "https://accounts.google.com",
    aud: clientId,
    exp: 3600,
    name: "Google Person",
    email: "private@example.com",
  });
  call(google, mod.onConnect);
  expect(h.db.profile.identity.find(identity(google))).toMatchObject({
    provider: "google",
    displayName: "Google Person",
  });
  expect(
    JSON.stringify(
      h.db.profile.identity.find(identity(google)),
      (_key, value) => (typeof value === "bigint" ? String(value) : value),
    ),
  ).not.toContain("private@example.com");
  const wrong = auth("google-sub", 11n, {
    iss: "https://accounts.google.com",
    aud: "other-app",
    exp: 3600,
  });
  expect(() => call(wrong, mod.onConnect)).toThrow(/different app/);
  expect(() => call(wrong, mod.sampleClock, { clientSentUs: 1n })).toThrow(
    /different app/,
  );
  h.clock.advance(new TimeDuration(3_600_000_000n));
  expect(() => call(google, mod.sampleClock, { clientSentUs: 1n })).toThrow(
    /expired/,
  );
  const impostor = auth("google-sub", 12n, {
    name: "Google Person",
    provider: "google",
  });
  call(impostor, mod.onConnect);
  expect(h.db.profile.identity.find(identity(impostor))?.provider).toBe(
    "guest",
  );
  expect(identity(impostor).isEqual(identity(google))).toBe(false);
});

test("browser callback rejects wrong nonce, issuer, audience and expired credentials before connecting", () => {
  const claims = {
    iss: "https://accounts.google.com",
    sub: "test",
    aud: clientId,
    exp: 3600,
    nonce: "nonce",
  };
  const token = (c: object) =>
    `header.${Buffer.from(JSON.stringify(c)).toString("base64url")}.signature`;
  expect(validateCredential(token(claims), "nonce", clientId, 1).sub).toBe(
    "test",
  );
  for (const changed of [
    { nonce: "wrong" },
    { iss: "https://impostor.example" },
    { aud: "other" },
    { exp: 1 },
    { azp: "other" },
  ])
    expect(() =>
      validateCredential(
        token({ ...claims, ...changed }),
        "nonce",
        clientId,
        2,
      ),
    ).toThrow();
});
