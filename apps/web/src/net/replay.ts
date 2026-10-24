import type { Keyframe } from "@memreplay/shared";
import type { Branch, BranchKeyframes } from "./index";
/** A child sees parent edits only up to its fork; parent future edits never leak backwards. */
export function branchFrames(
  branchId: bigint,
  objectId: string,
  t: number,
  branches: Branch[],
  chunks: BranchKeyframes[],
): { frames: Keyframe[]; time: number } | undefined {
  const seen = new Set<bigint>();
  let limit = t;
  while (branchId !== 0n && !seen.has(branchId)) {
    seen.add(branchId);
    const branch = branches.find((b) => b.id === branchId);
    if (!branch) return;
    const fork = Number(branch.forkMediaUs) / 1e6;
    if (t >= fork) {
      const frames = chunks
        .filter((c) => c.branchId === branchId && c.objectId === objectId)
        .flatMap((c) => JSON.parse(c.keyframesJson) as Keyframe[])
        .filter((f) => f.t <= limit)
        .sort((a, b) => a.t - b.t);
      // Use the bracketing endpoint for interpolation, but freeze ancestors at the fork.
      const all = chunks
        .filter((c) => c.branchId === branchId && c.objectId === objectId)
        .flatMap((c) => JSON.parse(c.keyframesJson) as Keyframe[])
        .sort((a, b) => a.t - b.t);
      if (frames.length) return { frames: all, time: limit };
    }
    limit = Math.min(limit, fork);
    branchId = branch.parentId;
  }
}
