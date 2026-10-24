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
const fail = (message: string): never => {
  throw new SenderError(message);
};
function text(value: string, max = 100) {
  if (!value.trim() || value.length > max) fail("Invalid text length");
  return value.trim();
}
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
function player(ctx: Ctx) {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p?.online) return fail("Join a room first");
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
function clearOwnership(ctx: Ctx) {
  for (const o of ctx.db.objectState.iter())
    if (o.simOwner?.isEqual(ctx.sender))
      ctx.db.objectState.key.update({
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
function enter(ctx: Ctx, roomId: bigint, name: string, device: string) {
  text(name, 40);
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
}
function ownsBranch(ctx: Ctx, branchId: bigint) {
  const p = player(ctx);
  const b = ctx.db.branch.id.find(branchId);
  if (!b || b.roomId !== p.roomId) return fail("Branch is outside your room");
  return b;
}
function noActiveSimulation(ctx: Ctx, branchId: bigint) {
  for (const o of ctx.db.objectState.branchId.filter(branchId))
    if (o.simOwner) fail("Wait for objects to settle or release them first");
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
  },
);
export const createRoom = db.reducer(
  { memoryId: t.u64(), name: t.string(), device: t.string() },
  (ctx, args) => {
    const m = ctx.db.memory.id.find(args.memoryId) ?? fail("No such memory");
    if (m.status !== "ready") fail("Memory is not ready");
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
    enter(ctx, room.id, args.name, args.device);
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
  clearOwnership(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, online: false });
});
export const setPose = db.reducer(head, (ctx, pose) => {
  finite(pose);
  const p = player(ctx);
  ctx.db.player.identity.update({ ...p, ...pose });
});
export const setPaused = db.reducer({ paused: t.bool() }, (ctx, { paused }) => {
  const tl = timeline(ctx);
  ctx.db.timeline.roomId.update({
    ...tl,
    paused,
    anchorMediaUs: media(ctx, tl),
    anchorServerTs: ctx.timestamp,
  });
});
export const seek = db.reducer({ mediaUs: t.u64() }, (ctx, { mediaUs }) => {
  const tl = timeline(ctx);
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
  if (!tl.paused) fail("Pause before forking");
  fork(ctx, tl, name);
});
export const setBranch = db.reducer(
  { branchId: t.u64() },
  (ctx, { branchId }) => {
    const tl = timeline(ctx);
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
    if (old?.simOwner && !old.simOwner.isEqual(ctx.sender))
      fail("Object is owned by another player");
    // Preserve the recorded trajectory when an object is edited again.
    if (old && !old.simOwner) {
      tl = fork(ctx, tl, `Edit ${objectId}`);
      key = `${tl.branchId}:${objectId}`;
      old = null;
    }
    const row = {
      key,
      branchId: tl.branchId,
      objectId,
      ...p,
      heldBy: ctx.sender,
      simOwner: ctx.sender,
      mode: "held",
      fromMediaUs: media(ctx, tl),
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
    const start = BigInt(Math.round(frames[0].t * 1e6));
    const end = BigInt(Math.round(frames.at(-1).t * 1e6));
    if (start !== args.startMediaUs || start < o.fromMediaUs)
      fail("Keyframe time mismatch");
    const room = ctx.db.room.id.find(player(ctx).roomId)!;
    if (end > ctx.db.memory.id.find(room.memoryId)!.durationUs)
      fail("Keyframes exceed memory duration");
    const key = `${args.branchId}:${args.objectId}:${start}`;
    const old = ctx.db.branchKeyframes.key.find(key);
    if (old) {
      if (
        old.author.isEqual(ctx.sender) &&
        old.keyframesJson === args.keyframesJson
      )
        return;
      fail("Chunk already recorded");
    }
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
  },
);
export const onConnect = db.clientConnected((ctx) => {
  if (ctx.connectionId)
    ctx.db.connection.insert({ id: ctx.connectionId, identity: ctx.sender });
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, online: true });
});
export const onDisconnect = db.clientDisconnected((ctx) => {
  if (ctx.connectionId) ctx.db.connection.id.delete(ctx.connectionId);
  if ([...ctx.db.connection.identity.filter(ctx.sender)].length) return;
  clearOwnership(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p) ctx.db.player.identity.update({ ...p, online: false });
});

export const sampleClock = db.reducer(
  { clientSentUs: t.u64() },
  (ctx, { clientSentUs }) => {
    const row = { identity: ctx.sender, clientSentUs, serverTs: ctx.timestamp };
    if (ctx.db.clockSample.identity.find(ctx.sender))
      ctx.db.clockSample.identity.update(row);
    else ctx.db.clockSample.insert(row);
  },
);
