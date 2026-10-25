import {
  schema,
  table,
  t,
  SenderError,
  type ReducerCtx,
} from "spacetimedb/server";

const pose = {
  px: t.f32(),
  py: t.f32(),
  pz: t.f32(),
  qx: t.f32(),
  qy: t.f32(),
  qz: t.f32(),
  qw: t.f32(),
  vx: t.f32(),
  vy: t.f32(),
  vz: t.f32(),
};
const head = {
  hx: t.f32(),
  hy: t.f32(),
  hz: t.f32(),
  hqx: t.f32(),
  hqy: t.f32(),
  hqz: t.f32(),
  hqw: t.f32(),
  lx: t.f32(),
  ly: t.f32(),
  lz: t.f32(),
  rx: t.f32(),
  ry: t.f32(),
  rz: t.f32(),
};
const db = schema({
  memory: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      requestId: t.string().unique(),
      owner: t.identity(),
      pipelineIdentity: t.identity(),
      title: t.string(),
      sourceUrl: t.string(),
      manifestUrl: t.string(),
      status: t.string(),
      progress: t.f32(),
      error: t.string(),
      durationUs: t.u64(),
      createdAt: t.timestamp(),
    },
  ),
  room: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      memoryId: t.u64(),
      joinCode: t.string().unique(),
      host: t.identity(),
    },
  ),
  // Additive policy: existing collaborative rooms keep their behavior; new parties have a leader.
  party: table(
    { public: true },
    {
      roomId: t.u64().primaryKey(),
      pendingMemoryId: t.u64(),
      sceneRevision: t.u32(),
    },
  ),
  profile: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      provider: t.string(),
      displayName: t.string(),
    },
  ),
  player: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      roomId: t.u64().index("btree"),
      name: t.string(),
      device: t.string(),
      color: t.u32(),
      online: t.bool(),
      ...head,
    },
  ),
  connection: table(
    {},
    {
      id: t.connectionId().primaryKey(),
      identity: t.identity().index("btree"),
    },
  ),
  clockSample: table(
    { public: true },
    {
      identity: t.identity().primaryKey(),
      clientSentUs: t.u64(),
      serverTs: t.timestamp(),
    },
  ),
  timeline: table(
    { public: true },
    {
      roomId: t.u64().primaryKey(),
      branchId: t.u64(),
      paused: t.bool(),
      speed: t.f32(),
      anchorMediaUs: t.u64(),
      anchorServerTs: t.timestamp(),
    },
  ),
  branch: table(
    { public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      roomId: t.u64().index("btree"),
      memoryId: t.u64(),
      parentId: t.u64(),
      forkMediaUs: t.u64(),
      name: t.string(),
      creator: t.identity(),
    },
  ),
  objectState: table(
    { public: true },
    {
      key: t.string().primaryKey(),
      branchId: t.u64().index("btree"),
      objectId: t.string(),
      heldBy: t.identity().optional(),
      simOwner: t.identity().optional(),
      mode: t.string(),
      fromMediaUs: t.u64(),
      updatedAt: t.timestamp(),
      ...pose,
    },
  ),
  branchKeyframes: table(
    { public: true },
    {
      key: t.string().primaryKey(),
      branchId: t.u64().index("btree"),
      objectId: t.string(),
      startMediaUs: t.u64(),
      endMediaUs: t.u64(),
      keyframesJson: t.string(),
      author: t.identity(),
    },
  ),
});
export default db;
type Ctx = ReducerCtx<typeof db.schemaType>;
type Timeline = ReturnType<Ctx["db"]["timeline"]["roomId"]["find"]> & {};
type ObjectRow = ReturnType<Ctx["db"]["objectState"]["key"]["find"]> & {};
/** A thrown object whose owner sent nothing for this long is abandoned (see `abandoned`). */
const ABANDONED_AFTER_US = 15_000_000n;
const fail = (message: string): never => {
  throw new SenderError(message);
};
function text(value: string, max = 100) {
  if (!value.trim() || value.length > max) fail("Invalid text length");
  return value.trim();
}
/** Cuts a string to `max` UTF-16 units without splitting a surrogate pair. */
function clip(value: string, max: number) {
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/** Media seconds to microseconds, rounded the same way everywhere. */
const micros = (seconds: number) => BigInt(Math.round(seconds * 1e6));
function url(value: string) {
  if (!/^https?:\/\/[^\s]+$/.test(value) || value.length > 2048)
    fail("Expected an HTTP(S) asset URL");
}
function finite(values: Record<string, number>) {
  if (
    Object.values(values).some(
      (v) => !Number.isFinite(v) || Math.abs(v) > 100000,
    )
  )
    fail("Invalid pose");
}
function validPose(
  p: { qx: number; qy: number; qz: number; qw: number } & Record<
    string,
    number
  >,
) {
  finite(p);
  const norm = Math.hypot(p.qx, p.qy, p.qz, p.qw);
  if (Math.abs(norm - 1) > 0.05) fail("Quaternion must be normalized");
}
/** Room ids start at 1, so roomId 0n means the player left and is in no room. */
const NO_ROOM = 0n;
function authenticate(ctx: Ctx) {
  const jwt = ctx.senderAuth.jwt;
  if (jwt?.issuer === "https://accounts.google.com" || jwt?.issuer === "accounts.google.com")
    fail("Google sign-in has been replaced. Sign in with a name and personal key.");
}
function updateProfile(ctx: Ctx) {
  authenticate(ctx);
  // Reconnects must preserve a registered name. Keys stay with the client; the
  // host verifies their signed identity before any reducer can run.
  if (!ctx.db.profile.identity.find(ctx.sender)) ctx.db.profile.insert({
    identity: ctx.sender,
    provider: "guest",
    displayName: "",
  });
}
export const registerAccount = db.reducer({ name: t.string() }, (ctx, { name }) => {
  updateProfile(ctx);
  name = text(name, 40);
  const existing = ctx.db.profile.identity.find(ctx.sender)!;
  if (existing.provider === "key" && existing.displayName !== name)
    fail("This key already belongs to a registered name");
  ctx.db.profile.identity.update({ ...existing, provider: "key", displayName: name });
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, name });
});
function player(ctx: Ctx) {
  authenticate(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p?.online || p.roomId === NO_ROOM) return fail("Join a room first");
  return p;
}
function timeline(ctx: Ctx) {
  const p = player(ctx);
  return ctx.db.timeline.roomId.find(p.roomId) ?? fail("Room has no timeline");
}
function media(ctx: Ctx, tl: Timeline) {
  const room = ctx.db.room.id.find(tl.roomId)!;
  const m = ctx.db.memory.id.find(room.memoryId)!;
  const delta = tl.paused
    ? 0n
    : BigInt(
        Math.max(
          0,
          Math.round(
            Number(
              ctx.timestamp.microsSinceUnixEpoch -
                tl.anchorServerTs.microsSinceUnixEpoch,
            ) * tl.speed,
          ),
        ),
      );
  return tl.anchorMediaUs + delta > m.durationUs
    ? m.durationUs
    : tl.anchorMediaUs + delta;
}
/** Puts an object to rest at its last reported pose, with no holder or simulation owner. */
function settle(ctx: Ctx, o: ObjectRow) {
  return ctx.db.objectState.key.update({
    ...o,
    heldBy: undefined,
    simOwner: undefined,
    mode: "rest",
    vx: 0,
    vy: 0,
    vz: 0,
    updatedAt: ctx.timestamp,
  });
}
/**
 * A throw ("physics" row) is abandoned when its owner has sent nothing for more than 15 s.
 * moveObject (15 Hz during a simulation), release and saveBranchKeyframes all refresh
 * updatedAt, so a live simulation never expires. Anyone may then settle it: seek, fork and
 * setBranch clear it, and grab takes it over. Held rows never expire; leaveRoom and the
 * last disconnect clear them.
 */
function abandoned(ctx: Ctx, o: ObjectRow) {
  return (
    !!o.simOwner &&
    o.mode === "physics" &&
    ctx.timestamp.microsSinceUnixEpoch - o.updatedAt.microsSinceUnixEpoch >
      ABANDONED_AFTER_US
  );
}
/** True when any row passes `test` (every row by default). */
function some<T>(rows: Iterable<T>, test: (row: T) => boolean = () => true) {
  for (const row of rows) if (test(row)) return true;
  return false;
}
/**
 * Lets go of everything the sender holds or simulates: they left, switched rooms or dropped
 * their last connection. A take their own grab just forked that still has nothing recorded is
 * given up too (see `revertEmptyTake`).
 */
function clearOwnership(ctx: Ctx) {
  const cleared: ObjectRow[] = [];
  for (const o of [...ctx.db.objectState.iter()])
    if (o.simOwner?.isEqual(ctx.sender)) cleared.push(settle(ctx, o));
  for (const o of cleared) revertEmptyTake(ctx, o);
}
/**
 * `o` was just taken from the sender. When the room's current take was forked by the sender's
 * grab of `o` (creator, and the grab's time is the fork time) and holds no keyframe chunk of any
 * object, put the room back on the parent take, paused at the fork time: a reload or leave
 * mid-throw must not leave everyone on an empty take. The branch row stays, since clients never
 * handle branch deletes. Nothing changes while anyone else still holds or simulates an object
 * on that take.
 */
function revertEmptyTake(ctx: Ctx, o: ObjectRow) {
  const b = ctx.db.branch.id.find(o.branchId);
  const tl = b && ctx.db.timeline.roomId.find(b.roomId);
  if (!b || !tl || tl.branchId !== b.id) return;
  if (!b.creator.isEqual(ctx.sender) || b.forkMediaUs !== o.fromMediaUs) return;
  // Only takes a grab forked by itself ("First edit", "Edit <id>"); a take made with forkBranch stays.
  if (b.name !== "First edit" && !b.name.startsWith("Edit ")) return;
  if (some(ctx.db.branchKeyframes.branchId.filter(b.id))) return;
  if (some(ctx.db.objectState.branchId.filter(b.id), (row) => !!row.simOwner))
    return;
  ctx.db.timeline.roomId.update({
    ...tl,
    branchId: b.parentId,
    paused: true,
    anchorMediaUs: b.forkMediaUs,
    anchorServerTs: ctx.timestamp,
  });
}
function enter(ctx: Ctx, roomId: bigint, name: string, device: string) {
  updateProfile(ctx);
  const profile = ctx.db.profile.identity.find(ctx.sender)!;
  name = profile.provider === "key" ? profile.displayName : text(name, 40);
  if (!["phone", "quest", "desktop"].includes(device)) fail("Unknown device");
  clearOwnership(ctx);
  const existing = ctx.db.player.identity.find(ctx.sender);
  const row = {
    identity: ctx.sender,
    roomId,
    name,
    device,
    color: Number(ctx.sender.__identity__ % 0xffffffn),
    online: true,
    hx: 0,
    hy: 1.6,
    hz: 2,
    hqx: 0,
    hqy: 0,
    hqz: 0,
    hqw: 1,
    lx: 0,
    ly: 0,
    lz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
  };
  if (existing)
    ctx.db.player.identity.update({
      ...existing,
      roomId,
      name,
      device,
      online: true,
    });
  else ctx.db.player.insert(row);
  if (existing && existing.roomId !== roomId) electLeader(ctx, existing.roomId);
  electLeader(ctx, roomId);
}
function ownsBranch(ctx: Ctx, branchId: bigint) {
  const p = player(ctx);
  const b = ctx.db.branch.id.find(branchId);
  if (
    !b ||
    b.roomId !== p.roomId ||
    b.memoryId !== ctx.db.room.id.find(p.roomId)?.memoryId
  )
    return fail("Branch is outside your room");
  return b;
}
function noActiveSimulation(ctx: Ctx, branchId: bigint) {
  for (const o of [...ctx.db.objectState.branchId.filter(branchId)])
    if (abandoned(ctx, o)) settle(ctx, o);
    else if (o.simOwner)
      fail("Wait for objects to settle or release them first");
}
/**
 * The owner of a still-open take re-grabbed this object at `fromMediaUs`, so it records over
 * its own trajectory from there on: drop every frame at or after that time. Chunks that start
 * there or later are deleted; a chunk that straddles it keeps only its earlier frames.
 */
function truncateChunks(
  ctx: Ctx,
  branchId: bigint,
  objectId: string,
  fromMediaUs: bigint,
) {
  for (const chunk of [...ctx.db.branchKeyframes.branchId.filter(branchId)]) {
    if (chunk.objectId !== objectId || chunk.endMediaUs < fromMediaUs) continue;
    const kept =
      chunk.startMediaUs < fromMediaUs
        ? (JSON.parse(chunk.keyframesJson) as { t: number }[]).filter(
            (f) => micros(f.t) < fromMediaUs,
          )
        : [];
    if (kept.length)
      ctx.db.branchKeyframes.key.update({
        ...chunk,
        keyframesJson: JSON.stringify(kept),
        endMediaUs: micros(kept.at(-1)!.t),
      });
    else ctx.db.branchKeyframes.key.delete(chunk.key);
  }
}
function fork(ctx: Ctx, tl: Timeline, name: string) {
  noActiveSimulation(ctx, tl.branchId);
  const room = ctx.db.room.id.find(tl.roomId)!;
  const at = media(ctx, tl);
  const b = ctx.db.branch.insert({
    id: 0n,
    roomId: room.id,
    memoryId: room.memoryId,
    parentId: tl.branchId,
    forkMediaUs: at,
    name: text(name),
    creator: ctx.sender,
  });
  // Parent state is resolved by the client only up to the fork point. Do not copy future rest poses.
  const next = {
    ...tl,
    branchId: b.id,
    paused: true,
    anchorMediaUs: at,
    anchorServerTs: ctx.timestamp,
  };
  ctx.db.timeline.roomId.update(next);
  return next;
}

export const createMemory = db.reducer(
  {
    requestId: t.string(),
    title: t.string(),
    sourceUrl: t.string(),
    manifestUrl: t.string(),
    pipelineIdentity: t.identity(),
    durationUs: t.u64(),
  },
  (ctx, args) => {
    authenticate(ctx);
    text(args.requestId, 80);
    text(args.title, 120);
    if (args.sourceUrl) url(args.sourceUrl);
    if (args.manifestUrl) url(args.manifestUrl);
    if (!args.sourceUrl && !args.manifestUrl)
      fail("Source or manifest required");
    if (args.durationUs === 0n || args.durationUs > 3_600_000_000n)
      fail("Duration must be 0–3600 seconds");
    const existing = ctx.db.memory.requestId.find(args.requestId);
    if (existing) {
      if (
        !existing.owner.isEqual(ctx.sender) ||
        existing.sourceUrl !== args.sourceUrl ||
        existing.title !== args.title.trim() ||
        existing.durationUs !== args.durationUs ||
        !existing.pipelineIdentity.isEqual(args.pipelineIdentity) ||
        (!args.sourceUrl && existing.manifestUrl !== args.manifestUrl)
      )
        fail("Request ID already used");
      return;
    }
    ctx.db.memory.insert({
      id: 0n,
      ...args,
      title: args.title.trim(),
      owner: ctx.sender,
      status: args.manifestUrl ? "ready" : "uploaded",
      progress: args.manifestUrl ? 1 : 0,
      error: "",
      createdAt: ctx.timestamp,
    });
  },
);
export const setMemoryStatus = db.reducer(
  {
    memoryId: t.u64(),
    status: t.string(),
    progress: t.f32(),
    manifestUrl: t.string(),
    error: t.string(),
  },
  (ctx, args) => {
    authenticate(ctx);
    const m = ctx.db.memory.id.find(args.memoryId) ?? fail("No such memory");
    if (!m.pipelineIdentity.isEqual(ctx.sender))
      fail("Only the assigned pipeline identity may update status");
    const allowed: Record<string, string[]> = {
      uploaded: ["processing", "failed"],
      processing: ["processing", "ready", "failed"],
      failed: ["processing"],
      ready: ["ready"],
    };
    if (!allowed[m.status]?.includes(args.status))
      fail("Invalid status transition");
    if (
      !Number.isFinite(args.progress) ||
      args.progress < 0 ||
      args.progress > 1 ||
      args.error.length > 2000
    )
      fail("Invalid progress/error");
    if (
      m.status === "processing" &&
      args.status === "processing" &&
      args.progress < m.progress
    )
      fail("Progress cannot go backwards");
    if (args.manifestUrl) url(args.manifestUrl);
    if (args.status === "ready" && (!args.manifestUrl || args.progress !== 1))
      fail("Ready requires manifest URL and progress 1");
    ctx.db.memory.id.update({
      ...m,
      ...args,
      manifestUrl: args.manifestUrl || m.manifestUrl,
    });
    if (args.status === "ready") {
      for (const p of [...ctx.db.party.iter()])
        if (p.pendingMemoryId === m.id) activateMemory(ctx, p.roomId, m.id);
    }
  },
);
const roomArgs = { memoryId: t.u64(), name: t.string(), device: t.string() };
function makeRoom(
  ctx: Ctx,
  args: { memoryId: bigint; name: string; device: string },
  party: boolean,
) {
  authenticate(ctx);
  const m = ctx.db.memory.id.find(args.memoryId) ?? fail("No such memory");
  if (m.status !== "ready") fail("Memory is not ready");
  // ctx.random is seeded from the reducer timestamp and its first draw is badly biased
  // (about 11% of first draws make a 000000x code), so discard it.
  ctx.random.uint32();
  let code = "";
  for (let tries = 0; tries < 20; tries++) {
    code = (ctx.random.uint32() >>> 0)
      .toString(36)
      .toUpperCase()
      .padStart(7, "0");
    if (!ctx.db.room.joinCode.find(code)) break;
    code = "";
  }
  if (!code) fail("Could not allocate room code");
  const room = ctx.db.room.insert({
    id: 0n,
    memoryId: m.id,
    host: ctx.sender,
    joinCode: code,
  });
  ctx.db.timeline.insert({
    roomId: room.id,
    branchId: 0n,
    paused: false,
    speed: 1,
    anchorMediaUs: 0n,
    anchorServerTs: ctx.timestamp,
  });
  if (party)
    ctx.db.party.insert({
      roomId: room.id,
      pendingMemoryId: 0n,
      sceneRevision: 0,
    });
  enter(ctx, room.id, args.name, args.device);
}
export const createRoom = db.reducer(roomArgs, (ctx, args) =>
  makeRoom(ctx, args, false),
);
export const createParty = db.reducer(roomArgs, (ctx, args) =>
  makeRoom(ctx, args, true),
);

/** Only parties use leader-controlled time. Legacy collaborative rooms remain compatible. */
function requireLeader(ctx: Ctx, roomId: bigint) {
  if (
    ctx.db.party.roomId.find(roomId) &&
    !ctx.db.room.id.find(roomId)?.host.isEqual(ctx.sender)
  )
    fail("Only the party leader can control time or change the scene");
}
function electLeader(ctx: Ctx, roomId: bigint) {
  if (!ctx.db.party.roomId.find(roomId)) return;
  const room = ctx.db.room.id.find(roomId)!;
  const members = [...ctx.db.player.roomId.filter(roomId)]
    .filter((p) => p.online)
    .sort((a, b) =>
      a.identity.__identity__ < b.identity.__identity__ ? -1 : 1,
    );
  if (members.some((p) => p.identity.isEqual(room.host))) return;
  if (members.length)
    ctx.db.room.id.update({ ...room, host: members[0].identity });
  else {
    const tl = ctx.db.timeline.roomId.find(roomId)!;
    ctx.db.timeline.roomId.update({
      ...tl,
      paused: true,
      anchorMediaUs: media(ctx, tl),
      anchorServerTs: ctx.timestamp,
    });
  }
}
export const transferLeadership = db.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    const p = player(ctx);
    if (!ctx.db.party.roomId.find(p.roomId)) fail("Join a party first");
    requireLeader(ctx, p.roomId);
    const next = ctx.db.player.identity.find(identity);
    if (!next?.online || next.roomId !== p.roomId)
      fail("Choose a connected party member");
    const room = ctx.db.room.id.find(p.roomId)!;
    ctx.db.room.id.update({ ...room, host: identity });
  },
);
function activateMemory(ctx: Ctx, roomId: bigint, memoryId: bigint) {
  const room = ctx.db.room.id.find(roomId)!;
  const party = ctx.db.party.roomId.find(roomId)!;
  for (const b of ctx.db.branch.roomId.filter(roomId))
    for (const o of [...ctx.db.objectState.branchId.filter(b.id)])
      if (o.simOwner) settle(ctx, o);
  ctx.db.room.id.update({ ...room, memoryId });
  ctx.db.party.roomId.update({
    ...party,
    pendingMemoryId: 0n,
    sceneRevision: party.sceneRevision + 1,
  });
  ctx.db.timeline.roomId.update({
    roomId,
    branchId: 0n,
    paused: true,
    speed: 1,
    anchorMediaUs: 0n,
    anchorServerTs: ctx.timestamp,
  });
}
export const attachPartyMemory = db.reducer(
  { memoryId: t.u64() },
  (ctx, { memoryId }) => {
    const p = player(ctx);
    const party =
      ctx.db.party.roomId.find(p.roomId) ?? fail("Join a party first");
    requireLeader(ctx, p.roomId);
    if (memoryId === 0n) {
      ctx.db.party.roomId.update({ ...party, pendingMemoryId: 0n });
      return;
    }
    const memory = ctx.db.memory.id.find(memoryId) ?? fail("No such memory");
    if (memory.status === "ready") activateMemory(ctx, p.roomId, memoryId);
    else ctx.db.party.roomId.update({ ...party, pendingMemoryId: memoryId });
  },
);
export const setPlaybackSpeed = db.reducer(
  { speed: t.f32() },
  (ctx, { speed }) => {
    const tl = timeline(ctx);
    requireLeader(ctx, tl.roomId);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 2)
      fail("Speed must be between 0.25 and 2");
    ctx.db.timeline.roomId.update({
      ...tl,
      speed,
      anchorMediaUs: media(ctx, tl),
      anchorServerTs: ctx.timestamp,
    });
  },
);
export const joinRoom = db.reducer(
  { joinCode: t.string(), name: t.string(), device: t.string() },
  (ctx, args) => {
    const room =
      ctx.db.room.joinCode.find(args.joinCode.trim().toUpperCase()) ??
      fail("Room not found");
    enter(ctx, room.id, args.name, args.device);
  },
);
export const leaveRoom = db.reducer((ctx) => {
  authenticate(ctx);
  clearOwnership(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  // NO_ROOM, not just offline: a later reconnect must not put the player back in this room.
  if (p)
    ctx.db.player.identity.update({ ...p, roomId: NO_ROOM, online: false });
  if (p) electLeader(ctx, p.roomId);
});
export const setPose = db.reducer(head, (ctx, pose) => {
  finite(pose);
  const p = player(ctx);
  ctx.db.player.identity.update({ ...p, ...pose });
});
export const setPaused = db.reducer({ paused: t.bool() }, (ctx, { paused }) => {
  const tl = timeline(ctx);
  requireLeader(ctx, tl.roomId);
  ctx.db.timeline.roomId.update({
    ...tl,
    paused,
    anchorMediaUs: media(ctx, tl),
    anchorServerTs: ctx.timestamp,
  });
});
export const seek = db.reducer({ mediaUs: t.u64() }, (ctx, { mediaUs }) => {
  const tl = timeline(ctx);
  requireLeader(ctx, tl.roomId);
  noActiveSimulation(ctx, tl.branchId);
  const r = ctx.db.room.id.find(tl.roomId)!;
  const m = ctx.db.memory.id.find(r.memoryId)!;
  if (mediaUs > m.durationUs) fail("Seek is outside the memory");
  ctx.db.timeline.roomId.update({
    ...tl,
    anchorMediaUs: mediaUs,
    anchorServerTs: ctx.timestamp,
  });
});
export const forkBranch = db.reducer({ name: t.string() }, (ctx, { name }) => {
  const tl = timeline(ctx);
  requireLeader(ctx, tl.roomId);
  if (!tl.paused) fail("Pause before forking");
  fork(ctx, tl, name);
});
export const setBranch = db.reducer(
  { branchId: t.u64() },
  (ctx, { branchId }) => {
    const tl = timeline(ctx);
    requireLeader(ctx, tl.roomId);
    noActiveSimulation(ctx, tl.branchId);
    const b = branchId === 0n ? null : ownsBranch(ctx, branchId);
    ctx.db.timeline.roomId.update({
      ...tl,
      branchId,
      paused: true,
      anchorMediaUs: b?.forkMediaUs ?? 0n,
      anchorServerTs: ctx.timestamp,
    });
  },
);
export const grab = db.reducer(
  { objectId: t.string(), ...pose },
  (ctx, { objectId, ...p }) => {
    text(objectId, 100);
    validPose(p);
    let tl = timeline(ctx);
    if (!tl.paused) fail("Pause before grabbing");
    if (tl.branchId === 0n) tl = fork(ctx, tl, "First edit");
    let key = `${tl.branchId}:${objectId}`,
      old = ctx.db.objectState.key.find(key);
    // An abandoned throw rests where it was last reported; from here on it is a resting object.
    if (old && abandoned(ctx, old)) old = settle(ctx, old);
    // Catching an object another player holds or is still simulating is rejected.
    if (old?.simOwner && !old.simOwner.isEqual(ctx.sender))
      fail("Object is owned by another player");
    // Recordings are immutable once an object rests, so child takes never lose inherited data.
    // Grabbing an object that already rests on this branch (row, no simOwner) forks a new take
    // "Edit <id>"; grabbing on Original forked "First edit" above. Never edit a resting row in place.
    if (old && !old.simOwner) {
      tl = fork(ctx, tl, clip(`Edit ${objectId}`, 100));
      key = `${tl.branchId}:${objectId}`;
      old = null;
    }
    const fromMediaUs = media(ctx, tl);
    // Re-grabbing your own held or still-simulating object keeps the take open: the next throw
    // records over this one from fromMediaUs, so drop those frames now or its chunks would be
    // rejected as already recorded or overlapping.
    if (old) truncateChunks(ctx, tl.branchId, objectId, fromMediaUs);
    const row = {
      key,
      branchId: tl.branchId,
      objectId,
      ...p,
      heldBy: ctx.sender,
      simOwner: ctx.sender,
      mode: "held",
      fromMediaUs,
      updatedAt: ctx.timestamp,
    };
    if (old) ctx.db.objectState.key.update(row);
    else ctx.db.objectState.insert(row);
  },
);
function owned(ctx: Ctx, objectId: string) {
  const tl = timeline(ctx);
  const o = ctx.db.objectState.key.find(`${tl.branchId}:${objectId}`);
  if (!o?.simOwner?.isEqual(ctx.sender))
    return fail("Not the simulation owner");
  return o;
}
export const moveObject = db.reducer(
  { objectId: t.string(), ...pose },
  (ctx, { objectId, ...p }) => {
    validPose(p);
    const o = owned(ctx, objectId);
    ctx.db.objectState.key.update({ ...o, ...p, updatedAt: ctx.timestamp });
  },
);
export const release = db.reducer(
  { objectId: t.string(), rest: t.bool(), ...pose },
  (ctx, { objectId, rest, ...p }) => {
    validPose(p);
    const o = owned(ctx, objectId);
    ctx.db.objectState.key.update({
      ...o,
      ...p,
      heldBy: undefined,
      simOwner: rest ? undefined : ctx.sender,
      mode: rest ? "rest" : "physics",
      updatedAt: ctx.timestamp,
    });
  },
);
export const saveBranchKeyframes = db.reducer(
  {
    branchId: t.u64(),
    objectId: t.string(),
    startMediaUs: t.u64(),
    keyframesJson: t.string(),
  },
  (ctx, args) => {
    ownsBranch(ctx, args.branchId);
    const o =
      ctx.db.objectState.key.find(`${args.branchId}:${args.objectId}`) ??
      fail("Unknown object");
    if (!o?.simOwner?.isEqual(ctx.sender))
      fail("Only the simulation owner can record a trajectory");
    if (args.keyframesJson.length > 60000) fail("Chunk too large");
    let frames: any;
    try {
      frames = JSON.parse(args.keyframesJson);
    } catch {
      fail("Malformed keyframes");
    }
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 120)
      fail("Expected 1–120 keyframes");
    let previous = -1;
    for (const f of frames) {
      if (
        // Check the frame is an object before reading f.t: '[null]' must be a SenderError.
        !f ||
        typeof f !== "object" ||
        Array.isArray(f) ||
        typeof f.t !== "number" ||
        !Number.isFinite(f.t) ||
        f.t < 0 ||
        f.t <= previous ||
        !Array.isArray(f.p) ||
        f.p.length !== 3 ||
        !Array.isArray(f.q) ||
        f.q.length !== 4 ||
        [...f.p, ...f.q].some(
          (v) =>
            typeof v !== "number" ||
            !Number.isFinite(v) ||
            Math.abs(v) > 100000,
        ) ||
        Math.abs(Math.hypot(...f.q) - 1) > 0.05
      )
        fail("Invalid keyframe");
      previous = f.t;
    }
    const start = micros(frames[0].t);
    const end = micros(frames.at(-1).t);
    if (start !== args.startMediaUs || start < o.fromMediaUs)
      fail("Keyframe time mismatch");
    const room = ctx.db.room.id.find(player(ctx).roomId)!;
    if (end > ctx.db.memory.id.find(room.memoryId)!.durationUs)
      fail("Keyframes exceed memory duration");
    const key = `${args.branchId}:${args.objectId}:${start}`;
    const old = ctx.db.branchKeyframes.key.find(key);
    if (old) {
      // Retrying the exact same chunk is a no-op.
      if (
        !old.author.isEqual(ctx.sender) ||
        old.keyframesJson !== args.keyframesJson
      )
        fail("Chunk already recorded");
    } else {
      for (const chunk of ctx.db.branchKeyframes.branchId.filter(args.branchId))
        if (
          chunk.objectId === args.objectId &&
          start < chunk.endMediaUs &&
          end > chunk.startMediaUs
        )
          fail("Overlapping keyframe chunks");
      ctx.db.branchKeyframes.insert({
        key,
        ...args,
        endMediaUs: end,
        author: ctx.sender,
      });
    }
    // A saved chunk shows the owner is still at work, so the throw is not abandoned.
    ctx.db.objectState.key.update({ ...o, updatedAt: ctx.timestamp });
  },
);
export const onConnect = db.clientConnected((ctx) => {
  updateProfile(ctx);
  if (ctx.connectionId)
    ctx.db.connection.insert({ id: ctx.connectionId, identity: ctx.sender });
  const p = ctx.db.player.identity.find(ctx.sender);
  // Resume the room after a dropped connection, but never after an explicit leaveRoom.
  if (p && p.roomId !== NO_ROOM)
    ctx.db.player.identity.update({ ...p, online: true });
  if (p) electLeader(ctx, p.roomId);
});
export const onDisconnect = db.clientDisconnected((ctx) => {
  if (ctx.connectionId) ctx.db.connection.id.delete(ctx.connectionId);
  if ([...ctx.db.connection.identity.filter(ctx.sender)].length) return;
  clearOwnership(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, online: false });
  if (p) electLeader(ctx, p.roomId);
});

export const sampleClock = db.reducer(
  { clientSentUs: t.u64() },
  (ctx, { clientSentUs }) => {
    authenticate(ctx);
    const row = { identity: ctx.sender, clientSentUs, serverTs: ctx.timestamp };
    if (ctx.db.clockSample.identity.find(ctx.sender))
      ctx.db.clockSample.identity.update(row);
    else ctx.db.clockSample.insert(row);
  },
);
