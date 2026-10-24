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
/**
 * True for the SDK's failure to exchange a stored token (`WebSocketTokenError`, HTTP 401): the
 * server no longer accepts it, for example after its data directory was reset. The SDK does not
 * export that class, so match its name and status.
 */
export function tokenRejected(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "WebSocketTokenError" &&
    (error as Error & { status?: unknown }).status === 401
  );
}
/**
 * The longest wait between two connection attempts (ms), for the SDK's automatic reconnect and
 * for our own first-connection retries. The SDK's default, 30 s, left a restarted server
 * unreachable for up to about 25 s.
 */
export const RECONNECT_MAX_DELAY_MS = 5000;
/** Delay before rebuilding after the n-th failed first connection (the SDK only retries established ones). */
export const initialRetryDelayMs = (failures: number) =>
  Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** Math.max(0, failures - 1));
const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A failed call or connection, by what it was about. A later success of the same kind clears it. */
export interface Failure {
  readonly kind: string;
  readonly message: string;
}

/** The part of the Web Locks API (`navigator.locks`) used to tell tabs apart. */
export type Locks = Pick<LockManager, "request">;
/** How long a page waits for its stored identity before deciding another live tab uses it (ms). */
export const IDENTITY_WAIT_MS = 1000;

/** A short, stable tag for a token, so lock names never contain the token itself (53-bit cyrb53). */
export function tokenTag(token: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const lockName = (key: string, token: string) => `${key}:${tokenTag(token)}`;

/**
 * Holds the exclusive Web Lock `name` until the returned function is called. Resolves to undefined
 * when another page still holds it after `waitMs` (0: only if it is free right now). Without Web
 * Locks (an insecure origin, an old browser) every page gets it.
 */
export function holdLock(
  locks: Locks | undefined,
  name: string,
  waitMs: number,
): Promise<(() => void) | undefined> {
  const none = () => {};
  if (!locks) return Promise.resolve(none);
  return new Promise((resolve) => {
    let letGo = none;
    const held = new Promise<void>((done) => (letGo = done));
    const abort = new AbortController();
    const timer = waitMs > 0 ? setTimeout(() => abort.abort(), waitMs) : undefined;
    const options: LockOptions = waitMs > 0 ? { signal: abort.signal } : { ifAvailable: true };
    // AbortError: still held elsewhere after waitMs. Any other error means locks don't work here.
    const failed = (error: unknown) => {
      clearTimeout(timer);
      resolve((error as Error)?.name === "AbortError" ? undefined : none);
    };
    try {
      locks
        .request(name, options, (lock) => {
          clearTimeout(timer);
          resolve(lock ? letGo : undefined);
          return lock ? held : undefined;
        })
        .catch(failed);
    } catch (error) {
      failed(error);
    }
  });
}

/**
 * The token this page may connect with. A duplicated tab, or a window the app opens, starts with a
 * copy of its opener's sessionStorage, so with the same SpacetimeDB identity, and two tabs with one
 * identity release each other's objects. Every page holds a Web Lock named after its token while it
 * uses it; a page that finds the lock taken drops its copy and connects as a new guest. A reload
 * waits up to `waitMs` for its previous page to let go.
 */
export async function claimStoredToken(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  locks: Locks | undefined,
  waitMs = IDENTITY_WAIT_MS,
): Promise<{ token?: string; release: () => void }> {
  const token = storage.getItem(key) || undefined;
  if (!token) return { release: () => {} };
  const release = await holdLock(locks, lockName(key, token), waitMs);
  if (release) return { token, release };
  storage.removeItem(key);
  return { release: () => {} };
}

export class Multiplayer extends EventTarget {
  connection?: DbConnection;
  identity?: Identity;
  token = "";
  ready = false;
  status = "Connecting…";
  /** The newest failure no later success of the same kind has cleared. */
  failure?: Failure;
  /** Web Locks used to keep one identity per tab; tests replace it. */
  locks: Locks | undefined = globalThis.navigator?.locks;
  offsetUs = 0;
  private bestRtt = Infinity;
  private clockTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private initialFailures = 0;
  private disposed = false;
  /** The token this page holds the lock for. */
  private held?: { token: string; release: () => void };
  /** sessionStorage key of this database's token, set by connect(). */
  private key = "";
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
  /** The newest failure's message, or "". */
  get error(): string {
    return this.failure?.message ?? "";
  }
  connect() {
    if (this.disposed) return;
    const key = (this.key = `memreplay-token:${import.meta.env.VITE_STDB_DATABASE || "memory-replay"}`);
    const storage = sessionStorage;
    const stored = storage.getItem(key) || undefined;
    if (!stored || this.held?.token === stored) return this.open(key, stored);
    void claimStoredToken(storage, key, this.locks)
      .catch(() => ({ token: stored, release: () => {} }))
      .then(({ token, release }) => {
        if (this.disposed) return release();
        if (token) this.hold(token, release);
        else {
          this.status = "This identity is open in another tab — connecting as a new guest…";
          this.changed();
        }
        this.open(key, token);
      });
  }
  /** Keep the lock for `token` (taking it now if no release is given) and let go of any other. */
  private hold(token: string, release?: () => void) {
    if (this.held?.token === token) return release?.();
    this.held?.release();
    const held = { token, release: release ?? (() => {}) };
    this.held = held;
    if (release) return;
    // A new guest's token: free, unless a tab copied it in the instant before this.
    void holdLock(this.locks, lockName(this.key, token), 0).then((letGo) => {
      if (this.held === held && !this.disposed) held.release = letGo ?? held.release;
      else letGo?.();
    });
  }
  private open(key: string, storedToken: string | undefined) {
    let connected = false;
    const connection: DbConnection = DbConnection.builder()
      .withUri(
        import.meta.env.VITE_STDB_URL ||
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stdb/`,
      )
      .withDatabaseName(import.meta.env.VITE_STDB_DATABASE || "memory-replay")
      .withToken(storedToken)
      .withAutomaticReconnect({ maxDelayMs: RECONNECT_MAX_DELAY_MS })
      .onConnect((conn, identity, token) => {
        connected = true;
        this.initialFailures = 0;
        this.identity = identity;
        this.token = token;
        // Lock before storing: a tab duplicated from now on copies the token and must find it taken.
        this.hold(token);
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
          // Also runs after every automatic reconnect, once the cache is replayed.
          .onApplied(() => {
            this.ready = true;
            this.status = "Connected";
            this.resolve("connection");
            this.changed();
            this.syncClock();
            if (!this.clockTimer)
              this.clockTimer = setInterval(() => this.syncClock(), 30000);
          })
          .onError((ctx) => this.report(ctx.event, "connection"))
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
        this.hold(token);
        sessionStorage.setItem(key, token);
        this.changed();
      })
      // The SDK passes the next attempt number only when it will retry (automatic reconnect
      // of an established connection); undefined means it has given up for good.
      .onDisconnect((_ctx, error, nextAttempt, nextDelayMs) => {
        if (this.connection !== connection || this.disposed) return;
        this.ready = false;
        this.status =
          nextAttempt === undefined
            ? "Disconnected — reload to reconnect"
            : `Connection lost — reconnecting in ${seconds(nextDelayMs ?? 0)} s…`;
        if (error) this.report(error, "connection");
        this.changed();
      })
      .onConnectError((_ctx, error, nextAttempt, nextDelayMs) => {
        if (this.connection !== connection || this.disposed) return;
        this.ready = false;
        if (nextAttempt !== undefined) {
          this.status = `Reconnecting… (attempt ${nextAttempt}, next in ${seconds(nextDelayMs ?? 0)} s)`;
        } else if (connected) {
          this.status = "Connection failed — reload to retry";
        } else if (storedToken && tokenRejected(error)) {
          // The server rejects this tab's saved identity: forget it and join as a new guest.
          sessionStorage.removeItem(key);
          this.held?.release();
          this.held = undefined;
          this.status = "Saved session expired — connecting as a new guest…";
          this.resolve("connection");
          this.connect();
          return;
        } else {
          // First connection failed (server down or unreachable). The SDK never retries these.
          const delay = initialRetryDelayMs(++this.initialFailures);
          this.status = `Can't reach the multiplayer server — retrying in ${seconds(delay)} s`;
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => {
            if (!this.disposed) this.connect();
          }, delay);
        }
        this.report(error, "connection");
      })
      .build();
    this.connection = connection;
  }
  private syncClock() {
    if (this.ready)
      void this.attempt(
        () =>
          this.connection!.reducers.sampleClock({
            clientSentUs: BigInt(Date.now()) * 1000n,
          }),
        null,
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
  /** Record a failure of this kind; it replaces any older one. */
  report(error: unknown, kind = "request") {
    let message = messageOf(error);
    // While SpacetimeDB is down, the dev proxy answers the SDK's token check with a 5xx.
    if (kind === "connection" && /verify token: 5\d\d/i.test(message)) message = "The multiplayer server isn't answering; retrying.";
    this.failure = { kind, message };
    this.changed();
  }
  /** An action of this kind succeeded: clear the failure if it is of the same kind. */
  resolve(kind: string) {
    if (this.failure?.kind !== kind) return;
    this.failure = undefined;
    this.changed();
  }
  /**
   * One server call. Resolves to undefined on success, else to the reason. `kind` says what the
   * call is about: a failure becomes `failure`, and a success clears only a failure of the same
   * kind. null leaves `failure` alone, for callers that show their own errors.
   */
  async attempt(
    action: () => Promise<unknown>,
    kind: string | null = "request",
  ): Promise<string | undefined> {
    try {
      if (!this.ready) throw new Error("Wait for the multiplayer connection");
      await action();
      if (kind !== null) this.resolve(kind);
      return undefined;
    } catch (e) {
      if (kind !== null) this.report(e, kind);
      return messageOf(e);
    }
  }
  /** attempt(), as true on success. */
  async run(action: () => Promise<unknown>, kind: string | null = "request") {
    return (await this.attempt(action, kind)) === undefined;
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
  /** Library rows in id order, so the list keeps its order across reconnects. */
  get memories() {
    return this.connection
      ? [...this.connection.db.memory.iter()].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        )
      : [];
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
    void this.attempt(() => this.connection!.reducers.setPose(p), null);
  }
  // Object calls report nothing here: the adapter shows its own errors in the status line.
  grab(objectId: string, p: Pose) {
    return this.run(() => this.connection!.reducers.grab({ objectId, ...p }), null);
  }
  move(objectId: string, p: Pose) {
    return this.run(
      () => this.connection!.reducers.moveObject({ objectId, ...p }),
      null,
    );
  }
  release(objectId: string, rest: boolean, p: Pose) {
    return this.run(
      () => this.connection!.reducers.release({ objectId, rest, ...p }),
      null,
    );
  }
  dispose() {
    this.disposed = true;
    if (this.clockTimer) clearInterval(this.clockTimer);
    clearTimeout(this.retryTimer);
    this.connection?.disconnect();
    this.held?.release();
    this.held = undefined;
  }
}
