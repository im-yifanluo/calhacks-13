import { afterEach, describe, expect, test, vi } from "vitest";
import {
  computeReconnectDelayMs,
  DisconnectedError,
  Identity,
  resolveReconnectPolicy,
  UnknownCallResultError,
} from "spacetimedb";
import { accountStorageKey, databaseSettings, encodeAccountKey } from "../apps/web/src/account-key";
import { DbConnection } from "../apps/web/src/module_bindings";
import {
  claimStoredToken,
  IDENTITY_WAIT_MS,
  initialRetryDelayMs,
  type Locks,
  Multiplayer,
  RECONNECT_MAX_DELAY_MS,
  tokenRejected,
} from "../apps/web/src/net";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => unknown, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}
/** One tab's sessionStorage. */
function storage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

/** Web Locks as browsers implement them (exclusive, FIFO, ifAvailable, signal), for Node versions without them. */
function fakeLocks(): Locks {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const free = (name: string) => {
    held.delete(name);
    waiting.get(name)?.shift()?.();
  };
  return {
    request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) {
      return new Promise((resolve, reject) => {
        const run = () => {
          held.add(name);
          Promise.resolve()
            .then(() => callback({ name, mode: "exclusive" }))
            .then(resolve, reject)
            .finally(() => free(name));
        };
        if (!held.has(name)) return run();
        if (options.ifAvailable) return void Promise.resolve(callback(null)).then(resolve, reject);
        const queue = waiting.get(name) ?? [];
        waiting.set(name, queue);
        const entry = () => {
          options.signal?.removeEventListener("abort", abort);
          run();
        };
        const abort = () => {
          queue.splice(queue.indexOf(entry), 1);
          reject(new DOMException("The request was aborted", "AbortError"));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        queue.push(entry);
      });
    },
  } as Locks;
}
const lockManagers: Array<[string, () => Locks | undefined]> = [
  ["a Web Locks fake", fakeLocks],
  ["Node's navigator.locks", () => globalThis.navigator?.locks],
];

interface Build {
  token?: string;
  reconnect?: unknown;
  on: Record<string, (...args: any[]) => void>;
  conn: ReturnType<typeof fakeConnection>;
}
/** A stand-in for the SDK connection Multiplayer builds: the tables it hooks, a subscription and sampleClock. */
function fakeConnection() {
  const table = () => ({ onInsert() {}, onUpdate() {}, onDelete() {} });
  let applied = () => {};
  const subscription = {
    onApplied: (cb: () => void) => ((applied = cb), subscription),
    onError: () => subscription,
    subscribe: () => ({}),
  };
  return {
    isActive: true,
    db: Object.fromEntries(
      [
        "memory",
        "room",
        "party",
        "profile",
        "player",
        "timeline",
        "branch",
        "objectState",
        "branchKeyframes",
        "clockSample",
      ].map((n) => [n, table()]),
    ),
    subscriptionBuilder: () => subscription,
    reducers: { sampleClock: async () => {} },
    disconnect: vi.fn(),
    applied: () => applied(),
  };
}
/** Replaces DbConnection.builder; every connection Multiplayer builds is recorded. */
function recordBuilds(): Build[] {
  const builds: Build[] = [];
  vi.spyOn(DbConnection, "builder").mockImplementation(() => {
    const build: Build = { on: {}, conn: fakeConnection() };
    const builder: any = new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          (...args: any[]) => {
            if (name === "withToken") build.token = args[0];
            if (name === "withAutomaticReconnect") build.reconnect = args[0];
            if (name.startsWith("on")) build.on[name] = args[0];
            if (name !== "build") return builder;
            builds.push(build);
            return build.conn;
          },
      },
    );
    return builder;
  });
  return builds;
}
/** A browser tab: its own sessionStorage, the page's location and a database name for this test. */
function tab(database: string, entries: Record<string, string> = {}) {
  const session = storage(entries);
  vi.stubEnv("VITE_STDB_DATABASE", database);
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5184" });
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", storage({}));
  return session;
}
const nets: Multiplayer[] = [];
function multiplayer(locks: Locks | undefined): Multiplayer {
  const net = new Multiplayer();
  net.locks = locks;
  nets.push(net);
  return net;
}

afterEach(() => {
  for (const net of nets.splice(0)) net.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("connection", () => {
  test("personal credentials survive reconnect without becoming guest tokens; rejection never silently changes identity", () => {
    const credential = "header.payload.signature";
    const builds = recordBuilds();
    const session = tab("account", { "memreplay-token:account": "saved-guest" });
    session.setItem(
      accountStorageKey(),
      encodeAccountKey({ ...databaseSettings(), identity: new Identity(9n).toHexString(), token: credential }),
    );
    const net = multiplayer(undefined);
    net.connect();
    expect(builds[0].token).toBe(credential);
    const { on, conn } = builds[0];
    on.onConnect(conn, new Identity(9n), "transport-token");
    conn.applied();
    on.onAutomaticReconnect(conn, new Identity(9n), "new-transport-token");
    expect(session.getItem(accountStorageKey())).toContain("memos1.");
    expect(session.getItem("memreplay-token:account")).toBe("saved-guest");
    net.dispose();
    const next = multiplayer(undefined);
    next.connect();
    const rejected = Object.assign(new Error("Rejected"), { name: "WebSocketTokenError", status: 401 });
    builds[1].on.onConnectError({}, rejected);
    expect(next.status).toContain("Password rejected");
    expect(builds).toHaveLength(2);
    expect(session.getItem(accountStorageKey())).toContain("memos1.");
  });

  test("only a 401 token exchange counts as a rejected token", () => {
    const error = (name: string, status?: number) =>
      Object.assign(new Error("Failed to verify token"), { name, status });
    expect(tokenRejected(error("WebSocketTokenError", 401))).toBe(true);
    expect(tokenRejected(error("WebSocketTokenError", 500))).toBe(false);
    expect(tokenRejected(error("TypeError"))).toBe(false);
    expect(tokenRejected("401")).toBe(false);
  });

  test("first-connection retries back off to 5 s", () => {
    expect([1, 2, 3, 4, 6, 20].map(initialRetryDelayMs)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });

  test("automatic reconnect never waits more than 5 s between attempts (the SDK default reaches 30 s)", () => {
    const builds = recordBuilds();
    tab(`reconnect-${Math.random()}`);
    multiplayer(undefined).connect();
    expect(builds[0].reconnect).toEqual({ maxDelayMs: RECONNECT_MAX_DELAY_MS });
    const policy = resolveReconnectPolicy(builds[0].reconnect as never);
    for (const random of [0, 0.5, 0.999999]) {
      const delays = Array.from({ length: 12 }, (_, i) => computeReconnectDelayMs(i + 1, () => random, policy));
      expect(Math.max(...delays)).toBeLessThanOrEqual(5000);
    }
    expect(computeReconnectDelayMs(5, () => 0.999999)).toBeGreaterThan(20_000); // why: the SDK's own default
  });

  test("status follows a lost connection, each retry and the reconnect; the connection error then clears", async () => {
    const builds = recordBuilds();
    tab(`status-${Math.random()}`);
    const net = multiplayer(undefined);
    net.connect();
    const { on, conn } = builds[0];
    on.onConnect(conn, new Identity(7n), "token-1");
    conn.applied();
    expect([net.ready, net.status, net.error]).toEqual([true, "Connected", ""]);
    on.onDisconnect({}, new Error("WebSocket closed (code 1006)"), 1, 1400);
    expect([net.ready, net.status, net.error]).toEqual([
      false,
      "Connection lost — reconnecting in 1 s…",
      "WebSocket closed (code 1006)",
    ]);
    on.onConnectError({}, new Error("Failed to connect"), 2, 2600);
    expect([net.status, net.failure]).toEqual([
      "Reconnecting… (attempt 2, next in 3 s)",
      { kind: "connection", message: "Failed to connect" },
    ]);
    on.onAutomaticReconnect(conn, new Identity(7n), "token-1");
    expect(net.status).toBe("Resynchronizing…");
    conn.applied(); // the SDK replays the subscription after a reconnect
    expect([net.ready, net.status, net.error]).toEqual([true, "Connected", ""]);
  });
});

describe("connection recovery", () => {
  function setup() {
    vi.useFakeTimers();
    const builds = recordBuilds();
    tab("recovery");
    const net = multiplayer(undefined);
    net.connect();
    const establish = (build = builds.at(-1)!) => {
      build.on.onConnect(build.conn, new Identity(7n), "same-visitor");
      build.conn.applied();
    };
    return { builds, net, establish };
  }

  test("a terminal disconnect rebuilds automatically, preserves identity, and ignores old callbacks", async () => {
    const { builds, net, establish } = setup();
    establish();
    const old = builds[0];
    old.on.onDisconnect({}, new Error("Socket ended"));
    expect(net.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(builds).toHaveLength(2);
    expect(builds[1].token).toBe("same-visitor");
    expect(old.conn.disconnect).toHaveBeenCalledOnce();
    old.conn.applied();
    old.on.onAutomaticReconnect(old.conn, new Identity(99n), "obsolete-token");
    expect(net.ready).toBe(false);
    expect(net.identity?.toHexString()).toBe(new Identity(7n).toHexString());
    establish();
    expect([net.ready, net.status]).toEqual([true, "Connected"]);
  });

  test("a party request waits for the new socket and subscribed data after stale readiness", async () => {
    const { builds, net, establish } = setup();
    establish();
    builds[0].conn.isActive = false; // browser has not delivered its disconnect callback yet
    const create = vi.fn(async () => "party-code");
    const result = net.callConnected(create);
    expect(create).not.toHaveBeenCalled();
    expect(builds).toHaveLength(2);
    builds[1].on.onConnect(builds[1].conn, new Identity(7n), "same-visitor");
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled(); // the subscription still has to arrive
    builds[1].conn.applied();
    expect(await result).toBe("party-code");
    expect(create).toHaveBeenCalledOnce();
  });

  test("only a reducer that was definitely never sent is retried", async () => {
    const { builds, net, establish } = setup();
    establish();
    const create = vi.fn().mockRejectedValueOnce(new DisconnectedError()).mockResolvedValue("new-party");
    const result = net.callConnected(create);
    await vi.advanceTimersByTimeAsync(0);
    expect(builds).toHaveLength(2);
    establish();
    expect(await result).toBe("new-party");
    expect(create).toHaveBeenCalledTimes(2);
    const uncertain = vi.fn().mockRejectedValue(new UnknownCallResultError());
    await expect(net.callConnected(uncertain)).rejects.toBeInstanceOf(UnknownCallResultError);
    expect(uncertain).toHaveBeenCalledOnce();
    expect(builds).toHaveLength(2);
  });

  test("waiting is bounded and disposed pages never send a queued party request", async () => {
    const { net } = setup();
    const create = vi.fn(async () => {});
    const timeout = expect(net.callConnected(create, 100)).rejects.toThrow("Still reconnecting");
    await vi.advanceTimersByTimeAsync(100);
    await timeout;
    expect(create).not.toHaveBeenCalled();
    const disposed = expect(net.callConnected(create)).rejects.toThrow("connection was closed");
    net.dispose();
    await disposed;
    await vi.advanceTimersByTimeAsync(30000);
    expect(create).not.toHaveBeenCalled();
  });

  test("a first handshake that never finishes is replaced by the watchdog", async () => {
    const { builds } = setup();
    await vi.advanceTimersByTimeAsync(20000);
    expect(builds).toHaveLength(2);
    expect(builds[0].conn.disconnect).toHaveBeenCalledOnce();
  });

  test("returning online restarts a disconnected page and resumed stale sockets fail a heartbeat", async () => {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    const { builds, net, establish } = setup();
    window.dispatchEvent(new Event("online"));
    expect(builds).toHaveLength(2);
    establish();
    await vi.advanceTimersByTimeAsync(0); // finish the initial clock sample
    builds[1].conn.reducers.sampleClock = () => new Promise(() => {});
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(8000);
    expect(builds).toHaveLength(3);
    expect(net.ready).toBe(false);
    net.dispose();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pageshow"));
    expect(builds).toHaveLength(3);
  });

  test("rejected passwords never retry as a guest", async () => {
    const { builds, net } = setup();
    net.dispose();
    const credential = "header.payload.signature";
    sessionStorage.setItem(
      accountStorageKey(),
      encodeAccountKey({ ...databaseSettings(), identity: new Identity(9n).toHexString(), token: credential }),
    );
    const signedIn = multiplayer(undefined);
    signedIn.connect();
    builds[1].on.onConnectError({}, Object.assign(new Error("Rejected"), { name: "WebSocketTokenError", status: 401 }));
    signedIn.reconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(builds).toHaveLength(2);
    await expect(signedIn.callConnected(async () => {})).rejects.toThrow("Password rejected");
    expect(sessionStorage.getItem(accountStorageKey())).toContain("memos1.");
  });
});

describe("errors", () => {
  test("a success clears only an error of its own kind; a newer error replaces an older one", async () => {
    const net = new Multiplayer();
    net.ready = true;
    const fails = (reason: string) => () => Promise.reject(new Error(reason));
    const works = () => Promise.resolve();
    expect(await net.run(fails("Room not found"), "room")).toBe(false);
    expect(net.failure).toEqual({ kind: "room", message: "Room not found" });
    expect(await net.run(works, "library")).toBe(true);
    expect(net.error).toBe("Room not found"); // another kind's success leaves it
    expect(await net.attempt(works, null)).toBeUndefined(); // so does a call that reports its own errors
    expect(await net.attempt(fails("Wait for objects to settle"), null)).toBe("Wait for objects to settle");
    expect(net.error).toBe("Room not found"); // ... and its failures
    expect(await net.run(fails("Manifest returned 404"), "library")).toBe(false);
    expect(net.failure).toEqual({ kind: "library", message: "Manifest returned 404" });
    expect(await net.run(works, "room")).toBe(true);
    expect(net.error).toBe("Manifest returned 404"); // the room error was replaced, not restored
    expect(await net.run(works, "library")).toBe(true);
    expect(net.error).toBe("");
    net.ready = false;
    expect(await net.attempt(works)).toBe("Wait for the multiplayer connection");
  });
});

describe.each(lockManagers)("one identity per live tab, with %s", (_name, locksFor) => {
  const locks = locksFor();
  const skip = !locks;

  test.skipIf(skip)("a copied token is dropped while another tab holds it; a reload keeps it", async () => {
    const key = `memreplay-token:claim-${Math.random()}`;
    const a = await claimStoredToken(storage({ [key]: "token-a" }), key, locks, 200);
    expect(a.token).toBe("token-a");
    const copy = storage({ [key]: "token-a" }); // a duplicated tab, or window.open from the app
    const started = Date.now();
    expect((await claimStoredToken(copy, key, locks, 200)).token).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(copy.getItem(key)).toBeNull();
    // A reload: the old page lets go a moment after the new page asks.
    const reloaded = claimStoredToken(storage({ [key]: "token-a" }), key, locks, 1000);
    setTimeout(a.release, 50);
    const again = await reloaded;
    expect(again.token).toBe("token-a");
    again.release();
    expect((await claimStoredToken(storage({}), key, locks)).token).toBeUndefined(); // nothing stored: a new guest
  });

  test.skipIf(skip)(
    "Multiplayer: a duplicated tab connects as a new guest, whose token a later copy finds taken",
    async () => {
      const builds = recordBuilds();
      const database = `tabs-${Math.random()}`,
        key = `memreplay-token:${database}`;
      const tabA = tab(database, { [key]: "token-a" });
      const a = multiplayer(locks);
      a.connect();
      await until(() => builds.length === 1, "tab A's connection");
      expect(builds[0].token).toBe("token-a");

      tab(database, { [key]: "token-a" }); // duplicated from A
      const b = multiplayer(locks);
      b.connect();
      await until(() => builds.length === 2, "tab B's connection", IDENTITY_WAIT_MS + 2000);
      expect(builds[1].token).toBeUndefined(); // a new guest
      expect(b.status).toMatch(/open in another tab/);
      const tabB = sessionStorage;
      builds[1].on.onConnect(builds[1].conn, new Identity(2n), "token-b"); // the server's new identity
      expect(tabB.getItem(key)).toBe("token-b");
      expect(tabA.getItem(key)).toBe("token-a");

      tab(database, { [key]: "token-b" }); // window.open from B, after it connected
      multiplayer(locks).connect();
      await until(() => builds.length === 3, "tab C's connection", IDENTITY_WAIT_MS + 2000);
      expect(builds[2].token).toBeUndefined();

      tab(database, { [key]: "token-a" }); // A reloads: its old page goes away
      const reloaded = multiplayer(locks);
      reloaded.connect();
      a.dispose();
      await until(() => builds.length === 4, "A's reload", IDENTITY_WAIT_MS + 2000);
      expect(builds[3].token).toBe("token-a");
    },
  );
});

test("without Web Locks (an insecure origin) the stored token is used as before", async () => {
  const key = "memreplay-token:none";
  const copy = storage({ [key]: "token-a" });
  expect((await claimStoredToken(copy, key, undefined)).token).toBe("token-a");
  expect((await claimStoredToken(copy, key, undefined)).token).toBe("token-a");
  const broken = { request: () => Promise.reject(new DOMException("denied", "SecurityError")) } as unknown as Locks;
  expect((await claimStoredToken(copy, key, broken)).token).toBe("token-a");
});

test("library guest ID survives a new tab session without sharing a multiplayer player token", () => {
  const builds = recordBuilds();
  const session = tab("library-test");
  const persistent = storage();
  vi.stubGlobal("localStorage", persistent);
  const first = new Multiplayer(true);
  nets.push(first);
  first.connect();
  builds[0].on.onConnect(builds[0].conn, new Identity(1n), "library-guest");
  expect(persistent.getItem("memreplay-library-token:library-test")).toBe("library-guest");
  expect(session.getItem("memreplay-token:library-test")).toBeNull();
  first.dispose();
  tab("library-test");
  vi.stubGlobal("localStorage", persistent); // a new tab of the same browser shares localStorage (tab() resets it)
  const second = new Multiplayer(true);
  nets.push(second);
  second.connect();
  expect(builds[1].token).toBe("library-guest");
  const viewer = multiplayer(undefined);
  viewer.connect();
  expect(builds[2].token).toBeUndefined();
});
