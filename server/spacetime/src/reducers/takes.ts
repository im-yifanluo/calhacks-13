import { t } from "spacetimedb/server";
import db from "../schema";
import { fail, fork, noActiveSimulation, ownsBranch, requireLeader, timeline } from "../helpers";

export const forkBranch = db.reducer({ name: t.string() }, (ctx, { name }) => {
  const tl = timeline(ctx);
  requireLeader(ctx, tl.roomId);
  if (!tl.paused) fail("Pause before forking");
  fork(ctx, tl, name);
});
export const setBranch = db.reducer({ branchId: t.u64() }, (ctx, { branchId }) => {
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
});
