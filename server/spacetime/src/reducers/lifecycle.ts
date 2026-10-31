import db from "../schema";
import { clearOwnership, electLeader, NO_ROOM, updateProfile } from "../helpers";

export const onConnect = db.clientConnected((ctx) => {
  updateProfile(ctx);
  if (ctx.connectionId) ctx.db.connection.insert({ id: ctx.connectionId, identity: ctx.sender });
  const p = ctx.db.player.identity.find(ctx.sender);
  // Resume the room after a dropped connection, but never after an explicit leaveRoom.
  if (p && p.roomId !== NO_ROOM) ctx.db.player.identity.update({ ...p, online: true });
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
