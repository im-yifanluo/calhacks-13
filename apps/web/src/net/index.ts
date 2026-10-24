import { DbConnection, tables } from "../module_bindings";
import type { Identity } from "spacetimedb";
import type {
  Memory,
  Room,
  Player,
  Timeline,
  Branch,
  ObjectState,
  BranchKeyframes,
} from "../module_bindings/types";
export type {
  Memory,
  Room,
  Player,
  Timeline,
  Branch,
  ObjectState,
  BranchKeyframes,
};
export type Pose = {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
};
export class Multiplayer extends EventTarget {
  connection?: DbConnection;
  identity?: Identity;
  token = "";
  ready = false;
  status = "Connecting…";
  error = "";
  offsetUs = 0;
  private bestRtt = Infinity;
  private clockTimer?: ReturnType<typeof setInterval>;
  private poseAt = 0;
  private queued = false;
  private changed = () => {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.dispatchEvent(new Event("change"));
    });
  };
  connect() {
    const key = `memreplay-token:${import.meta.env.VITE_STDB_DATABASE || "memory-replay"}`;
    this.connection = DbConnection.builder()
      .withUri(
        import.meta.env.VITE_STDB_URL ||
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stdb/`,
      )
      .withDatabaseName(import.meta.env.VITE_STDB_DATABASE || "memory-replay")
      .withToken(sessionStorage.getItem(key) || undefined)
      .withAutomaticReconnect()
      .onConnect((conn, identity, token) => {
        this.identity = identity;
        this.token = token;
        sessionStorage.setItem(key, token);
        const changed = this.changed;
        for (const table of [
          conn.db.memory,
          conn.db.room,
          conn.db.player,
          conn.db.timeline,
          conn.db.branch,
          conn.db.objectState,
          conn.db.branchKeyframes,
        ]) {
          table.onInsert(changed);
          table.onUpdate(changed);
          table.onDelete(changed);
        }
        conn.db.clockSample.onInsert((_ctx, row) => this.calibrate(row));
        conn.db.clockSample.onUpdate((_ctx, _old, row) => this.calibrate(row));
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            this.ready = true;
            this.status = "Connected";
            this.changed();
            this.syncClock();
            if (!this.clockTimer)
              this.clockTimer = setInterval(() => this.syncClock(), 30000);
          })
          .onError((ctx) => this.report(ctx.event))
          .subscribe([
            tables.memory,
            tables.room,
            tables.player,
            tables.timeline,
            tables.branch,
            tables.objectState,
            tables.branchKeyframes,
            tables.clockSample,
          ]);
      })
      .onAutomaticReconnect((_conn, identity, token) => {
        this.identity = identity;
        this.token = token;
        this.bestRtt = Infinity;
        this.status = "Resynchronizing…";
        sessionStorage.setItem(key, token);
        this.changed();
      })
      .onDisconnect((_ctx, error) => {
        this.ready = false;
        this.status = "Disconnected — reconnecting";
        if (error) this.error = error.message;
        this.changed();
      })
      .onConnectError((_ctx, error) => {
        this.ready = false;
        this.status = "Connection failed — reload to retry";
        this.error = error.message;
        this.changed();
      })
      .build();
  }
  private syncClock() {
    if (this.ready)
      void this.run(() =>
        this.connection!.reducers.sampleClock({
          clientSentUs: BigInt(Date.now()) * 1000n,
        }),
      );
  }
  private calibrate(row: {
    identity: Identity;
    clientSentUs: bigint;
    serverTs: { microsSinceUnixEpoch: bigint };
  }) {
    if (!row.identity.isEqual(this.identity!)) return;
    const received = Date.now() * 1000,
      sent = Number(row.clientSentUs),
      rtt = received - sent;
    if (rtt >= 0 && rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offsetUs =
        Number(row.serverTs.microsSinceUnixEpoch) - (sent + received) / 2;
    }
  }
  report(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
    this.changed();
  }
  async run(action: () => Promise<unknown>, clearError = true) {
    try {
      if (!this.ready) throw new Error("Wait for the multiplayer connection");
      await action();
      if (clearError) {
        this.error = "";
        this.changed();
      }
      return true;
    } catch (e) {
      this.report(e);
      return false;
    }
  }
  get self() {
    return this.identity
      ? this.connection?.db.player.identity.find(this.identity)
      : undefined;
  }
  get room() {
    const p = this.self;
    return p?.online ? this.connection?.db.room.id.find(p.roomId) : undefined;
  }
  get timeline() {
    const r = this.room;
    return r ? this.connection?.db.timeline.roomId.find(r.id) : undefined;
  }
  get memory() {
    const r = this.room;
    return r ? this.connection?.db.memory.id.find(r.memoryId) : undefined;
  }
  get memories() {
    return this.connection ? [...this.connection.db.memory.iter()] : [];
  }
  get players() {
    const r = this.room;
    return r
      ? [...this.connection!.db.player.iter()].filter(
          (p) => p.roomId === r.id && p.online,
        )
      : [];
  }
  get branches() {
    const r = this.room;
    return r
      ? [...this.connection!.db.branch.iter()].filter((b) => b.roomId === r.id)
      : [];
  }
  get objects() {
    const tl = this.timeline;
    return tl
      ? [...this.connection!.db.objectState.iter()].filter(
          (o) => o.branchId === tl.branchId,
        )
      : [];
  }
  get chunks() {
    const ids = new Set(this.branches.map((b) => b.id));
    return this.connection
      ? [...this.connection.db.branchKeyframes.iter()].filter((c) =>
          ids.has(c.branchId),
        )
      : [];
  }
  time() {
    const tl = this.timeline;
    if (!tl) return 0;
    const elapsed = tl.paused
      ? 0
      : Math.max(
          0,
          (Date.now() * 1000 +
            this.offsetUs -
            Number(tl.anchorServerTs.microsSinceUnixEpoch)) *
            tl.speed,
        );
    return Math.min(
      Number(this.memory?.durationUs ?? 0n) / 1e6,
      (Number(tl.anchorMediaUs) + elapsed) / 1e6,
    );
  }
  sendPose(
    p: Omit<
      Player,
      "identity" | "roomId" | "name" | "device" | "color" | "online"
    >,
  ) {
    const now = performance.now();
    if (!this.ready || !this.room || now - this.poseAt < 80) return;
    this.poseAt = now;
    void this.run(() => this.connection!.reducers.setPose(p), false);
  }
  grab(objectId: string, p: Pose) {
    return this.run(() => this.connection!.reducers.grab({ objectId, ...p }));
  }
  move(objectId: string, p: Pose) {
    return this.run(
      () => this.connection!.reducers.moveObject({ objectId, ...p }),
      false,
    );
  }
  release(objectId: string, rest: boolean, p: Pose) {
    return this.run(() =>
      this.connection!.reducers.release({ objectId, rest, ...p }),
    );
  }
  dispose() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.connection?.disconnect();
  }
}
