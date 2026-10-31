import { t } from "spacetimedb/server";
import db, { pose } from "../schema";
import type { Ctx } from "../schema";
import {
  abandoned,
  clip,
  fail,
  fork,
  media,
  micros,
  ownsBranch,
  player,
  settle,
  text,
  timeline,
  validPose,
} from "../helpers";

/**
 * The owner of a still-open take re-grabbed this object at `fromMediaUs`, so it records over
 * its own trajectory from there on: drop every frame at or after that time. Chunks that start
 * there or later are deleted; a chunk that straddles it keeps only its earlier frames.
 */
function truncateChunks(ctx: Ctx, branchId: bigint, objectId: string, fromMediaUs: bigint) {
  for (const chunk of [...ctx.db.branchKeyframes.branchId.filter(branchId)]) {
    if (chunk.objectId !== objectId || chunk.endMediaUs < fromMediaUs) continue;
    const kept =
      chunk.startMediaUs < fromMediaUs
        ? (JSON.parse(chunk.keyframesJson) as { t: number }[]).filter((f) => micros(f.t) < fromMediaUs)
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
export const grab = db.reducer({ objectId: t.string(), ...pose }, (ctx, { objectId, ...p }) => {
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
  if (old?.simOwner && !old.simOwner.isEqual(ctx.sender)) fail("Object is owned by another player");
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
});
function owned(ctx: Ctx, objectId: string) {
  const tl = timeline(ctx);
  const o = ctx.db.objectState.key.find(`${tl.branchId}:${objectId}`);
  if (!o?.simOwner?.isEqual(ctx.sender)) return fail("Not the simulation owner");
  return o;
}
export const moveObject = db.reducer({ objectId: t.string(), ...pose }, (ctx, { objectId, ...p }) => {
  validPose(p);
  const o = owned(ctx, objectId);
  ctx.db.objectState.key.update({ ...o, ...p, updatedAt: ctx.timestamp });
});
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
    const o = ctx.db.objectState.key.find(`${args.branchId}:${args.objectId}`) ?? fail("Unknown object");
    if (!o?.simOwner?.isEqual(ctx.sender)) fail("Only the simulation owner can record a trajectory");
    if (args.keyframesJson.length > 60000) fail("Chunk too large");
    let frames: unknown;
    try {
      frames = JSON.parse(args.keyframesJson);
    } catch {
      fail("Malformed keyframes");
    }
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 120) fail("Expected 1–120 keyframes");
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
        [...f.p, ...f.q].some((v) => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 100000) ||
        Math.abs(Math.hypot(...f.q) - 1) > 0.05
      )
        fail("Invalid keyframe");
      previous = f.t;
    }
    const start = micros(frames[0].t);
    const end = micros(frames.at(-1).t);
    if (start !== args.startMediaUs || start < o.fromMediaUs) fail("Keyframe time mismatch");
    const room = ctx.db.room.id.find(player(ctx).roomId)!;
    if (end > ctx.db.memory.id.find(room.memoryId)!.durationUs) fail("Keyframes exceed memory duration");
    const key = `${args.branchId}:${args.objectId}:${start}`;
    const old = ctx.db.branchKeyframes.key.find(key);
    if (old) {
      // Retrying the exact same chunk is a no-op.
      if (!old.author.isEqual(ctx.sender) || old.keyframesJson !== args.keyframesJson) fail("Chunk already recorded");
    } else {
      for (const chunk of ctx.db.branchKeyframes.branchId.filter(args.branchId))
        if (chunk.objectId === args.objectId && start < chunk.endMediaUs && end > chunk.startMediaUs)
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
