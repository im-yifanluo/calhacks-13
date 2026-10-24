import { afterEach, describe, expect, test, vi } from "vitest";
import { computeReconnectDelayMs, Identity, resolveReconnectPolicy } from "spacetimedb";
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
    db: Object.fromEntries(
      ["memory", "room", "party", "profile", "player", "timeline", "branch", "objectState", "branchKeyframes", "clockSample"].map((n) => [n, table()]),
    ),
    subscriptionBuilder: () => subscription,
    reducers: { sampleClock: async () => {} },
    disconnect() {},
    applied: () => applied(),
  };
}
/** Replaces DbConnection.builder; every connection Multiplayer builds is recorded. */
function recordBuilds(): Build[] {
  const builds: Build[] = [];
  vi.spyOn(DbConnection, "builder").mockImplementation(() => {
    const build: Build = { on: {}, conn: fakeConnection() };
    const builder: any = new Proxy({}, {
      get: (_target, name: string) => (...args: any[]) => {
        if (name === "withToken") build.token = args[0];
        if (name === "withAutomaticReconnect") build.reconnect = args[0];
        if (name.startsWith("on")) build.on[name] = args[0];
        if (name !== "build") return builder;
        builds.push(build);
        return build.conn;
      },
    });
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
  test("Google credentials survive reconnect without becoming guest tokens; rejection never silently changes identity", () => {
    const credential = `header.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
    const builds = recordBuilds();
    const session = tab("google", { "memreplay-google-credential": credential, "memreplay-token:google": "saved-guest" });
    const net = multiplayer(undefined);
    net.connect();
    expect(builds[0].token).toBe(credential);
    const { on, conn } = builds[0];
    on.onConnect(conn, new Identity(9n), "transport-token");
    conn.applied();
    on.onAutomaticReconnect(conn, new Identity(9n), "new-transport-token");
    expect(session.getItem("memreplay-google-credential")).toBe(credential);
    expect(session.getItem("memreplay-token:google")).toBe("saved-guest");
    net.dispose();
    const next = multiplayer(undefined);
    next.connect();
    const rejected = Object.assign(new Error("Rejected"), { name: "WebSocketTokenError", status: 401 });
    builds[1].on.onConnectError({}, rejected);
    expect(next.status).toContain("Google sign-in rejected");
    expect(builds).toHaveLength(2);
    expect(session.getItem("memreplay-google-credential")).toBe(credential);
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
    expect([net.ready, net.status, net.error]).toEqual([false, "Connection lost — reconnecting in 1 s…", "WebSocket closed (code 1006)"]);
    on.onConnectError({}, new Error("Failed to connect"), 2, 2600);
    expect([net.status, net.failure]).toEqual(["Reconnecting… (attempt 2, next in 3 s)", { kind: "connection", message: "Failed to connect" }]);
    on.onAutomaticReconnect(conn, new Identity(7n), "token-1");
    expect(net.status).toBe("Resynchronizing…");
    conn.applied(); // the SDK replays the subscription after a reconnect
    expect([net.ready, net.status, net.error]).toEqual([true, "Connected", ""]);
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

  test.skipIf(skip)("Multiplayer: a duplicated tab connects as a new guest, whose token a later copy finds taken", async () => {
    const builds = recordBuilds();
    const database = `tabs-${Math.random()}`, key = `memreplay-token:${database}`;
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
  });
});

test("without Web Locks (an insecure origin) the stored token is used as before", async () => {
  const key = "memreplay-token:none";
  const copy = storage({ [key]: "token-a" });
  expect((await claimStoredToken(copy, key, undefined)).token).toBe("token-a");
  expect((await claimStoredToken(copy, key, undefined)).token).toBe("token-a");
  const broken = { request: () => Promise.reject(new DOMException("denied", "SecurityError")) } as unknown as Locks;
  expect((await claimStoredToken(copy, key, broken)).token).toBe("token-a");
});
