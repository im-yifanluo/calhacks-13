import { t } from "spacetimedb/server";
import db, { head } from "../schema";
import type { Ctx } from "../schema";
import {
  activateMemory,
  authenticate,
  clearOwnership,
  electLeader,
  enter,
  fail,
  finite,
  NO_ROOM,
  player,
  requireLeader,
} from "../helpers";

const roomArgs = { memoryId: t.u64(), name: t.string(), device: t.string() };
function makeRoom(ctx: Ctx, args: { memoryId: bigint; name: string; device: string }, party: boolean) {
  authenticate(ctx);
  const m = ctx.db.memory.id.find(args.memoryId) ?? fail("No such memory");
  if (m.status !== "ready") fail("Memory is not ready");
  // ctx.random is seeded from the reducer timestamp and its first draw is badly biased
  // (about 11% of first draws make a 000000x code), so discard it.
  ctx.random.uint32();
  let code = "";
  for (let tries = 0; tries < 20; tries++) {
    code = (ctx.random.uint32() >>> 0).toString(36).toUpperCase().padStart(7, "0");
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
export const createRoom = db.reducer(roomArgs, (ctx, args) => makeRoom(ctx, args, false));
export const createParty = db.reducer(roomArgs, (ctx, args) => makeRoom(ctx, args, true));
export const transferLeadership = db.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  const p = player(ctx);
  if (!ctx.db.party.roomId.find(p.roomId)) fail("Join a party first");
  requireLeader(ctx, p.roomId);
  const next = ctx.db.player.identity.find(identity);
  if (!next?.online || next.roomId !== p.roomId) fail("Choose a connected party member");
  const room = ctx.db.room.id.find(p.roomId)!;
  ctx.db.room.id.update({ ...room, host: identity });
});
export const attachPartyMemory = db.reducer({ memoryId: t.u64() }, (ctx, { memoryId }) => {
  const p = player(ctx);
  const party = ctx.db.party.roomId.find(p.roomId) ?? fail("Join a party first");
  requireLeader(ctx, p.roomId);
  if (memoryId === 0n) {
    ctx.db.party.roomId.update({ ...party, pendingMemoryId: 0n });
    return;
  }
  const memory = ctx.db.memory.id.find(memoryId) ?? fail("No such memory");
  if (memory.status === "ready") activateMemory(ctx, p.roomId, memoryId);
  else ctx.db.party.roomId.update({ ...party, pendingMemoryId: memoryId });
});
export const joinRoom = db.reducer({ joinCode: t.string(), name: t.string(), device: t.string() }, (ctx, args) => {
  const room = ctx.db.room.joinCode.find(args.joinCode.trim().toUpperCase()) ?? fail("Room not found");
  enter(ctx, room.id, args.name, args.device);
});
export const leaveRoom = db.reducer((ctx) => {
  authenticate(ctx);
  clearOwnership(ctx);
  const p = ctx.db.player.identity.find(ctx.sender);
  // NO_ROOM, not just offline: a later reconnect must not put the player back in this room.
  if (p) ctx.db.player.identity.update({ ...p, roomId: NO_ROOM, online: false });
  if (p) electLeader(ctx, p.roomId);
});
export const setPose = db.reducer(head, (ctx, pose) => {
  finite(pose);
  const p = player(ctx);
  ctx.db.player.identity.update({ ...p, ...pose });
});
