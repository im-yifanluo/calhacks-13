import { databaseSettings, savedAccount } from "../account/key";
import { DbConnection, tables } from "../module_bindings";
import { DisconnectedError, type Identity } from "spacetimedb";
import type { Memory, Room, Player, Timeline, Branch, ObjectState, BranchKeyframes } from "../module_bindings/types";
import { claimStoredToken, holdLock, lockName, type Locks } from "./identity-lock";
export type { Memory, Room, Player, Timeline, Branch, ObjectState, BranchKeyframes };
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
export const CONNECTION_WAIT_MS = 15000;
const CONNECTION_WATCHDOG_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 8000;
/** Delay before rebuilding after the n-th failed first connection (the SDK only retries established ones). */
export const initialRetryDelayMs = (failures: number) =>
  Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** Math.max(0, failures - 1));
const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A failed call or connection, by what it was about. A later success of the same kind clears it. */
export interface Failure {
  readonly kind: string;
  readonly message: string;
}

export class Multiplayer extends EventTarget {
  /** Library-only guest persistence. Viewer tabs retain separate player identities. */
  private get tokenStorage() {
    return this.persistentLibraryGuest ? localStorage : sessionStorage;
  }
  private rememberToken(key: string, token: string) {
    if (savedAccount()) return; // a password account keeps its token in the account store
    if (!this.persistentLibraryGuest) this.hold(token);
    this.tokenStorage.setItem(key, token);
  }
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
  private watchdog?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private generation = 0;
  private authBlocked = false;
  private initialFailures = 0;
  private disposed = false;
  /** The token this page holds the lock for. */
  private held?: { token: string; release: () => void };
  /** sessionStorage key of this database's token, set by connect(). */
  private key = "";
  private poseAt = 0;
  private queued = false;
  /** persistentLibraryGuest: the library page keeps one guest identity across visits (localStorage); viewer tabs
   *  keep separate player identities (sessionStorage). */
  constructor(private persistentLibraryGuest = false) {
    super();
    globalThis.window?.addEventListener?.("online", this.resume);
    globalThis.window?.addEventListener?.("pageshow", this.resume);
    globalThis.document?.addEventListener?.("visibilitychange", this.resume);
  }
  private resume = () => {
    if (this.disposed || globalThis.document?.visibilityState === "hidden") return;
    if (!this.ready || !this.connection?.isActive) this.reconnect();
    else this.syncClock();
  };
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
    if (this.disposed || this.authBlocked || this.connecting || (this.ready && this.connection?.isActive)) return;
    this.connecting = true;
    this.ready = false;
    const generation = ++this.generation;
    const previous = this.connection;
    this.connection = undefined;
    previous?.disconnect();
    clearTimeout(this.retryTimer);
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    this.watchConnection();
    const key =
      (this.key = `memreplay-${this.persistentLibraryGuest ? "library-" : ""}token:${import.meta.env.VITE_STDB_DATABASE || "memory-replay"}`);
    const account = savedAccount();
    if (account) return this.open(key, account.token);
    const storage = this.tokenStorage;
    const stored = storage.getItem(key) || undefined;
    if (this.persistentLibraryGuest || !stored || this.held?.token === stored) return this.open(key, stored);
    void claimStoredToken(storage, key, this.locks)
      .catch(() => ({ token: stored, release: () => {} }))
      .then(({ token, release }) => {
        if (this.disposed || generation !== this.generation) return release();
        if (token) this.hold(token, release);
        else {
          this.status = "This identity is open in another tab — connecting as a new guest…";
          this.changed();
        }
        this.open(key, token);
      });
  }
  /** Replace a stalled socket, keeping this visitor's identity and the shared database. */
  reconnect() {
    if (this.disposed || this.authBlocked) return;
    this.connecting = false;
    this.ready = false;
    this.status = "Reconnecting…";
    this.changed();
    this.connect();
  }
  private blockAuth(message: string) {
    this.authBlocked = true;
    this.connecting = false;
    this.ready = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    this.status = message;
    this.changed();
  }
  private watchConnection() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.reconnect(), CONNECTION_WATCHDOG_MS);
  }
  private retry() {
    if (this.disposed || this.authBlocked) return;
    this.connecting = false;
    const delay = initialRetryDelayMs(++this.initialFailures);
    this.status = `Can't reach the multiplayer server — retrying in ${seconds(delay)} s`;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.changed();
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
    const settings = databaseSettings();
    const connection: DbConnection = DbConnection.builder()
      .withUri(settings.uri)
      .withDatabaseName(settings.database)
      .withToken(storedToken)
      .withAutomaticReconnect({ maxDelayMs: RECONNECT_MAX_DELAY_MS })
      .onConnect((conn, identity, token) => {
        if (this.connection !== connection || this.disposed) return;
        connected = true;
        this.connecting = false;
        this.initialFailures = 0;
        this.bestRtt = Infinity;
        this.identity = identity;
        this.token = token;
        const account = savedAccount();
        if (account && account.identity !== identity.toHexString()) {
          this.blockAuth("This password could not be verified. Sign out and use your saved password.");
          conn.disconnect();
          return;
        }
        // Lock before storing: a tab duplicated from now on copies the token and must find it taken.
        this.rememberToken(key, token);
        const changed = this.changed;
        for (const table of [
          conn.db.memory,
          conn.db.room,
          conn.db.party,
          conn.db.profile,
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
            if (this.connection !== connection || this.disposed || !conn.isActive) return;
            clearTimeout(this.watchdog);
            this.ready = true;
            this.status = "Connected";
            this.resolve("connection");
            this.changed();
            this.syncClock();
            if (!this.clockTimer) this.clockTimer = setInterval(() => this.syncClock(), 30000);
          })
          .onError((ctx) => {
            if (this.connection !== connection || this.disposed) return;
            this.ready = false;
            this.report(ctx.event, "connection");
            this.retry();
          })
          .subscribe([
            tables.memory,
            tables.room,
            tables.party,
            tables.profile,
            tables.player,
            tables.timeline,
            tables.branch,
            tables.objectState,
            tables.branchKeyframes,
            tables.clockSample,
          ]);
      })
      .onAutomaticReconnect((_conn, identity, token) => {
        if (this.connection !== connection || this.disposed) return;
        this.ready = false;
        this.identity = identity;
        this.token = token;
        this.bestRtt = Infinity;
        this.status = "Resynchronizing…";
        this.rememberToken(key, token);
        this.changed();
      })
      // The SDK passes the next attempt number only when it will retry (automatic reconnect
      // of an established connection); undefined means it has given up for good.
      .onDisconnect((_ctx, error, nextAttempt, nextDelayMs) => {
        if (this.connection !== connection || this.disposed) return;
        this.ready = false;
        if (this.authBlocked) return;
        if (nextAttempt === undefined) this.retry();
        else {
          this.status = `Connection lost — reconnecting in ${seconds(nextDelayMs ?? 0)} s…`;
          this.watchConnection();
        }
        if (error) this.report(error, "connection");
        this.changed();
      })
      .onConnectError((_ctx, error, nextAttempt, nextDelayMs) => {
        if (this.connection !== connection || this.disposed) return;
        this.ready = false;
        this.connecting = false;
        if (savedAccount() && storedToken && tokenRejected(error)) {
          this.blockAuth("Password rejected — sign out and use a valid saved password");
        } else if (error.name === "IdentityChangedError") {
          this.blockAuth("Your identity changed — reload to sign in again");
        } else if (nextAttempt !== undefined) {
          this.status = `Reconnecting… (attempt ${nextAttempt}, next in ${seconds(nextDelayMs ?? 0)} s)`;
        } else if (!connected && storedToken && tokenRejected(error)) {
          // The server rejects this tab's saved identity: forget it and join as a new guest.
          this.tokenStorage.removeItem(key);
          this.held?.release();
          this.held = undefined;
          this.status = "Saved session expired — connecting as a new guest…";
          this.resolve("connection");
          this.connect();
          return;
        } else {
          // First connection failed (server down or unreachable). The SDK never retries these.
          this.retry();
        }
        this.report(error, "connection");
      })
      .build();
    this.connection = connection;
  }
  private syncClock() {
    const connection = this.connection;
    if (!this.ready || !connection || this.heartbeat) return;
    // A suspended phone can leave a socket looking open. An acknowledged
    // clock sample detects that without replaying any party/physics mutations.
    const timer = (this.heartbeat = setTimeout(() => {
      if (this.connection === connection) this.reconnect();
    }, HEARTBEAT_TIMEOUT_MS));
    void connection.reducers
      .sampleClock({ clientSentUs: BigInt(Date.now()) * 1000n })
      .catch(() => {
        if (this.connection === connection && this.ready) this.reconnect();
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.heartbeat === timer) this.heartbeat = undefined;
      });
  }
  /** Wait for both the socket and its subscribed tables before a user-requested call. */
  private waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.ready && this.connection?.isActive) return Promise.resolve();
    if (this.ready) this.reconnect();
    else if (!this.connection && !this.connecting) this.connect();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.removeEventListener("change", check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.disposed) finish(new Error("This page's connection was closed"));
        else if (this.authBlocked) finish(new Error(this.status));
        else if (this.ready && this.connection?.isActive) finish();
      };
      const timer = setTimeout(
        () => finish(new Error("Still reconnecting. Check your internet connection, then try again.")),
        Math.max(0, timeoutMs),
      );
      this.addEventListener("change", check);
      check();
    });
  }
  /** One reducer only: retry only when the SDK guarantees it was never sent. */
  async callConnected<T>(action: () => Promise<T>, timeoutMs = CONNECTION_WAIT_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      await this.waitUntilReady(deadline - Date.now());
      try {
        return await action();
      } catch (error) {
        // UnknownCallResultError means the server may have committed it: never replay.
        if (!(error instanceof DisconnectedError) || attempt >= 1 || Date.now() >= deadline) throw error;
        this.reconnect();
      }
    }
  }
  private calibrate(row: { identity: Identity; clientSentUs: bigint; serverTs: { microsSinceUnixEpoch: bigint } }) {
    if (!row.identity.isEqual(this.identity!)) return;
    const received = Date.now() * 1000,
      sent = Number(row.clientSentUs),
      rtt = received - sent;
    if (rtt >= 0 && rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offsetUs = Number(row.serverTs.microsSinceUnixEpoch) - (sent + received) / 2;
    }
  }
  /** Record a failure of this kind; it replaces any older one. */
  report(error: unknown, kind = "request") {
    let message = messageOf(error);
    // While SpacetimeDB is down, the dev proxy answers the SDK's token check with a 5xx.
    if (kind === "connection" && /verify token: 5\d\d/i.test(message))
      message = "The multiplayer server isn't answering; retrying.";
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
    waitForConnection = false,
  ): Promise<string | undefined> {
    try {
      if (waitForConnection) await this.waitUntilReady(CONNECTION_WAIT_MS);
      else if (!this.ready) throw new Error("Wait for the multiplayer connection");
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
    return this.identity ? this.connection?.db.player.identity.find(this.identity) : undefined;
  }
  get room() {
    const p = this.self;
    return p?.online ? this.connection?.db.room.id.find(p.roomId) : undefined;
  }
  get party() {
    const r = this.room;
    return r ? this.connection?.db.party.roomId.find(r.id) : undefined;
  }
  get isLeader() {
    return !!this.room?.host.isEqual(this.identity!);
  }
  get canControlTime() {
    return !this.party || (this.ready && this.isLeader);
  }
  get pendingMemory() {
    const id = this.party?.pendingMemoryId;
    return id ? this.connection?.db.memory.id.find(id) : undefined;
  }
  get timeline() {
    const r = this.room;
    return r ? this.connection?.db.timeline.roomId.find(r.id) : undefined;
  }
  get memory() {
    const r = this.room;
    return r ? this.connection?.db.memory.id.find(r.memoryId) : undefined;
  }
  /** Personal library. A joined party reads its shared memory separately via `memory`. */
  get memories() {
    return this.connection && this.identity
      ? [...this.connection.db.memory.iter()]
          .filter((m) => m.owner.isEqual(this.identity!))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : [];
  }
  get players() {
    const r = this.room;
    return r ? [...this.connection!.db.player.iter()].filter((p) => p.roomId === r.id && p.online) : [];
  }
  time() {
    const tl = this.timeline;
    if (!tl) return 0;
    const elapsed = tl.paused
      ? 0
      : Math.max(0, (Date.now() * 1000 + this.offsetUs - Number(tl.anchorServerTs.microsSinceUnixEpoch)) * tl.speed);
    return Math.min(Number(this.memory?.durationUs ?? 0n) / 1e6, (Number(tl.anchorMediaUs) + elapsed) / 1e6);
  }
  sendPose(p: Omit<Player, "identity" | "roomId" | "name" | "device" | "color" | "online">) {
    const now = performance.now();
    if (!this.ready || !this.room || now - this.poseAt < 80) return;
    this.poseAt = now;
    void this.attempt(() => this.connection!.reducers.setPose(p), null);
  }
  // Reports nothing here: the adapter shows its own errors in the status line.
  move(objectId: string, p: Pose) {
    return this.run(() => this.connection!.reducers.moveObject({ objectId, ...p }), null);
  }
  dispose() {
    this.disposed = true;
    this.ready = false;
    this.generation++;
    globalThis.window?.removeEventListener?.("online", this.resume);
    globalThis.window?.removeEventListener?.("pageshow", this.resume);
    globalThis.document?.removeEventListener?.("visibilitychange", this.resume);
    if (this.clockTimer) clearInterval(this.clockTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    clearTimeout(this.heartbeat);
    this.connection?.disconnect();
    this.held?.release();
    this.held = undefined;
    this.changed();
  }
}
