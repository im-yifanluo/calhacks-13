// Two-player smoke test for the SpacetimeDB module. Open /smoke.html with the dev server running
// and a local SpacetimeDB that has the module published (npm run stdb:start, npm run stdb:publish:local).
// By default it connects through the dev server's /v1 proxy (same origin), which is how the Quest
// and phones must connect too. Query params: ?stdb=wss://maincloud.spacetimedb.com&db=memory-replay
import { DbConnection } from "./module_bindings";

const qs = new URLSearchParams(location.search);
const URI = qs.get("stdb") ?? location.origin;
const DB = qs.get("db") ?? "memory-replay";

const out = document.getElementById("out")!;
const results: { name: string; ok: boolean; detail?: string }[] = [];
(window as any).__smoke = { results, done: false };

function report(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  out.textContent += `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}\n`;
}

function connect(label: string): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    // No token: every connection gets a fresh anonymous identity, i.e. a different player.
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect((conn) => {
        conn.subscriptionBuilder().onApplied(() => resolve(conn)).subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => reject(new Error(`${label}: ${err}`)))
      .build();
  });
}

async function waitFor(what: string, pred: () => boolean, ms = 3000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    report(name, true);
  } catch (e) {
    report(name, false, String((e as Error)?.message ?? e));
  }
}

const pose = (px: number, py: number, pz: number, vx = 0, vy = 0, vz = 0) =>
  ({ px, py, pz, qx: 0, qy: 0, qz: 0, qw: 1, vx, vy, vz });

async function main() {
  const a = await connect("host");
  const b = await connect("guest");
  const aId = a.identity!;
  const bId = b.identity!;
  report("two clients connected with different identities", !aId.isEqual(bId));

  let roomId = 0n;
  let joinCode = "";
  const memTitle = `smoke ${Math.random().toString(36).slice(2, 7)}`;

  await step("host creates memory + room", async () => {
    await a.reducers.createMemory({ title: memTitle, manifestUrl: "/mock/memory.json" });
    await waitFor("memory row", () => [...a.db.memory.iter()].some((m) => m.title === memTitle));
    const mem = [...a.db.memory.iter()].find((m) => m.title === memTitle)!;
    await a.reducers.createRoom({ memoryId: mem.id, name: "Host", device: "quest" });
    await waitFor("room row", () => [...a.db.room.iter()].some((r) => r.memoryId === mem.id));
    const room = [...a.db.room.iter()].find((r) => r.memoryId === mem.id)!;
    roomId = room.id;
    joinCode = room.joinCode;
  });

  await step(`guest joins with code ${joinCode || "?"}`, async () => {
    await b.reducers.joinRoom({ joinCode: joinCode.toLowerCase(), name: "Guest", device: "phone" });
    await waitFor("both players visible to host", () =>
      [...a.db.player.iter()].filter((p) => p.roomId === roomId && p.online).length === 2);
  });

  await step("host pose reaches guest", async () => {
    await a.reducers.setPose({ hx: 1.5, hy: 1.7, hz: -2, hqx: 0, hqy: 0, hqz: 0, hqw: 1, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0 });
    await waitFor("guest sees host hx=1.5", () =>
      [...b.db.player.iter()].some((p) => p.identity.isEqual(aId) && Math.abs(p.hx - 1.5) < 1e-4));
  });

  await step("pause is shared", async () => {
    await a.reducers.setPaused({ paused: true });
    await waitFor("guest sees paused", () => b.db.timeline.roomId.find(roomId)?.paused === true);
  });

  let branchId = 0n;
  await step("fork creates branch and switches room to it", async () => {
    await a.reducers.forkBranch({ name: "ball goes left" });
    await waitFor("guest timeline on new branch", () => (b.db.timeline.roomId.find(roomId)?.branchId ?? 0n) !== 0n);
    branchId = b.db.timeline.roomId.find(roomId)!.branchId;
  });

  const ball = () => [...b.db.objectState.iter()].find((o) => o.branchId === branchId && o.objectId === "ball-1");

  await step("host grabs ball, guest sees owner", async () => {
    await a.reducers.grab({ objectId: "ball-1", ...pose(-1, 0.5, 0) });
    await waitFor("heldBy = host", () => !!ball()?.heldBy && ball()!.heldBy!.isEqual(aId));
  });

  await step("guest cannot grab a held ball", async () => {
    let rejected = false;
    try { await b.reducers.grab({ objectId: "ball-1", ...pose(0, 0, 0) }); } catch { rejected = true; }
    if (!rejected) throw new Error("second grab was accepted");
  });

  await step("owner streams transform to guest", async () => {
    await a.reducers.moveObject({ objectId: "ball-1", ...pose(-1.2, 0.9, 0.1, -2, 3, 0) });
    await waitFor("guest sees px=-1.2", () => Math.abs((ball()?.px ?? 0) + 1.2) < 1e-4);
  });

  await step("non-owner cannot move ball", async () => {
    let rejected = false;
    try { await b.reducers.moveObject({ objectId: "ball-1", ...pose(5, 5, 5) }); } catch { rejected = true; }
    if (!rejected) throw new Error("non-owner move was accepted");
  });

  await step("release frees the ball, guest can grab it", async () => {
    await a.reducers.release({ objectId: "ball-1", rest: true, ...pose(-1.3, 0.12, 0.1) });
    await waitFor("ball at rest, unheld", () => ball()?.mode === "rest" && !ball()?.heldBy);
    await b.reducers.grab({ objectId: "ball-1", ...pose(-1.3, 0.12, 0.1) });
    await waitFor("heldBy = guest", () => !!ball()?.heldBy && ball()!.heldBy!.isEqual(bId));
  });

  await step("throw keeps ownership until the ball comes to rest", async () => {
    await b.reducers.release({ objectId: "ball-1", rest: false, ...pose(-1.3, 0.5, 0.1, 2, 3, 0) });
    await waitFor("thrown, still owned by guest", () => ball()?.mode === "thrown" && !!ball()?.heldBy?.isEqual(bId));
    await b.reducers.moveObject({ objectId: "ball-1", ...pose(-0.8, 1.1, 0.1, 2, 1, 0) });
    await b.reducers.release({ objectId: "ball-1", rest: true, ...pose(0.2, 0.12, 0.1) });
    await waitFor("at rest, unheld", () => ball()?.mode === "rest" && !ball()?.heldBy);
  });

  await step("anyone can catch a thrown ball", async () => {
    await a.reducers.grab({ objectId: "ball-1", ...pose(0.2, 0.12, 0.1) });
    await a.reducers.release({ objectId: "ball-1", rest: false, ...pose(0.2, 0.5, 0.1, 1, 2, 0) });
    await waitFor("thrown by host", () => ball()?.mode === "thrown");
    await b.reducers.grab({ objectId: "ball-1", ...pose(0.5, 0.9, 0.1) });
    await waitFor("guest caught it", () => ball()?.mode === "held" && !!ball()?.heldBy?.isEqual(bId));
  });

  let otherBranch = 0n;
  let otherRoomId = 0n;
  await step("switching rooms drops what you hold", async () => {
    const title2 = memTitle + " #2";
    await b.reducers.createMemory({ title: title2, manifestUrl: "/mock/memory.json" });
    await waitFor("memory 2", () => [...b.db.memory.iter()].some((m) => m.title === title2));
    const mem2 = [...b.db.memory.iter()].find((m) => m.title === title2)!;
    await b.reducers.createRoom({ memoryId: mem2.id, name: "Guest", device: "phone" });
    await waitFor("room 2", () => [...b.db.room.iter()].some((r) => r.memoryId === mem2.id));
    otherRoomId = [...b.db.room.iter()].find((r) => r.memoryId === mem2.id)!.id;
    await waitFor("ball no longer held", () => !ball()?.heldBy);
  });

  await step("grabbing on the original recording forks a branch first", async () => {
    await b.reducers.grab({ objectId: "cup-1", ...pose(0, 1, 0) });
    await waitFor("room 2 on a new branch", () => (b.db.timeline.roomId.find(otherRoomId)?.branchId ?? 0n) !== 0n);
    otherBranch = b.db.timeline.roomId.find(otherRoomId)!.branchId;
    const onOriginal = [...b.db.objectState.iter()].some((o) => o.branchId === 0n);
    if (onOriginal) throw new Error("an override was written to branch 0");
  });

  await step("can't switch to another memory's branch", async () => {
    let rejected = false;
    try { await a.reducers.setBranch({ branchId: otherBranch }); } catch { rejected = true; }
    if (!rejected) throw new Error("cross-memory setBranch was accepted");
  });

  await step("a nested fork keeps earlier what-ifs", async () => {
    await a.reducers.forkBranch({ name: "nested" });
    await waitFor("host room on nested branch", () => {
      const id = a.db.timeline.roomId.find(roomId)?.branchId ?? 0n;
      return id !== branchId && id !== 0n;
    });
    const nested = a.db.timeline.roomId.find(roomId)!.branchId;
    await waitFor("ball override copied", () =>
      [...a.db.objectState.iter()].some((o) => o.branchId === nested && o.objectId === "ball-1"));
  });

  await step("guest disconnect marks offline and drops what they hold", async () => {
    b.disconnect();
    const cup = () => [...a.db.objectState.iter()].find((o) => o.branchId === otherBranch && o.objectId === "cup-1");
    await waitFor("guest offline", () => [...a.db.player.iter()].some((p) => p.identity.isEqual(bId) && !p.online));
    await waitFor("cup released", () => !!cup() && !cup()!.heldBy);
  });

  a.disconnect();
  const failed = results.filter((r) => !r.ok).length;
  out.textContent += `\n${results.length - failed}/${results.length} passed\n`;
  (window as any).__smoke.done = true;
}

main().catch((e) => {
  report("smoke test crashed", false, String(e?.message ?? e));
  (window as any).__smoke.done = true;
});
