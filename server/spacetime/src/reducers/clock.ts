import { t } from "spacetimedb/server";
import db from "../schema";
import { authenticate, fail, media, noActiveSimulation, requireLeader, timeline } from "../helpers";

export const setPlaybackSpeed = db.reducer({ speed: t.f32() }, (ctx, { speed }) => {
  const tl = timeline(ctx);
  requireLeader(ctx, tl.roomId);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 2) fail("Speed must be between 0.25 and 2");
  ctx.db.timeline.roomId.update({
    ...tl,
    speed,
    anchorMediaUs: media(ctx, tl),
    anchorServerTs: ctx.timestamp,
  });
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
export const sampleClock = db.reducer({ clientSentUs: t.u64() }, (ctx, { clientSentUs }) => {
  authenticate(ctx);
  const row = { identity: ctx.sender, clientSentUs, serverTs: ctx.timestamp };
  if (ctx.db.clockSample.identity.find(ctx.sender)) ctx.db.clockSample.identity.update(row);
  else ctx.db.clockSample.insert(row);
});
