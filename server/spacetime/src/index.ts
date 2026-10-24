// SpacetimeDB module for Memory Replay. See docs/PLAN.md section 2.4.
// API shape is SpacetimeDB 2.x TypeScript (schema/table/t from "spacetimedb/server").
// FIRST TASK for the owner: run `spacetime init --lang typescript tmp --local` once the CLI installs,
// diff its template against this file, and fix any API names that moved in 2.13.
import { schema, table, t } from "spacetimedb/server";

const vec3 = { x: t.f32(), y: t.f32(), z: t.f32() };

const db = schema({
  memory: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    title: t.string(),
    manifestUrl: t.string(),
    status: t.string(), // uploaded | processing | ready | failed
    progress: t.f32(), // 0..1, written by the pipeline
    createdAt: t.timestamp(),
  }),
  room: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(),
    memoryId: t.u64(),
    joinCode: t.string().unique(),
    host: t.identity(),
  }),
  player: table({ public: true }, {
    identity: t.identity().primaryKey(),
    roomId: t.u64().index("btree"),
    name: t.string(),
    device: t.string(), // quest | phone | desktop
    color: t.u32(),
    online: t.bool(),
    // head + hands, sent at 10-15 Hz and interpolated on clients
    hx: t.f32(), hy: t.f32(), hz: t.f32(), hqx: t.f32(), hqy: t.f32(), hqz: t.f32(), hqw: t.f32(),
    lx: t.f32(), ly: t.f32(), lz: t.f32(),
    rx: t.f32(), ry: t.f32(), rz: t.f32(),
  }),
  // Shared clock. Clients compute: t = anchorMediaUs + (now - anchorServerTs) * speed (when !paused).
  // Only written on play / pause / seek / branch switch, never per frame.
  timeline: table({ public: true }, {
    roomId: t.u64().primaryKey(),
    branchId: t.u64(), // 0 = the original recording
    paused: t.bool(),
    speed: t.f32(),
    anchorMediaUs: t.u64(),
    anchorServerTs: t.timestamp(),
  }),
  branch: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(),
    memoryId: t.u64().index("btree"),
    parentId: t.u64(),
    forkMediaUs: t.u64(),
    name: t.string(),
    creator: t.identity(),
  }),
  // Per-branch override of one object. Missing row = object follows its recorded track.
  objectState: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(),
    branchId: t.u64().index("btree"),
    objectId: t.string(),
    heldBy: t.identity().optional(),
    mode: t.string(), // held (in a hand) | thrown (owner still simulating) | rest
    fromMediaUs: t.u64(),
    px: t.f32(), py: t.f32(), pz: t.f32(),
    qx: t.f32(), qy: t.f32(), qz: t.f32(), qw: t.f32(),
    vx: t.f32(), vy: t.f32(), vz: t.f32(),
  }),
  // Recorded physics trajectory for a touched object, so a branch replays the same for everyone.
  branchKeyframes: table({ public: true }, {
    id: t.u64().primaryKey().autoInc(),
    branchId: t.u64().index("btree"),
    objectId: t.string(),
    startMediaUs: t.u64(),
    keyframesJson: t.string(), // [{t,p,q}] chunk, ~1-2 s per row
  }),
});
export default db;

// Modules must be deterministic: Math.random / Date.now are unavailable. Use ctx.random / ctx.timestamp.
function newJoinCode(ctx: any): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  for (let attempt = 0; attempt < 20; attempt++) {
    let s = "";
    for (let i = 0; i < 4; i++) s += a[ctx.random.integerInRange(0, a.length - 1)];
    if (!ctx.db.room.joinCode.find(s)) return s;
  }
  throw new Error("could not allocate a join code");
}

export const createMemory = db.reducer({ title: t.string(), manifestUrl: t.string() }, (ctx, { title, manifestUrl }) => {
  ctx.db.memory.insert({ id: 0n, owner: ctx.sender, title, manifestUrl, status: "uploaded", progress: 0, createdAt: ctx.timestamp });
});

export const setMemoryStatus = db.reducer({ memoryId: t.u64(), status: t.string(), progress: t.f32(), manifestUrl: t.string() },
  (ctx, { memoryId, status, progress, manifestUrl }) => {
    const m = ctx.db.memory.id.find(memoryId);
    if (!m) throw new Error("no such memory");
    ctx.db.memory.id.update({ ...m, status, progress, manifestUrl: manifestUrl || m.manifestUrl });
  });

export const createRoom = db.reducer({ memoryId: t.u64(), name: t.string(), device: t.string() }, (ctx, { memoryId, name, device }) => {
  const room = ctx.db.room.insert({ id: 0n, memoryId, joinCode: newJoinCode(ctx), host: ctx.sender });
  ctx.db.timeline.insert({ roomId: room.id, branchId: 0n, paused: false, speed: 1, anchorMediaUs: 0n, anchorServerTs: ctx.timestamp });
  upsertPlayer(ctx, room.id, name, device);
});

export const joinRoom = db.reducer({ joinCode: t.string(), name: t.string(), device: t.string() }, (ctx, { joinCode, name, device }) => {
  const room = ctx.db.room.joinCode.find(joinCode.toUpperCase());
  if (!room) throw new Error("room not found");
  upsertPlayer(ctx, room.id, name, device);
});

function upsertPlayer(ctx: any, roomId: bigint, name: string, device: string) {
  const zero = { hx: 0, hy: 1.6, hz: 0, hqx: 0, hqy: 0, hqz: 0, hqw: 1, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0 };
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    // switching rooms: let go of anything held in the old room so it doesn't stay locked
    if (existing.roomId !== roomId) dropHoldsBy(ctx, ctx.sender);
    ctx.db.player.identity.update({ ...existing, roomId, name, device, online: true });
  } else {
    ctx.db.player.insert({ identity: ctx.sender, roomId, name, device, color: ctx.random.integerInRange(0, 0xffffff), online: true, ...zero });
  }
}

/** Release every object this identity holds, in any room or branch. */
function dropHoldsBy(ctx: any, who: any) {
  for (const o of [...ctx.db.objectState.iter()]) {
    if (o.heldBy && o.heldBy.isEqual(who)) ctx.db.objectState.id.update({ ...o, heldBy: undefined, mode: "rest" });
  }
}

/** Release objects on `branchId` held by players of `roomId` (other rooms may be on the same branch). */
function dropRoomHolds(ctx: any, branchId: bigint, roomId: bigint) {
  for (const o of [...ctx.db.objectState.branchId.filter(branchId)]) {
    if (!o.heldBy) continue;
    const holder = ctx.db.player.identity.find(o.heldBy);
    if (holder && holder.roomId === roomId) ctx.db.objectState.id.update({ ...o, heldBy: undefined, mode: "rest" });
  }
}

export const setPose = db.reducer({
  hx: t.f32(), hy: t.f32(), hz: t.f32(), hqx: t.f32(), hqy: t.f32(), hqz: t.f32(), hqw: t.f32(),
  lx: t.f32(), ly: t.f32(), lz: t.f32(), rx: t.f32(), ry: t.f32(), rz: t.f32(),
}, (ctx, pose) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, ...pose });
});

function nowMediaUs(tl: any, nowMicros: bigint): bigint {
  if (tl.paused) return tl.anchorMediaUs;
  const elapsed = nowMicros - tl.anchorServerTs.microsSinceUnixEpoch;
  return tl.anchorMediaUs + BigInt(Math.round(Number(elapsed) * tl.speed));
}

function myTimeline(ctx: any) {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) throw new Error("join a room first");
  const tl = ctx.db.timeline.roomId.find(p.roomId);
  if (!tl) throw new Error("room has no timeline");
  return tl;
}

export const setPaused = db.reducer({ paused: t.bool() }, (ctx, { paused }) => {
  const tl = myTimeline(ctx);
  const at = nowMediaUs(tl, ctx.timestamp.microsSinceUnixEpoch);
  ctx.db.timeline.roomId.update({ ...tl, paused, anchorMediaUs: at, anchorServerTs: ctx.timestamp });
});

export const seek = db.reducer({ mediaUs: t.u64() }, (ctx, { mediaUs }) => {
  const tl = myTimeline(ctx);
  ctx.db.timeline.roomId.update({ ...tl, anchorMediaUs: mediaUs, anchorServerTs: ctx.timestamp });
});

/**
 * Fork the room's current branch at the current playhead, pause, and switch the room to the new branch.
 * The child inherits the parent's what-ifs that happened at or before the fork point.
 */
function forkInto(ctx: any, tl: any, name: string) {
  const room = ctx.db.room.id.find(tl.roomId)!;
  const at = nowMediaUs(tl, ctx.timestamp.microsSinceUnixEpoch);
  dropRoomHolds(ctx, tl.branchId, tl.roomId);
  const b = ctx.db.branch.insert({ id: 0n, memoryId: room.memoryId, parentId: tl.branchId, forkMediaUs: at, name, creator: ctx.sender });
  if (tl.branchId !== 0n) {
    const inherited = [...ctx.db.objectState.branchId.filter(tl.branchId)].filter((o: any) => o.fromMediaUs <= at);
    const ids = new Set(inherited.map((o: any) => o.objectId));
    for (const o of inherited) ctx.db.objectState.insert({ ...o, id: 0n, branchId: b.id, heldBy: undefined, mode: "rest" });
    for (const k of [...ctx.db.branchKeyframes.branchId.filter(tl.branchId)]) {
      if (ids.has(k.objectId)) ctx.db.branchKeyframes.insert({ ...k, id: 0n, branchId: b.id });
    }
  }
  const next = { ...tl, branchId: b.id, paused: true, anchorMediaUs: at, anchorServerTs: ctx.timestamp };
  ctx.db.timeline.roomId.update(next);
  return next;
}

export const forkBranch = db.reducer({ name: t.string() }, (ctx, { name }) => {
  forkInto(ctx, myTimeline(ctx), name);
});

export const setBranch = db.reducer({ branchId: t.u64() }, (ctx, { branchId }) => {
  const tl = myTimeline(ctx);
  if (branchId === tl.branchId) return;
  const b = branchId === 0n ? null : ctx.db.branch.id.find(branchId);
  if (branchId !== 0n) {
    const room = ctx.db.room.id.find(tl.roomId);
    if (!b || !room || b.memoryId !== room.memoryId) throw new Error("no such branch in this memory");
  }
  dropRoomHolds(ctx, tl.branchId, tl.roomId);
  ctx.db.timeline.roomId.update({ ...tl, branchId, anchorMediaUs: b ? b.forkMediaUs : 0n, anchorServerTs: ctx.timestamp });
});

const poseArgs = {
  px: t.f32(), py: t.f32(), pz: t.f32(), qx: t.f32(), qy: t.f32(), qz: t.f32(), qw: t.f32(),
  vx: t.f32(), vy: t.f32(), vz: t.f32(),
};

function findObject(ctx: any, branchId: bigint, objectId: string) {
  return [...ctx.db.objectState.branchId.filter(branchId)].find((o: any) => o.objectId === objectId);
}

/**
 * Take ownership of an object. Grabbing on the original recording (branch 0) forks a new branch
 * first, so nobody can edit the original. A thrown object can be caught (taken over) by anyone.
 */
export const grab = db.reducer({ objectId: t.string(), ...poseArgs }, (ctx, { objectId, ...pose }) => {
  let tl = myTimeline(ctx);
  if (tl.branchId === 0n) tl = forkInto(ctx, tl, "what if");
  const existing = findObject(ctx, tl.branchId, objectId);
  if (existing?.heldBy && !existing.heldBy.isEqual(ctx.sender) && existing.mode !== "thrown") throw new Error("held by someone else");
  const fromMediaUs = nowMediaUs(tl, ctx.timestamp.microsSinceUnixEpoch);
  if (existing) ctx.db.objectState.id.update({ ...existing, ...pose, heldBy: ctx.sender, mode: "held", fromMediaUs });
  else ctx.db.objectState.insert({ id: 0n, branchId: tl.branchId, objectId, heldBy: ctx.sender, mode: "held", fromMediaUs, ...pose });
});

/** Owner streams transforms (~15 Hz) while holding, and while its throw is still simulating. */
export const moveObject = db.reducer({ objectId: t.string(), ...poseArgs }, (ctx, { objectId, ...pose }) => {
  const o = findObject(ctx, myTimeline(ctx).branchId, objectId);
  if (!o || !o.heldBy || !o.heldBy.isEqual(ctx.sender)) throw new Error("not the owner");
  ctx.db.objectState.id.update({ ...o, ...pose });
});

/**
 * Owner opens the hand. rest=false: it's flying and the owner keeps simulating + streaming (mode "thrown").
 * rest=true: the body has gone to sleep; ownership ends.
 */
export const release = db.reducer({ objectId: t.string(), rest: t.bool(), ...poseArgs }, (ctx, { objectId, rest, ...pose }) => {
  const o = findObject(ctx, myTimeline(ctx).branchId, objectId);
  if (!o || !o.heldBy || !o.heldBy.isEqual(ctx.sender)) throw new Error("not the owner");
  ctx.db.objectState.id.update({ ...o, ...pose, heldBy: rest ? undefined : o.heldBy, mode: rest ? "rest" : "thrown" });
});

export const saveBranchKeyframes = db.reducer({ branchId: t.u64(), objectId: t.string(), startMediaUs: t.u64(), keyframesJson: t.string() },
  (ctx, args) => { ctx.db.branchKeyframes.insert({ id: 0n, ...args }); });

export const onConnect = db.clientConnected((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, online: true });
});

export const onDisconnect = db.clientDisconnected((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  ctx.db.player.identity.update({ ...p, online: false });
  dropHoldsBy(ctx, ctx.sender); // so others can grab it
});
