// An in-process SpacetimeDB room for client tests. Reducers are the real module (server/spacetime/src/index.ts) run
// by SpacetimeDB's module test harness. Each fake client keeps its own row cache, which receives every transaction's
// row diff after a configurable latency, in commit order, the way the SDK applies it: all rows first, then the
// onInsert/onUpdate/onDelete callbacks. A caller's reducer promise resolves after its own diff, as in the SDK.
import { ConnectionId, Timestamp } from "spacetimedb";
import { createModuleTestHarness, TestAuth, TestClock } from "spacetimedb/server/test-utils";
import db, * as mod from "../server/spacetime/src/index";
import { Multiplayer } from "../apps/web/src/net/index";

type Row = Record<string, any>;
type Callback = (...args: any[]) => void;
type Op = { table: string; kind: "insert" | "update" | "delete"; row: Row; old?: Row };

/** Primary key and cached index columns of every table a client reads. */
const TABLES: Record<string, { key: string; indexes: string[] }> = {
  memory: { key: "id", indexes: ["id", "requestId"] },
  room: { key: "id", indexes: ["id", "joinCode"] },
  party: { key: "roomId", indexes: ["roomId"] },
  profile: { key: "identity", indexes: ["identity"] },
  player: { key: "identity", indexes: ["identity"] },
  timeline: { key: "roomId", indexes: ["roomId"] },
  branch: { key: "id", indexes: ["id"] },
  objectState: { key: "key", indexes: ["key"] },
  branchKeyframes: { key: "key", indexes: ["key"] },
};

export const canon = (value: unknown) => JSON.stringify(value, (_key, x) => (typeof x === "bigint" ? `${x}n` : x));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CacheTable {
  readonly rows = new Map<string, Row>();
  readonly listeners = { insert: new Set<Callback>(), update: new Set<Callback>(), delete: new Set<Callback>() };
  [index: string]: unknown;

  constructor(
    readonly name: string,
    private readonly primaryKey: string,
    indexes: string[],
    private readonly reversed: boolean,
  ) {
    for (const column of indexes) {
      this[column] = {
        find: (value: unknown) => {
          const wanted = canon(value);
          for (const row of this.rows.values()) if (canon(row[column]) === wanted) return row;
          return null;
        },
      };
    }
  }
  /** Reversed clients iterate newest rows first, to prove the adapter does not depend on cache order. */
  iter(): IterableIterator<Row> {
    const rows = [...this.rows.values()];
    return (this.reversed ? rows.reverse() : rows)[Symbol.iterator]();
  }
  count(): number {
    return this.rows.size;
  }
  onInsert = (cb: Callback) => {
    this.listeners.insert.add(cb);
  };
  onUpdate = (cb: Callback) => {
    this.listeners.update.add(cb);
  };
  onDelete = (cb: Callback) => {
    this.listeners.delete.add(cb);
  };
  removeOnInsert = (cb: Callback) => {
    this.listeners.insert.delete(cb);
  };
  removeOnUpdate = (cb: Callback) => {
    this.listeners.update.delete(cb);
  };
  removeOnDelete = (cb: Callback) => {
    this.listeners.delete.delete(cb);
  };
  get listenerCount(): number {
    return this.listeners.insert.size + this.listeners.update.size + this.listeners.delete.size;
  }
  put(row: Row): void {
    this.rows.set(canon(row[this.primaryKey]), row);
  }
  remove(row: Row): void {
    this.rows.delete(canon(row[this.primaryKey]));
  }
}

export interface CallRecord {
  client: string;
  reducer: string;
  args: Row;
  phase: "start" | "done";
  error?: string;
}

export class FakeClient {
  readonly net = new Multiplayer();
  readonly tables: Record<string, CacheTable> = {};
  /** Delay before each transaction reaches this client (ms). */
  latency = 0;
  private inbox: Promise<void> = Promise.resolve();
  connected = true;

  constructor(
    readonly room: RoomServer,
    readonly name: string,
    readonly auth: TestAuth,
    reversed = false,
  ) {
    for (const [table, { key, indexes }] of Object.entries(TABLES))
      this.tables[table] = new CacheTable(table, key, indexes, reversed);
    const reducers = new Proxy(
      {},
      { get: (_target, reducer: string) => (args?: Row) => room.call(this, reducer, args ?? {}) },
    );
    this.net.connection = { db: this.tables, reducers, disconnect() {} } as never;
    this.net.identity = room.identity(auth) as never;
    this.net.ready = true;
    for (const [table, rows] of room.snapshot()) for (const row of rows.values()) this.tables[table].put(row);
  }

  get reducers(): Record<string, (args?: Row) => Promise<void>> {
    return (this.net.connection as never as { reducers: never }).reducers;
  }

  receive(ops: Op[]): Promise<void> {
    this.inbox = this.inbox
      .then(() => sleep(this.latency))
      .then(() => {
        if (this.connected) this.apply(ops);
      });
    return this.inbox;
  }

  private apply(ops: Op[]): void {
    for (const op of ops) {
      if (op.kind === "delete") this.tables[op.table].remove(op.row);
      else this.tables[op.table].put(op.row);
    }
    for (const op of ops) {
      const listeners = [...this.tables[op.table].listeners[op.kind]];
      for (const cb of listeners) op.kind === "update" ? cb({}, op.old, op.row) : cb({}, op.row);
    }
  }
}

export class RoomServer {
  readonly h = createModuleTestHarness(db, mod, { clock: new TestClock(new Timestamp(BigInt(Date.now()) * 1000n)) });
  readonly clients: FakeClient[] = [];
  readonly log: CallRecord[] = [];
  private nextConnection = 1n;

  auth(name: string): TestAuth {
    return TestAuth.fromJwtPayload(
      JSON.stringify({ sub: name, iss: "https://tests.example", aud: "spacetimedb" }),
      new ConnectionId(this.nextConnection++),
    );
  }
  identity(auth: TestAuth) {
    return this.h.withReducerTx(auth, (ctx) => ctx.sender);
  }

  client(name: string, options: { latency?: number; reversed?: boolean } = {}): FakeClient {
    const client = new FakeClient(this, name, this.auth(name), options.reversed);
    client.latency = options.latency ?? 0;
    this.clients.push(client);
    return client;
  }

  snapshot(): Map<string, Map<string, Row>> {
    const tables = new Map<string, Map<string, Row>>();
    for (const [table, { key }] of Object.entries(TABLES)) {
      const rows = new Map<string, Row>();
      for (const row of (this.h.db as never as Record<string, { iter(): Iterable<Row> }>)[table].iter())
        rows.set(canon(row[key]), { ...row });
      tables.set(table, rows);
    }
    return tables;
  }

  /** Run any code in one server transaction at the current wall clock and broadcast its rows. */
  mutate(auth: TestAuth, body: (ctx: any) => void, except?: FakeClient): Op[] {
    this.h.clock.set(new Timestamp(BigInt(Date.now()) * 1000n));
    const before = this.snapshot();
    this.h.withReducerTx(auth, body as never);
    const after = this.snapshot(),
      ops: Op[] = [];
    for (const [table, rows] of after) {
      const old = before.get(table)!;
      for (const [key, row] of rows) {
        const previous = old.get(key);
        if (!previous) ops.push({ table, kind: "insert", row });
        else if (canon(previous) !== canon(row)) ops.push({ table, kind: "update", row, old: previous });
      }
      for (const [key, row] of old) if (!rows.has(key)) ops.push({ table, kind: "delete", row });
    }
    if (ops.length) for (const client of this.clients) if (client !== except) void client.receive(ops);
    return ops;
  }

  call(client: FakeClient, reducer: string, args: Row): Promise<void> {
    this.log.push({ client: client.name, reducer, args, phase: "start" });
    let error: unknown;
    let ops: Op[] = [];
    try {
      ops = this.mutate(
        client.auth,
        (ctx) => (mod as never as Record<string, (ctx: unknown, args: Row) => void>)[reducer](ctx, args),
        client,
      );
    } catch (e) {
      error = e;
    }
    return client.receive(ops).then(() => {
      this.log.push({
        client: client.name,
        reducer,
        args,
        phase: "done",
        error: error ? String((error as Error).message ?? error) : undefined,
      });
      if (error) throw new Error((error as Error).message ?? String(error));
    });
  }

  /** Reducer calls that finished, for one client, in order. */
  calls(client: FakeClient, phase: "start" | "done" = "done"): CallRecord[] {
    return this.log.filter((c) => c.client === client.name && c.phase === phase);
  }
}
