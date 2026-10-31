import type { Keyframe } from "@memreplay/shared";
import { validateTrack } from "./tracks";

/** Two clock times closer than this (seconds) are the same instant. */
export const SAME_TIME = 0.001;

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

  get active(): Branch {
    return this.branches.find((b) => b.id === this.activeId)!;
  }

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
      id: `local-${this.nextId++}`,
      parentId: this.activeId,
      name: `Take ${this.nextId - 1}`,
      forkTime: this.time,
      tracks: new Map(),
    };
    this.branches.push(branch);
    this.activeId = branch.id;
    this.playing = false;
    return branch;
  }

  select(id: string): void {
    const branch = this.branches.find((b) => b.id === id);
    if (!branch) throw new Error(`Unknown branch: ${id}`);
    this.activeId = id;
    this.seek(branch.forkTime);
    this.playing = false;
  }

  /** Import parent rows before children. IDs can be SpacetimeDB u64 values converted to strings. */
  upsertBranch(row: Omit<Branch, "tracks">): void {
    if (
      row.id === "original" ||
      !row.id ||
      !row.parentId ||
      row.id === row.parentId ||
      !Number.isFinite(row.forkTime) ||
      row.forkTime < 0 ||
      row.forkTime > this.duration ||
      !this.branches.some((b) => b.id === row.parentId)
    )
      throw new Error("Invalid branch or missing parent");
    let parent = this.branches.find((b) => b.id === row.parentId);
    while (parent) {
      if (parent.id === row.id) throw new Error("Branch cycle");
      const parentId: string | null = parent.parentId;
      parent = this.branches.find((b) => b.id === parentId);
    }
    const existing = this.branches.find((b) => b.id === row.id);
    if (existing) Object.assign(existing, row);
    else this.branches.push({ ...row, tracks: new Map() });
  }

  appendRecording(branchId: string, objectId: string, frames: Keyframe[]): void {
    const branch = this.branches.find((b) => b.id === branchId);
    if (!branch || branch.id === "original") throw new Error("Recordings require an existing alternate branch");
    validateTrack(frames, objectId);
    if (frames[0].t < branch.forkTime || frames.at(-1)!.t > this.duration)
      throw new Error("Recording outside branch timeline");
    // Chunk overlap/retransmission is harmless; newest samples at the same timestamp win.
    const merged = new Map((branch.tracks.get(objectId) ?? []).map((f) => [f.t, f]));
    for (const frame of frames) merged.set(frame.t, { ...frame, p: [...frame.p], q: [...frame.q] });
    branch.tracks.set(
      objectId,
      [...merged.values()].sort((a, b) => a.t - b.t),
    );
  }

  /**
   * Replace a branch's whole recording of one object, or clear it with null or []. The network adapter rebuilds
   * tracks with this whenever server chunks are inserted, updated or deleted. Unlike appendRecording, frames may
   * start before the branch's fork time: the server accepts a branch's own edits there (seek back on a take, grab).
   */
  setRecording(branchId: string, objectId: string, frames: Keyframe[] | null): void {
    const branch = this.branches.find((b) => b.id === branchId);
    if (!branch || branch.id === "original") throw new Error("Recordings require an existing alternate branch");
    if (!frames?.length) {
      branch.tracks.delete(objectId);
      return;
    }
    validateTrack(frames, objectId);
    if (frames.at(-1)!.t > this.duration) throw new Error("Recording outside the clip");
    branch.tracks.set(
      objectId,
      frames.map((f) => ({ ...f, p: [...f.p], q: [...f.q], ...(f.v && { v: [...f.v] }) })),
    );
  }

  /**
   * The track that drives objectId at time t on the active take. This is the canonical inheritance rule; every device
   * resolves takes with it, so they all replay the same thing:
   * 1. The active take's own recording of the object applies whenever t ≥ its first frame, even if that frame is
   *    before the take's forkTime (the server edits a take in place when you seek back on it and grab).
   * 2. Otherwise walk up the ancestors with limit = the smallest forkTime of the takes walked so far (starting with the
   *    active take's). An ancestor's recording applies only if its first frame t0 ≤ limit, and then in full when
   *    t ≥ t0: a throw already in flight at the fork, or thrown at the very instant of the fork, keeps flying in the
   *    child past the fork. A recording that starts after the limit is the ancestor's own future, so edits a parent
   *    gains after a child was forked never leak into the child. If t < t0, older ancestors are tried next.
   * 3. Otherwise the original track.
   * Times within SAME_TIME (1 ms) count as the same instant, because server fork times are rounded to microseconds.
   * A parent edit that starts before a child's fork time is shared history, so it does reach the child.
   */
  track(objectId: string, original: Keyframe[], t = this.time): Keyframe[] {
    const active = this.active;
    const own = active.tracks.get(objectId);
    if (own?.length && t >= own[0].t - SAME_TIME) return own;
    let limit = active.forkTime;
    const seen = new Set([active.id]);
    for (let branch = this.parent(active); branch && !seen.has(branch.id); branch = this.parent(branch)) {
      seen.add(branch.id);
      const recording = branch.tracks.get(objectId);
      if (recording?.length && recording[0].t <= limit + SAME_TIME && t >= recording[0].t - SAME_TIME) return recording;
      limit = Math.min(limit, branch.forkTime);
    }
    return original;
  }

  private parent(branch: Branch): Branch | undefined {
    return branch.parentId === null ? undefined : this.branches.find((b) => b.id === branch.parentId);
  }

  export(memoryId: string): unknown {
    return {
      version: 1,
      memoryId,
      branches: this.branches.map((b) => ({ ...b, tracks: Object.fromEntries(b.tracks) })),
    };
  }
}
