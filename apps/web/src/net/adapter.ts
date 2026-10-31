// Glue between nikko's Viewer (one device: pause, grab, throw, record, replay) and jerry's SpacetimeDB room.
// The server is the authority: the viewer asks before every grab (InteractionAuthority), shows the room's shared clock,
// and replays takes rebuilt from the server's keyframe chunks, so every device resolves the same tracks.
import { type Keyframe, validateTrack } from "@memreplay/shared";
import type { Identity } from "spacetimedb";
import type { DbConnection } from "../module_bindings";
import type { Branch as ViewerBranch } from "../engine/timeline";
import type { GrabRequest, InteractionAuthority, Viewer, ViewerEvent } from "../engine/viewer";
import type {
  Branch as BranchRow,
  BranchKeyframes,
  Multiplayer,
  ObjectState,
  Pose,
  Timeline as TimelineRow,
} from "./index";

/** The viewer's name for server branch 0. */
const ORIGINAL = "original";
/** Two media times less than this apart (µs) are the same instant, as in Viewer.applyClock. */
const SAME_US = 1000n;
/** A playing clock is resynchronised once it drifts this far (seconds). */
const MAX_DRIFT = 0.1;
/** At most one moveObject per object per this many ms (15 Hz). */
const MOVE_INTERVAL_MS = 1000 / 15;
/** Throws are saved at about this rate; the viewer simulates at 60 Hz. */
const SAVE_HZ = 30;
/** The server takes at most this many keyframes per chunk. */
const CHUNK_FRAMES = 120;
const CALL_TIMEOUT_MS = 5000;
const ACQUIRE_TIMEOUT_MS = 8000;
const ROWS_TIMEOUT_MS = 2000;
/** How long the queue waits for the viewer to take a grant or give it back before moving on regardless. */
const DECISION_TIMEOUT_MS = 2000;
const TICK_MS = 1000;

type Reducers = DbConnection["reducers"];
type BranchInfo = Omit<ViewerBranch, "tracks">;
/**
 * What a status message is about: changing the shared clock, a grab, a throw (its release, saves and final release),
 * giving an object back, losing a hold, a take kept on this device, unreadable room data, or the adapter itself.
 */
export type ReportKind = "clock" | "grab" | "throw" | "release" | "hold" | "take" | "data" | "internal";
/** An error stays until a later action of its kind succeeds (the adapter's `resolved` callback) or a newer message. */
export interface ReportOptions {
  kind: ReportKind;
  error: boolean;
}
type Grant = { branch: BranchInfo };
type ClockEvent = Extract<ViewerEvent, { type: "clock" }>;
type ObjectEvent = { objectId: string; branchId: string; pose: Keyframe; velocity: [number, number, number] };

/** An object the server says we hold or simulate, from the grant until our release(rest: true) is sent. */
interface Owned {
  objectId: string;
  branchId: bigint;
  /** The server rejects keyframes before this (the grab's media time). */
  fromMediaUs: bigint;
  thrown: boolean;
  /** The viewer is done with it; release(rest: true) is queued. */
  releasing: boolean;
  /** A call for this hold failed, so finishing it does not clear earlier errors. */
  failed?: boolean;
  finalPose?: Pose;
}
interface Track {
  key: string;
  branchId: bigint;
  objectId: string;
  chunks: Map<string, { startUs: bigint; frames: Keyframe[] }>;
}
interface Attempt {
  abandoned: boolean;
  reason?: string;
}

/** Server branch id (u64, 0 = Original) → viewer branch id. */
export function viewerBranchId(id: bigint): string {
  return id === 0n ? ORIGINAL : String(id);
}
/** Viewer branch id → server branch id. Takes made only on this device ("local-N") have none. */
export function serverBranchId(id: string): bigint | undefined {
  return id === ORIGINAL ? 0n : /^[1-9][0-9]*$/.test(id) ? BigInt(id) : undefined;
}
export function microseconds(seconds: number): bigint {
  return BigInt(Math.round(seconds * 1e6));
}

/** A room's branch rows as viewer branches, parents first (a child's id is always larger than its parent's). */
export function importBranches(rows: readonly BranchRow[], duration: number): BranchInfo[] {
  return [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => ({
      id: viewerBranchId(row.id),
      parentId: viewerBranchId(row.parentId),
      name: row.name,
      forkTime: Math.min(duration, Number(row.forkMediaUs) / 1e6),
    }));
}

/** A viewer pose (and velocity) as reducer arguments, with the quaternion normalised. */
export function serverPose(frame: Keyframe, velocity: readonly number[] = [0, 0, 0]): Pose {
  const [x, y, z, w] = frame.q,
    n = Math.hypot(x, y, z, w) || 1;
  return {
    px: frame.p[0],
    py: frame.p[1],
    pz: frame.p[2],
    qx: x / n,
    qy: y / n,
    qz: z / n,
    qw: w / n,
    vx: velocity[0] ?? 0,
    vy: velocity[1] ?? 0,
    vz: velocity[2] ?? 0,
  };
}
function rowPose(row: ObjectState): Pose {
  return { px: row.px, py: row.py, pz: row.pz, qx: row.qx, qy: row.qy, qz: row.qz, qw: row.qw, vx: 0, vy: 0, vz: 0 };
}

/**
 * The chunks the server stores for one throw. The viewer's recording also holds the branch's earlier frames, so only
 * frames at or after the grab (fromMediaUs) and inside the memory are kept. They are downsampled from 60 Hz to about
 * 30 Hz, always keeping the first and last frame, and split into disjoint chunks of at most 120 frames. Each chunk's
 * startMediaUs is round(chunk[0].t × 1e6).
 */
export function recordingChunks(
  frames: readonly Keyframe[],
  fromMediaUs: bigint,
  durationUs: bigint,
  hz = SAVE_HZ,
  size = CHUNK_FRAMES,
): Keyframe[][] {
  const kept = frames.filter((f) => {
    const us = microseconds(f.t);
    return us >= fromMediaUs && us <= durationUs;
  });
  const sampled: Keyframe[] = [];
  for (const frame of kept) if (!sampled.length || frame.t - sampled.at(-1)!.t >= 1 / hz - 1e-6) sampled.push(frame);
  const last = kept.at(-1);
  if (last && sampled.at(-1) !== last) sampled.push(last);
  const chunks: Keyframe[][] = [];
  for (let i = 0; i < sampled.length; i += size) {
    chunks.push(
      sampled
        .slice(i, i + size)
        .map((f) => ({ t: f.t, p: [...f.p], q: [...f.q], ...(f.s !== undefined ? { s: f.s } : {}) })),
    );
  }
  return chunks;
}

/** One server chunk as viewer keyframes (known fields only), or undefined when it is not a valid track. */
export function parseChunk(json: string): Keyframe[] | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return undefined;
    const frames: Keyframe[] = value.map((f) => ({
      t: f?.t,
      p: f?.p,
      q: f?.q,
      ...(f?.s !== undefined ? { s: f.s } : {}),
    }));
    validateTrack(frames);
    return frames;
  } catch {
    return undefined;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const distance = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

/**
 * Implements the viewer's InteractionAuthority on top of Multiplayer, and keeps the viewer in step with the room:
 * - rows → viewer: branches (parents first), keyframe chunks rebuilt into Timeline recordings, the shared clock, other
 *   players' held or thrown objects, and revocation when the server takes our hold away;
 * - viewer → server: play, pause, seek and take selection; grab (acquire), moves at 15 Hz, throw, the recorded
 *   throw in ≤120-frame chunks, then release(rest: true).
 * Every server call goes through one queue, so a throw's chunks and its release finish before the next seek or grab.
 */
export class NetAdapter implements InteractionAuthority {
  private started = false;
  private disposed = false;
  private roomId?: bigint;
  /** While above 0 (a grab or our own clock change is in flight), timeline rows wait; reconcile() runs after. */
  private clockHold = 0;
  private lastRow?: string;
  private wantedClock?: { time: number; playing: boolean; branchId: bigint };
  private clockQueued = false;
  private readonly queue: Array<() => Promise<void>> = [];
  private pumping = false;
  private readonly owned = new Map<string, Owned>();
  private readonly moves = new Map<string, { pose?: Pose; sentAt: number; timer?: ReturnType<typeof setTimeout> }>();
  private readonly tracks = new Map<string, Track>();
  /** Tracks whose chunks we are saving: rebuilt once, after the last save. */
  private readonly saving = new Set<string>();
  private readonly dirty = new Set<string>();
  private flushQueued = false;
  private readonly warned = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly cancelers = new Set<() => void>();
  /** Other players' objects we are showing live (row keys), so a rest we watched holds its landing pose. */
  private readonly live = new Set<string>();
  /** Grants handed to the viewer that it has not yet taken ("grab" event) or given back (release). */
  private readonly decisions = new Map<string, () => void>();
  private readonly unhooks: Array<() => void> = [];
  private interval?: ReturnType<typeof setInterval>;

  /**
   * `report` shows a message to the player; `resolved` says an action of that kind just succeeded, so an error of the
   * same kind still on screen is stale. Every message replaces the previous one.
   */
  constructor(
    private readonly net: Multiplayer,
    private readonly viewer: Viewer,
    private readonly report: (message: string, options?: ReportOptions) => void,
    private readonly resolved: (kind: ReportKind) => void = () => {},
  ) {}

  /** Call once, after the player is in a room and net.ready: syncs from the client cache, then follows rows and viewer events. */
  start(): void {
    if (this.started || this.disposed) return;
    const conn = this.net.connection,
      room = this.net.room;
    if (!conn || !room || !this.net.ready || !this.net.identity) {
      this.say("Multiplayer is not ready yet: join a room first.", "internal");
      return;
    }
    this.started = true;
    this.roomId = room.id;
    this.syncBranches();
    for (const chunk of conn.db.branchKeyframes.iter()) this.onChunk(chunk, false);
    this.flush();
    const row = this.row;
    if (row) this.applyServerClock(row);
    this.releaseOrphans();

    const db = conn.db;
    // Row callbacks run inside the SDK's message handling, so they must never throw.
    const safe =
      <A extends unknown[]>(handle: (...args: A) => void) =>
      (...args: A) => {
        try {
          if (!this.disposed) handle(...args);
        } catch (error) {
          console.error("NetAdapter", error);
          this.say(`Multiplayer error: ${message(error)}`, "internal");
        }
      };
    const timeline = safe((_ctx: unknown, row: TimelineRow) => this.onTimeline(row));
    const timelineUpdate = safe((_ctx: unknown, _old: TimelineRow, row: TimelineRow) => this.onTimeline(row));
    const branch = safe((_ctx: unknown, row: BranchRow) => this.onBranch(row));
    const branchUpdate = safe((_ctx: unknown, _old: BranchRow, row: BranchRow) => this.onBranch(row));
    const object = safe((_ctx: unknown, row: ObjectState) => this.onObject(row, false));
    const objectUpdate = safe((_ctx: unknown, _old: ObjectState, row: ObjectState) => this.onObject(row, false));
    const objectDelete = safe((_ctx: unknown, row: ObjectState) => this.onObject(row, true));
    const chunk = safe((_ctx: unknown, row: BranchKeyframes) => this.onChunk(row, false));
    const chunkUpdate = safe((_ctx: unknown, _old: BranchKeyframes, row: BranchKeyframes) => this.onChunk(row, false));
    const chunkDelete = safe((_ctx: unknown, row: BranchKeyframes) => this.onChunk(row, true));
    // Timeline and branch rows are never deleted by the module; a missing timeline row simply stops the clock sync.
    db.timeline.onInsert(timeline);
    db.timeline.onUpdate(timelineUpdate);
    db.branch.onInsert(branch);
    db.branch.onUpdate(branchUpdate);
    db.objectState.onInsert(object);
    db.objectState.onUpdate(objectUpdate);
    db.objectState.onDelete(objectDelete);
    db.branchKeyframes.onInsert(chunk);
    db.branchKeyframes.onUpdate(chunkUpdate);
    db.branchKeyframes.onDelete(chunkDelete);
    this.unhooks.push(
      () => {
        db.timeline.removeOnInsert(timeline);
        db.timeline.removeOnUpdate(timelineUpdate);
      },
      () => {
        db.branch.removeOnInsert(branch);
        db.branch.removeOnUpdate(branchUpdate);
      },
      () => {
        db.objectState.removeOnInsert(object);
        db.objectState.removeOnUpdate(objectUpdate);
        db.objectState.removeOnDelete(objectDelete);
      },
      () => {
        db.branchKeyframes.removeOnInsert(chunk);
        db.branchKeyframes.removeOnUpdate(chunkUpdate);
        db.branchKeyframes.removeOnDelete(chunkDelete);
      },
      this.viewer.subscribe(this.onViewerEvent),
    );
    this.interval = setInterval(safe(this.tick), TICK_MS);
  }

  /**
   * Removes every hook, listener and timer. Queued calls are dropped, and nothing more is sent: anything still held
   * stays held until the connection closes. party/session.ts disposes the adapter on pagehide and disconnects right after;
   * the server then clears the hold and, when the grab's take has nothing recorded yet, puts the room back on the
   * parent take. Releasing here would look like an ordinary give-back and leave everyone on an empty take.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unhook of this.unhooks.splice(0)) unhook();
    if (this.interval) clearInterval(this.interval);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const cancel of [...this.cancelers]) cancel();
    for (const entry of this.queue.splice(0)) void entry(); // resolves its caller without calling the server
    this.owned.clear();
    this.moves.clear();
  }

  /** Ask the room for an object: pause and seek it to the request, grab, and hand the viewer the branch the server chose. */
  async acquire(request: GrabRequest): Promise<boolean | Grant> {
    if (!this.started || this.disposed) return false;
    this.clockHold++;
    const attempt: Attempt = { abandoned: false };
    let settled = false;
    let answer!: (result: Grant | false | undefined) => void;
    const answered = new Promise<Grant | false | undefined>((resolve) => {
      answer = resolve;
    });
    void this.enqueue(async () => {
      const grant = await this.grab(request, attempt);
      answer(grant);
      // Keep the queue until the viewer takes the grant or gives it back. A play, seek or take change the user made
      // while the grab was in flight is queued behind us; it must run after that release, because the server refuses
      // it while we still hold the object.
      if (grant && !attempt.abandoned) await this.decision(request.objectId);
    }).then(() => answer(undefined)); // dropped by dispose
    const work = answered.then((result) => {
      settled = true;
      return result;
    });
    const result = await this.within(work, ACQUIRE_TIMEOUT_MS);
    if (!settled) {
      attempt.abandoned = true;
      attempt.reason ??= "the server did not answer in time";
      void work.then((late) => {
        if (late) this.giveBack(request.objectId);
      });
    }
    // After the viewer has handled the answer: show any clock change we held back, then say why a grab failed (the
    // viewer's own message only guesses "Another player owns that object").
    this.later(() => {
      this.clockHold--;
      this.reconcile();
      if (attempt.reason) this.say(`Could not grab the ${this.label(request.objectId)}: ${attempt.reason}`, "grab");
      else if (result) this.succeeded("grab");
    }, 0);
    return result || false;
  }

  /** The viewer is done with an object: its throw came to rest, or it could not use a grant. */
  release(objectId: string): void {
    try {
      const owned = this.owned.get(objectId);
      if (!owned || owned.releasing || this.disposed) return;
      owned.releasing = true;
      this.dropMove(objectId);
      // A finished throw keeps its place after its keyframe saves. A grant the viewer could not use (a seek or play
      // cancelled it meanwhile) goes back first, ahead of the clock change that cancelled it: the server refuses a seek
      // or take change while we still hold the object. The grab's queue entry waits for this (see decision()).
      void this.enqueue(() => this.sendRelease(owned), !owned.thrown);
    } finally {
      this.decided(objectId);
    }
  }

  // ---- viewer → server -------------------------------------------------------------------------------------------

  private onViewerEvent = (event: ViewerEvent): void => {
    if (this.disposed) return;
    switch (event.type) {
      case "clock":
        this.onClock(event);
        break;
      case "pose":
        this.onPose(event);
        break;
      case "throw":
        this.onThrow(event);
        break;
      case "recording":
        this.onRecording(event.objectId, event.frames);
        break;
      case "rest": {
        const owned = this.owned.get(event.objectId);
        if (owned) owned.finalPose = serverPose(event.pose);
        break;
      }
      case "grab":
        this.decided(event.objectId);
        break; // the viewer took the grant; acquire already holds the object
      // "fork" is a take made only on this device; a networked grant never makes one, and its "local-N" id is never sent.
    }
  };

  private async grab(request: GrabRequest, attempt: Attempt): Promise<Grant | false> {
    const fail = (reason: string) => {
      attempt.reason = reason;
      return false as const;
    };
    const { objectId } = request;
    const row = this.row;
    if (!this.net.ready || !row) return fail("not connected to the room");
    if (serverBranchId(request.branchId) !== row.branchId) return fail("the room switched takes, try again");
    if (!this.net.canControlTime && !row.paused) return fail("Ask the party leader to pause before grabbing");
    if (!row.paused) {
      const error = await this.call((r) => r.setPaused({ paused: true }));
      if (error) return fail(error);
    }
    const target = this.clampUs(request.time),
      at = this.mediaUs();
    if (at !== target && this.net.canControlTime) {
      // The catch case: a throw preview caught mid-flight is edited at the preview's time, not where the room paused.
      // Under 1 ms this only aligns the recording's start with the grab, so a refusal there does not matter.
      const error = await this.call((r) => r.seek({ mediaUs: target }));
      if (error && distance(at, target) >= SAME_US) return fail(error);
    }
    if (attempt.abandoned || this.disposed) return false;
    // A grab that answers after its timeout still holds the object on the server: give it straight back then.
    const error = await this.call(
      (r) => r.grab({ objectId, ...serverPose(request.pose) }),
      () => this.giveBack(objectId),
    );
    if (error) return fail(error);
    // The reducer forks and moves the room in the same transaction, and the SDK caches it before the call resolves.
    const granted = await this.until(() => this.grantedRow(objectId), ROWS_TIMEOUT_MS);
    if (!granted) {
      this.giveBack(objectId);
      return fail("the server's confirmation did not arrive");
    }
    this.syncBranches();
    this.owned.set(objectId, {
      objectId,
      branchId: granted.row.branchId,
      fromMediaUs: granted.row.fromMediaUs,
      thrown: false,
      releasing: false,
    });
    if (attempt.abandoned) {
      this.giveBack(objectId);
      return false;
    }
    return { branch: granted.branch };
  }

  /** Our hold on objectId in the room's current branch, once its row and the branch row are cached. */
  private grantedRow(objectId: string): { row: ObjectState; branch: BranchInfo } | undefined {
    const tl = this.row,
      conn = this.net.connection;
    if (!tl || !conn || tl.branchId === 0n) return undefined;
    const row = conn.db.objectState.key.find(`${tl.branchId}:${objectId}`);
    const branch = conn.db.branch.id.find(tl.branchId);
    if (!row || !branch || !this.mine(row.heldBy) || !this.mine(row.simOwner) || branch.roomId !== this.roomId)
      return undefined;
    return { row, branch: importBranches([branch], this.viewer.timeline.duration)[0] };
  }

  /** Release an object the server granted that the viewer will not use (a late or abandoned grant). */
  private giveBack(objectId: string): void {
    if (this.disposed) return; // the connection closes next, which clears the hold (see dispose)
    const owned = this.owned.get(objectId);
    if (owned) {
      owned.releasing = true;
      void this.enqueue(() => this.sendRelease(owned), true);
      this.decided(objectId);
      return;
    }
    void this.enqueue(async () => {
      const row = this.net.connection?.db.objectState.key.find(`${this.row?.branchId}:${objectId}`);
      if (
        row &&
        this.mine(row.simOwner) &&
        (await this.calling(`release the ${this.label(objectId)}`, "release", (r) =>
          r.release({ objectId, rest: true, ...rowPose(row) }),
        ))
      )
        this.succeeded("release");
    }, true);
    this.decided(objectId);
  }

  private async sendRelease(owned: Owned): Promise<void> {
    if (this.owned.get(owned.objectId) !== owned) return; // revoked meanwhile
    const row = this.ownRow(owned);
    if (row) {
      // A throw is done once it rests: if none of its calls failed, an older throw error is stale.
      const kind = owned.thrown ? "throw" : "release";
      if (
        (await this.calling(
          `release the ${this.label(owned.objectId)}`,
          kind,
          (r) => r.release({ objectId: owned.objectId, rest: true, ...(owned.finalPose ?? rowPose(row)) }),
          owned,
        )) &&
        !owned.failed
      )
        this.succeeded(kind);
    }
    if (this.owned.get(owned.objectId) === owned) this.owned.delete(owned.objectId);
  }

  private onClock(event: ClockEvent): void {
    if (!this.net.canControlTime) {
      this.say("The party leader controls time. You can look around and interact while paused.", "clock", false);
      this.later(() => this.reconcile(), 0);
      return;
    }
    const branchId = serverBranchId(event.branchId);
    if (branchId === undefined) {
      this.say("That take exists only on this device. Showing the room's take.", "take", false);
      this.later(() => this.reconcile(), 0);
      return;
    }
    // Coalesced: a scrub sends one seek per queue turn, always the latest.
    this.wantedClock = { time: event.time, playing: event.playing, branchId };
    if (this.clockQueued) return;
    this.clockQueued = true;
    this.clockHold++;
    void this.enqueue(async () => {
      this.clockQueued = false;
      const want = this.wantedClock;
      this.wantedClock = undefined;
      try {
        if (want) await this.changeClock(want);
      } finally {
        this.clockHold--;
        this.reconcile();
      } // a refused change puts the viewer back on the room's clock
    });
  }

  private async changeClock(want: { time: number; playing: boolean; branchId: bigint }): Promise<void> {
    // setBranch leaves the room paused at the take's fork time, as Viewer.selectBranch does locally.
    const steps: Array<() => Promise<string | undefined> | undefined> = [
      () =>
        want.branchId !== this.row?.branchId ? this.call((r) => r.setBranch({ branchId: want.branchId })) : undefined,
      () => (!want.playing && this.row?.paused === false ? this.call((r) => r.setPaused({ paused: true })) : undefined),
      () => {
        const target = this.clampUs(want.time);
        return this.row && distance(this.mediaUs(), target) >= SAME_US
          ? this.call((r) => r.seek({ mediaUs: target }))
          : undefined;
      },
      () => (want.playing && this.row?.paused ? this.call((r) => r.setPaused({ paused: false })) : undefined),
    ];
    for (const step of steps) {
      const error = await step();
      if (error) {
        this.say(`Could not change the shared clock: ${error}`, "clock");
        return;
      }
    }
    this.succeeded("clock");
  }

  private onPose(event: ObjectEvent): void {
    const owned = this.owned.get(event.objectId);
    if (!owned || owned.releasing || event.branchId !== viewerBranchId(owned.branchId)) return;
    const slot = this.moves.get(event.objectId) ?? { sentAt: -Infinity };
    this.moves.set(event.objectId, slot);
    slot.pose = serverPose(event.pose, event.velocity);
    if (slot.timer !== undefined) return;
    const wait = slot.sentAt + MOVE_INTERVAL_MS - performance.now();
    if (wait <= 0) this.sendMove(owned, slot);
    else
      slot.timer = this.later(() => {
        slot.timer = undefined;
        this.sendMove(owned, slot);
      }, wait);
  }

  private sendMove(owned: Owned, slot: { pose?: Pose; sentAt: number }): void {
    const pose = slot.pose;
    slot.pose = undefined;
    if (!pose) return;
    slot.sentAt = performance.now();
    // Not awaited: the server runs one connection's calls in order, so 15 Hz moves never wait for a round trip.
    void this.enqueue(async () => {
      if (this.owned.get(owned.objectId) === owned && !owned.releasing) void this.net.move(owned.objectId, pose);
    });
  }

  private dropMove(objectId: string): void {
    const timer = this.moves.get(objectId)?.timer;
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
    this.moves.delete(objectId);
  }

  private onThrow(event: ObjectEvent): void {
    const owned = this.owned.get(event.objectId);
    if (!owned || owned.releasing) return;
    owned.thrown = true;
    this.dropMove(event.objectId);
    const pose = serverPose(event.pose, event.velocity);
    void this.enqueue(async () => {
      if (this.owned.get(owned.objectId) === owned)
        await this.calling(
          `throw the ${this.label(owned.objectId)}`,
          "throw",
          (r) => r.release({ objectId: owned.objectId, rest: false, ...pose }),
          owned,
        );
    });
  }

  private onRecording(objectId: string, frames: Keyframe[]): void {
    const owned = this.owned.get(objectId);
    if (!owned || owned.releasing) return; // revoked holds emit their prefix too; the server no longer takes it
    const chunks = recordingChunks(
      frames,
      owned.fromMediaUs,
      this.net.memory?.durationUs ?? microseconds(this.viewer.timeline.duration),
    );
    if (frames.length) owned.finalPose = serverPose(frames.at(-1)!);
    const track = this.track(owned.branchId, objectId);
    this.saving.add(track.key);
    void this.enqueue(async () => {
      try {
        for (const [i, chunk] of chunks.entries()) {
          if (this.owned.get(objectId) !== owned) return;
          await this.calling(
            `save part ${i + 1} of ${chunks.length} of the throw`,
            "throw",
            (r) =>
              r.saveBranchKeyframes({
                branchId: owned.branchId,
                objectId,
                startMediaUs: microseconds(chunk[0].t),
                keyframesJson: JSON.stringify(chunk),
              }),
            owned,
          );
        }
      } finally {
        this.saving.delete(track.key);
        this.markDirty(track.key);
      }
    });
  }

  // ---- server → viewer -------------------------------------------------------------------------------------------

  /** This room's timeline row, while we are still in the room the adapter started in. */
  private get row(): TimelineRow | undefined {
    const row = this.net.timeline;
    return row && row.roomId === this.roomId ? row : undefined;
  }

  private onTimeline(row: TimelineRow): void {
    if (row.roomId !== this.roomId || this.clockHold > 0) return; // held rows are reconciled when the hold ends
    const current = this.row;
    if (current && this.fingerprint(current) !== this.lastRow) this.applyServerClock(current);
  }

  private fingerprint(row: TimelineRow): string {
    return `${row.branchId}|${row.paused}|${row.speed}|${row.anchorMediaUs}|${row.anchorServerTs.microsSinceUnixEpoch}`;
  }

  /** Show the room's clock. Branches are imported first; applyClock clears remote poses, so they are re-applied. */
  private applyServerClock(row: TimelineRow): void {
    this.lastRow = this.fingerprint(row);
    this.syncBranches();
    this.viewer.applyClock(this.net.time(), !row.paused, row.speed, viewerBranchId(row.branchId));
    this.applyRemotePoses();
  }

  /** After a grab or our own clock change: apply the room's clock only if the viewer shows something else. */
  private reconcile(): void {
    if (this.clockHold > 0 || this.disposed || !this.started) return;
    const row = this.row;
    if (!row) return;
    if (this.matches(row)) this.lastRow = this.fingerprint(row);
    else this.applyServerClock(row);
  }

  /** The viewer shows this row: same take, speed and play state, and the same time (1 ms paused, 100 ms playing). */
  private matches(row: TimelineRow): boolean {
    const local = this.viewer.timeline,
      memory = this.net.memory;
    const end = Math.min(local.duration, memory ? Number(memory.durationUs) / 1e6 : Infinity);
    const time = Math.min(end, this.net.time());
    if (viewerBranchId(row.branchId) !== local.activeId || row.speed !== local.speed) return false;
    // A room still "playing" at the end of the memory shows its last frame, however the viewer stopped there.
    if (!row.paused && time >= end - 0.001) return local.time >= end - MAX_DRIFT;
    return !row.paused === local.playing && Math.abs(time - local.time) < (row.paused ? 0.001 : MAX_DRIFT);
  }

  private tick = (): void => {
    if (this.disposed) return;
    if (this.net.ready)
      for (const owned of [...this.owned.values()]) if (!owned.releasing && !this.ownRow(owned)) this.revoke(owned);
    const row = this.row;
    if (this.clockHold === 0 && row && !this.matches(row)) this.applyServerClock(row); // drift past 100 ms while playing
  };

  /** Import this room's branches, parents first. Idempotent. */
  private syncBranches(): void {
    const conn = this.net.connection;
    if (!conn) return;
    const rows = [...conn.db.branch.iter()].filter((b) => b.roomId === this.roomId);
    for (const branch of importBranches(rows, this.viewer.timeline.duration)) {
      try {
        this.viewer.timeline.upsertBranch(branch);
      } catch (error) {
        this.warn(`branch:${branch.id}`, `Could not show the take "${branch.name}": ${message(error)}`);
      }
    }
  }

  private onBranch(row: BranchRow): void {
    if (row.roomId !== this.roomId) return;
    this.syncBranches();
    for (const track of this.tracks.values()) if (track.branchId === row.id) this.markDirty(track.key);
  }

  private onObject(row: ObjectState, deleted: boolean): void {
    const owned = this.owned.get(row.objectId);
    // Leaving the room, joining another or dropping the connection clears our hold on the server.
    if (owned && owned.branchId === row.branchId && !owned.releasing && (deleted || !this.mine(row.simOwner)))
      this.revoke(owned);
    if (row.branchId !== this.row?.branchId) return; // other takes and other rooms
    if (deleted) this.viewer.clearRemotePose(row.objectId);
    else this.showRemote(row);
  }

  /** Another player's held or thrown object follows their pose; once it rests it replays its track again. */
  private showRemote(row: ObjectState): void {
    if (this.mine(row.simOwner)) return;
    if (!row.simOwner || (row.mode !== "held" && row.mode !== "physics")) {
      this.viewer.clearRemotePose(row.objectId);
      // A throw we watched just came to rest: hold its landing pose while paused, as the thrower's viewer does, instead
      // of falling back to the take's pose at the paused time (the release pose). Late joiners see the take as is.
      if (row.mode === "rest" && this.live.delete(row.key)) this.holdLanding(row);
      return;
    }
    this.live.add(row.key);
    try {
      this.viewer.applyRemotePose(row.objectId, {
        t: 0,
        p: [row.px, row.py, row.pz],
        q: [row.qx, row.qy, row.qz, row.qw],
      });
    } catch {
      this.warn(`pose:${row.key}`, `Ignored an invalid pose for the ${this.label(row.objectId)}.`);
    }
  }

  private holdLanding(row: ObjectState): void {
    const timeline = this.viewer.timeline;
    if (timeline.playing) return;
    const last = timeline.active.tracks.get(row.objectId)?.at(-1);
    const frame =
      last && last.t >= timeline.time
        ? last
        : {
            t: timeline.time,
            p: [row.px, row.py, row.pz] as [number, number, number],
            q: [row.qx, row.qy, row.qz, row.qw] as [number, number, number, number],
          };
    try {
      this.viewer.holdPose(row.objectId, frame);
    } catch {
      this.warn(`pose:${row.key}`, `Ignored an invalid pose for the ${this.label(row.objectId)}.`);
    }
  }

  private applyRemotePoses(): void {
    const tl = this.row,
      conn = this.net.connection;
    if (!tl || !conn) return;
    for (const row of conn.db.objectState.iter()) if (row.branchId === tl.branchId) this.showRemote(row);
  }

  /**
   * The server took our hold away. The viewer stops writing; the prefix it emits is no longer ours to save, so the
   * take goes back to what the server has, like on every other device.
   */
  private revoke(owned: Owned): void {
    this.owned.delete(owned.objectId);
    this.dropMove(owned.objectId);
    this.viewer.revokeOwnership(owned.objectId);
    this.markDirty(this.track(owned.branchId, owned.objectId).key);
    this.say(`You no longer hold the ${this.label(owned.objectId)}: the room released it.`, "hold", false);
  }

  /** Our own rows left over from an earlier viewer or adapter would lock the room: give them back. */
  private releaseOrphans(): void {
    const tl = this.row,
      conn = this.net.connection;
    if (!tl || !conn) return;
    for (const row of conn.db.objectState.iter()) {
      if (row.branchId !== tl.branchId || !this.mine(row.simOwner) || this.owned.has(row.objectId)) continue;
      const pose = rowPose(row);
      void this.enqueue(() =>
        this.calling(`release the ${this.label(row.objectId)}`, "release", (r) =>
          r.release({ objectId: row.objectId, rest: true, ...pose }),
        ),
      );
    }
  }

  private track(branchId: bigint, objectId: string): Track {
    const key = `${branchId}:${objectId}`;
    let track = this.tracks.get(key);
    if (!track) this.tracks.set(key, (track = { key, branchId, objectId, chunks: new Map() }));
    return track;
  }

  private onChunk(row: BranchKeyframes, deleted: boolean): void {
    if (this.net.connection?.db.branch.id.find(row.branchId)?.roomId !== this.roomId) return;
    const track = this.track(row.branchId, row.objectId);
    const frames = deleted ? undefined : parseChunk(row.keyframesJson);
    if (frames)
      track.chunks.set(row.key, { startUs: row.startMediaUs, frames }); // parsed once, cached by key
    else track.chunks.delete(row.key);
    if (!deleted && !frames)
      this.warn(
        `chunk:${row.key}`,
        `Ignored an unreadable part of a recorded throw of the ${this.label(row.objectId)}.`,
      );
    this.markDirty(track.key);
  }

  private markDirty(key: string): void {
    this.dirty.add(key);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.disposed) return;
    for (const key of [...this.dirty]) {
      this.dirty.delete(key);
      const track = this.tracks.get(key);
      if (track && !this.saving.has(key)) this.rebuild(track);
    }
  }

  /** A branch's recording of one object is all of its chunks, in time order. */
  private rebuild(track: Track): void {
    const frames: Keyframe[] = [];
    const chunks = [...track.chunks.values()].sort((a, b) =>
      a.startUs < b.startUs ? -1 : a.startUs > b.startUs ? 1 : 0,
    );
    for (const chunk of chunks)
      for (const frame of chunk.frames) if (!frames.length || frame.t > frames.at(-1)!.t) frames.push(frame);
    const branchId = viewerBranchId(track.branchId);
    if (!this.viewer.timeline.branches.some((b) => b.id === branchId)) this.syncBranches();
    try {
      this.viewer.timeline.setRecording(branchId, track.objectId, frames.length ? frames : null);
    } catch (error) {
      this.warn(
        `track:${track.key}`,
        `Could not show a recorded throw of the ${this.label(track.objectId)}: ${message(error)}`,
      );
    }
  }

  // ---- plumbing --------------------------------------------------------------------------------------------------

  private mine(identity: Identity | undefined): boolean {
    return !!identity && !!this.net.identity && identity.isEqual(this.net.identity);
  }

  /** Our row for a hold, if the server still says we own it. */
  private ownRow(owned: Owned): ObjectState | undefined {
    const row = this.net.connection?.db.objectState.key.find(`${owned.branchId}:${owned.objectId}`);
    return row && this.mine(row.simOwner) ? row : undefined;
  }

  private mediaUs(): bigint {
    return microseconds(this.net.time());
  }

  private clampUs(seconds: number): bigint {
    const us = microseconds(Math.max(0, seconds)),
      duration = this.net.memory?.durationUs;
    return duration !== undefined && us > duration ? duration : us;
  }

  private label(objectId: string): string {
    return this.viewer.memory.objects.find((o) => o.definition.id === objectId)?.definition.label ?? objectId;
  }

  /** A status line for the player, unless the adapter is gone. Errors by default; information expires. */
  private say(text: string, kind: ReportKind, error = true): void {
    if (!this.disposed) this.report(text, { kind, error });
  }

  /** An action of this kind succeeded, so an error of the same kind still on screen is stale. */
  private succeeded(kind: ReportKind): void {
    if (!this.disposed) this.resolved(kind);
  }

  /** Room data this device cannot show, said once per key. */
  private warn(key: string, text: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.say(text, "data");
  }

  /** Run a task after every task queued before it (or before all of them, with front). Resolves undefined if dropped. */
  private enqueue<T>(task: () => Promise<T>, front = false): Promise<T | undefined> {
    return new Promise((resolve) => {
      const entry = async () => {
        try {
          resolve(this.disposed ? undefined : await task());
        } catch (error) {
          this.say(`Multiplayer error: ${message(error)}`, "internal");
          resolve(undefined);
        }
      };
      if (front) this.queue.unshift(entry);
      else this.queue.push(entry);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.disposed) await this.queue.shift()!();
    } finally {
      this.pumping = false;
    }
  }

  /**
   * One reducer call through Multiplayer.attempt. Resolves to undefined on success, else to the server's reason. A
   * call still unanswered after 5 s counts as failed; if it succeeds later after all, onLate runs. The adapter shows
   * its own errors, so the call leaves net.failure (the room panel's error) alone.
   */
  private async call(
    action: (reducers: Reducers) => Promise<unknown>,
    onLate?: () => void,
  ): Promise<string | undefined> {
    if (this.disposed) return "the multiplayer adapter stopped";
    const done = this.net.attempt(() => action(this.net.connection!.reducers), null);
    const answer = await this.within(
      done.then((error) => ({ error })),
      CALL_TIMEOUT_MS,
    );
    if (answer === undefined) {
      if (onLate)
        void done.then((late) => {
          if (late === undefined) onLate();
        });
      return "the server did not answer in time";
    }
    return answer.error;
  }

  /**
   * call(), reporting a failure as "Could not <what>: <reason>", unless it was about a hold revoked meanwhile.
   * Resolves to true on success.
   */
  private async calling(
    what: string,
    kind: ReportKind,
    action: (reducers: Reducers) => Promise<unknown>,
    about?: Owned,
  ): Promise<boolean> {
    const error = await this.call(action);
    if (!error) return true;
    if (about) about.failed = true;
    if (!about || this.owned.get(about.objectId) === about) this.say(`Could not ${what}: ${error}`, kind);
    return false;
  }

  /** The promise's value, or undefined after ms or once the adapter is disposed. */
  private within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const finish = (value: T | undefined) => {
        this.cancelers.delete(cancel);
        clearTimeout(timer);
        this.timers.delete(timer);
        resolve(value);
      };
      const cancel = () => finish(undefined);
      const timer = this.later(cancel, ms);
      this.cancelers.add(cancel);
      promise.then(finish, () => finish(undefined));
    });
  }

  /** probe()'s first truthy value, checked every 20 ms, or undefined after ms or once disposed. */
  private until<T>(probe: () => T | undefined, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const deadline = performance.now() + ms;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: T | undefined) => {
        this.cancelers.delete(cancel);
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const cancel = () => finish(undefined);
      const check = () => {
        const value = this.disposed ? undefined : probe();
        if (value || this.disposed || performance.now() >= deadline) finish(value);
        else timer = setTimeout(check, 20);
      };
      this.cancelers.add(cancel);
      check();
    });
  }

  /** Resolves once the viewer takes the grant for objectId or gives it back, after DECISION_TIMEOUT_MS, or on dispose. */
  private decision(objectId: string): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.decisions.get(objectId) === done) this.decisions.delete(objectId);
        this.cancelers.delete(done);
        clearTimeout(timer);
        this.timers.delete(timer);
        resolve();
      };
      const timer = this.later(done, DECISION_TIMEOUT_MS);
      this.decisions.set(objectId, done);
      this.cancelers.add(done);
    });
  }

  private decided(objectId: string): void {
    this.decisions.get(objectId)?.();
  }

  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }
}
