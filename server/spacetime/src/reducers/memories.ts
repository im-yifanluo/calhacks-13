import { t } from "spacetimedb/server";
import db from "../schema";
import { activateMemory, authenticate, fail, text, url } from "../helpers";

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
    if (!args.sourceUrl && !args.manifestUrl) fail("Source or manifest required");
    if (args.durationUs === 0n || args.durationUs > 3_600_000_000n) fail("Duration must be 0–3600 seconds");
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
    if (!m.pipelineIdentity.isEqual(ctx.sender)) fail("Only the assigned pipeline identity may update status");
    const allowed: Record<string, string[]> = {
      uploaded: ["processing", "failed"],
      processing: ["processing", "ready", "failed"],
      failed: ["processing"],
      ready: ["ready"],
    };
    if (!allowed[m.status]?.includes(args.status)) fail("Invalid status transition");
    if (!Number.isFinite(args.progress) || args.progress < 0 || args.progress > 1 || args.error.length > 2000)
      fail("Invalid progress/error");
    if (m.status === "processing" && args.status === "processing" && args.progress < m.progress)
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
      for (const p of [...ctx.db.party.iter()]) if (p.pendingMemoryId === m.id) activateMemory(ctx, p.roomId, m.id);
    }
  },
);
