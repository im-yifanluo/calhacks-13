import type { Keyframe } from "@memreplay/shared";
import { validateTrack } from "./tracks.js";

export interface Branch {
  id: string;
  parentId: string | null;
  name: string;
  forkTime: number;
  tracks: Map<string, Keyframe[]>;
}

/** Local timeline model. P4 can feed authoritative clock/branch updates through the viewer API. */
export class Timeline {
  time = 0;
  playing = true;
  speed = 1;
  activeId = "original";
  readonly branches: Branch[] = [{ id: "original", parentId: null, name: "Original", forkTime: 0, tracks: new Map() }];
  private nextId = 1;

  constructor(readonly duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid timeline duration");
  }

  get active(): Branch { return this.branches.find(b => b.id === this.activeId)!; }

  tick(dt: number): void {
    if (this.playing) {
      this.time = Math.min(this.duration, this.time + Math.max(0, dt) * this.speed);
      if (this.time >= this.duration) this.playing = false;
    }
  }

  seek(time: number): void {
    if (!Number.isFinite(time)) return;
    this.time = Math.max(0, Math.min(this.duration, time));
  }

  fork(): Branch {
    const branch: Branch = {
      id: `local-${this.nextId++}`, parentId: this.activeId,
      name: `Take ${this.nextId - 1}`, forkTime: this.time, tracks: new Map(),
    };
    this.branches.push(branch);
    this.activeId = branch.id;
    this.playing = false;
    return branch;
  }

  select(id: string): void {
    const branch = this.branches.find(b => b.id === id);
    if (!branch) throw new Error(`Unknown branch: ${id}`);
    this.activeId = id;
    this.seek(branch.forkTime);
    this.playing = false;
  }

  /** Import parent rows before children. IDs can be SpacetimeDB u64 values converted to strings. */
  upsertBranch(row: Omit<Branch, "tracks">): void {
    if (row.id === "original" || !row.id || !row.parentId || row.id === row.parentId ||
      !Number.isFinite(row.forkTime) || row.forkTime < 0 || row.forkTime > this.duration ||
      !this.branches.some(b => b.id === row.parentId)) throw new Error("Invalid branch or missing parent");
    let parent = this.branches.find(b => b.id === row.parentId);
    while (parent) {
      if (parent.id === row.id) throw new Error("Branch cycle");
      const parentId: string | null = parent.parentId;
      parent = this.branches.find(b => b.id === parentId);
    }
    const existing = this.branches.find(b => b.id === row.id);
    if (existing) Object.assign(existing, row);
    else this.branches.push({ ...row, tracks: new Map() });
  }

  appendRecording(branchId: string, objectId: string, frames: Keyframe[]): void {
    const branch = this.branches.find(b => b.id === branchId);
    if (!branch || branch.id === "original") throw new Error("Recordings require an existing alternate branch");
    validateTrack(frames, objectId);
    if (frames[0].t < branch.forkTime || frames.at(-1)!.t > this.duration) throw new Error("Recording outside branch timeline");
    // Chunk overlap/retransmission is harmless; newest samples at the same timestamp win.
    const merged = new Map((branch.tracks.get(objectId) ?? []).map(f => [f.t, f]));
    for (const frame of frames) merged.set(frame.t, { ...frame, p: [...frame.p], q: [...frame.q] });
    branch.tracks.set(objectId, [...merged.values()].sort((a, b) => a.t - b.t));
  }

  /**
   * Replace a branch's whole recording of one object, or clear it with null or []. The network adapter rebuilds
   * tracks with this whenever server chunks are inserted, updated or deleted. Unlike appendRecording, frames may
   * start before the branch's fork time: the server accepts a branch's own edits there (seek back on a take, grab).
   */
  setRecording(branchId: string, objectId: string, frames: Keyframe[] | null): void {
    const branch = this.branches.find(b => b.id === branchId);
    if (!branch || branch.id === "original") throw new Error("Recordings require an existing alternate branch");
    if (!frames?.length) { branch.tracks.delete(objectId); return; }
    validateTrack(frames, objectId);
    if (frames.at(-1)!.t > this.duration) throw new Error("Recording outside the clip");
    branch.tracks.set(objectId, frames.map(f => ({ ...f, p: [...f.p], q: [...f.q], ...(f.v && { v: [...f.v] }) })));
  }

  /** Child edits apply only after their first frame. Earlier history resolves through ancestors. */
  track(objectId: string, original: Keyframe[], t = this.time): Keyframe[] {
    let branch: Branch | undefined = this.active;
    while (branch) {
      const override = branch.tracks.get(objectId);
      if (override?.length && t >= override[0].t) return override;
      branch = this.branches.find(b => b.id === branch!.parentId);
    }
    return original;
  }

  export(memoryId: string): unknown {
    return { version: 1, memoryId, branches: this.branches.map(b => ({ ...b, tracks: Object.fromEntries(b.tracks) })) };
  }
}
