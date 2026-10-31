import { SenderError } from "spacetimedb/server";
import type { Ctx, Timeline, ObjectRow } from "./schema";

// Validation and room-state helpers shared by the reducers. Module code must be deterministic: use ctx.random and
// ctx.timestamp, never Math.random() or Date.now().

/** A thrown object whose owner sent nothing for this long is abandoned (see `abandoned`). */
const ABANDONED_AFTER_US = 15_000_000n;
export const fail = (message: string): never => {
  throw new SenderError(message);
};
export function text(value: string, max = 100) {
  if (!value.trim() || value.length > max) fail("Invalid text length");
  return value.trim();
}
/** Cuts a string to `max` UTF-16 units without splitting a surrogate pair. */
export function clip(value: string, max: number) {
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/** Media seconds to microseconds, rounded the same way everywhere. */
export const micros = (seconds: number) => BigInt(Math.round(seconds * 1e6));
export function url(value: string) {
  if (!/^https?:\/\/[^\s]+$/.test(value) || value.length > 2048) fail("Expected an HTTP(S) asset URL");
}
export function finite(values: Record<string, number>) {
  if (Object.values(values).some((v) => !Number.isFinite(v) || Math.abs(v) > 100000)) fail("Invalid pose");
}
export function validPose(p: { qx: number; qy: number; qz: number; qw: number } & Record<string, number>) {
  finite(p);
  const norm = Math.hypot(p.qx, p.qy, p.qz, p.qw);
  if (Math.abs(norm - 1) > 0.05) fail("Quaternion must be normalized");
}
/** Room ids start at 1, so roomId 0n means the player left and is in no room. */
export const NO_ROOM = 0n;
export function authenticate(ctx: Ctx) {
  const jwt = ctx.senderAuth.jwt;
  if (jwt?.issuer === "https://accounts.google.com" || jwt?.issuer === "accounts.google.com")
    fail("Google sign-in has been replaced. Sign in with a name and password.");
}
export function updateProfile(ctx: Ctx) {
  authenticate(ctx);
  // Reconnects must preserve a registered name. Keys stay with the client; the
  // host verifies their signed identity before any reducer can run.
  if (!ctx.db.profile.identity.find(ctx.sender))
    ctx.db.profile.insert({
      identity: ctx.sender,
      provider: "guest",
      displayName: "",
    });
}
export function player(ctx: Ctx) {
  authenticate(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p?.online || p.roomId === NO_ROOM) return fail("Join a room first");
  return p;
}
export function timeline(ctx: Ctx) {
  const p = player(ctx);
  return ctx.db.timeline.roomId.find(p.roomId) ?? fail("Room has no timeline");
}
export function media(ctx: Ctx, tl: Timeline) {
  const room = ctx.db.room.id.find(tl.roomId)!;
  const m = ctx.db.memory.id.find(room.memoryId)!;
  const delta = tl.paused
    ? 0n
    : BigInt(
        Math.max(
          0,
          Math.round(Number(ctx.timestamp.microsSinceUnixEpoch - tl.anchorServerTs.microsSinceUnixEpoch) * tl.speed),
        ),
      );
  return tl.anchorMediaUs + delta > m.durationUs ? m.durationUs : tl.anchorMediaUs + delta;
}
/** Puts an object to rest at its last reported pose, with no holder or simulation owner. */
export function settle(ctx: Ctx, o: ObjectRow) {
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
export function abandoned(ctx: Ctx, o: ObjectRow) {
  return (
    !!o.simOwner &&
    o.mode === "physics" &&
    ctx.timestamp.microsSinceUnixEpoch - o.updatedAt.microsSinceUnixEpoch > ABANDONED_AFTER_US
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
export function clearOwnership(ctx: Ctx) {
  const cleared: ObjectRow[] = [];
  for (const o of [...ctx.db.objectState.iter()]) if (o.simOwner?.isEqual(ctx.sender)) cleared.push(settle(ctx, o));
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
  if (some(ctx.db.objectState.branchId.filter(b.id), (row) => !!row.simOwner)) return;
  ctx.db.timeline.roomId.update({
    ...tl,
    branchId: b.parentId,
    paused: true,
    anchorMediaUs: b.forkMediaUs,
    anchorServerTs: ctx.timestamp,
  });
}
export function enter(ctx: Ctx, roomId: bigint, name: string, device: string) {
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
export function ownsBranch(ctx: Ctx, branchId: bigint) {
  const p = player(ctx);
  const b = ctx.db.branch.id.find(branchId);
  if (!b || b.roomId !== p.roomId || b.memoryId !== ctx.db.room.id.find(p.roomId)?.memoryId)
    return fail("Branch is outside your room");
  return b;
}
export function noActiveSimulation(ctx: Ctx, branchId: bigint) {
  for (const o of [...ctx.db.objectState.branchId.filter(branchId)])
    if (abandoned(ctx, o)) settle(ctx, o);
    else if (o.simOwner) fail("Wait for objects to settle or release them first");
}
export function fork(ctx: Ctx, tl: Timeline, name: string) {
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
/** Only parties use leader-controlled time. Legacy collaborative rooms remain compatible. */
export function requireLeader(ctx: Ctx, roomId: bigint) {
  if (ctx.db.party.roomId.find(roomId) && !ctx.db.room.id.find(roomId)?.host.isEqual(ctx.sender))
    fail("Only the party leader can control time or change the scene");
}
export function electLeader(ctx: Ctx, roomId: bigint) {
  if (!ctx.db.party.roomId.find(roomId)) return;
  const room = ctx.db.room.id.find(roomId)!;
  const members = [...ctx.db.player.roomId.filter(roomId)]
    .filter((p) => p.online)
    .sort((a, b) => (a.identity.__identity__ < b.identity.__identity__ ? -1 : 1));
  if (members.some((p) => p.identity.isEqual(room.host))) return;
  if (members.length) ctx.db.room.id.update({ ...room, host: members[0].identity });
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
export function activateMemory(ctx: Ctx, roomId: bigint, memoryId: bigint) {
  const room = ctx.db.room.id.find(roomId)!;
  const party = ctx.db.party.roomId.find(roomId)!;
  for (const b of ctx.db.branch.roomId.filter(roomId))
    for (const o of [...ctx.db.objectState.branchId.filter(b.id)]) if (o.simOwner) settle(ctx, o);
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
