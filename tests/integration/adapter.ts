// Live check of apps/web/src/net/adapter.ts: Viewer + NetAdapter pairs over real WebSocket connections to a local
// SpacetimeDB running this repo's module. Player A pauses, grabs, moves and throws the ball; B sees it live, both end
// with the same take and identical tracks; B re-grabs it into a new take; a late third player rebuilds everything.
//
// Run (no npm script needed; any free port and database name):
//   spacetime start --listen-addr 127.0.0.1:3065                                      # terminal 1
//   spacetime publish -s http://127.0.0.1:3065 --module-path server/spacetime --anonymous --yes memreplay-adapter
//   STDB_WS_URL=ws://127.0.0.1:3065 STDB_DATABASE=memreplay-adapter npx tsx tests/integration/adapter.ts
// (`node --import tsx tests/integration/adapter.ts` works too.) Defaults: ws://127.0.0.1:${STDB_PORT:-3055}, database memory-replay.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Group, Quaternion, Vector3 } from "three";
import type { Keyframe } from "@memreplay/shared";
import { DbConnection } from "../../apps/web/src/module_bindings";
import { NetAdapter } from "../../apps/web/src/net/adapter";
import { Multiplayer } from "../../apps/web/src/net/index";
import { initPhysics } from "../../apps/web/src/physics";
import { Viewer } from "../../apps/web/src/viewer";

const database = process.env.STDB_DATABASE || "memory-replay";
const uri = process.env.STDB_WS_URL || `ws://127.0.0.1:${process.env.STDB_PORT || 3055}`;
const manifest = JSON.parse(readFileSync(new URL("../../apps/web/public/mock/memory.json", import.meta.url), "utf8"));
const original: Keyframe[] = manifest.objects[0].track;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => unknown, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}
const step = (name: string) => console.log(`- ${name}`);

interface Player {
  name: string;
  net: Multiplayer;
  conn: DbConnection;
  viewer: Viewer;
  adapter?: NetAdapter;
  reports: string[];
  moves: number;
  calls: string[];
}
const players: Player[] = [];

/** A Multiplayer wired to a real connection. Multiplayer.connect() needs a browser (import.meta.env, location). */
function connect(name: string): Promise<Player> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${name}: connection timed out`)), 10_000);
    const net = new Multiplayer();
    const player = { moves: 0, calls: [] } as unknown as Player;
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .withCompression("none")
      .onConnect((conn, identity, token) => {
        // Count every reducer call made through this player's Multiplayer (the adapter's included).
        const reducers = new Proxy(conn.reducers, {
          get: (target, key) => {
            const value = Reflect.get(target, key, target);
            return typeof value === "function"
              ? (...args: unknown[]) => {
                  player.calls.push(String(key));
                  return value.apply(target, args);
                }
              : value;
          },
        });
        net.connection = new Proxy(conn, {
          get: (target, key) => (key === "reducers" ? reducers : Reflect.get(target, key, target)),
        });
        net.identity = identity;
        net.token = token;
        // Multiplayer's own clock calibration, as connect() wires it.
        const calibrate = (row: Parameters<Multiplayer["report"]>[0]) =>
          (net as never as { calibrate(row: unknown): void }).calibrate(row);
        conn.db.clockSample.onInsert((_ctx, row) => calibrate(row));
        conn.db.clockSample.onUpdate((_ctx, _old, row) => calibrate(row));
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timeout);
            net.ready = true;
            void net.run(() => conn.reducers.sampleClock({ clientSentUs: BigInt(Date.now()) * 1000n }));
            const reports: string[] = [];
            const viewer = makeViewer((message) => reports.push(`viewer: ${message}`));
            Object.assign(player, { name, net, conn, viewer, reports });
            const move = net.move.bind(net);
            net.move = (...args) => {
              player.moves++;
              return move(...args);
            };
            players.push(player);
            resolve(player);
          })
          .onError((ctx) => reject(ctx.event))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timeout);
        reject(error);
      })
      .build();
  });
}

function makeViewer(report: (message: string) => void): Viewer {
  const objects = manifest.objects.map((definition: any) => ({
    definition: structuredClone(definition),
    root: new Group(),
    track: structuredClone(definition.track),
  }));
  const root = new Group();
  for (const object of objects) root.add(object.root);
  return new Viewer(
    {
      manifest: structuredClone(manifest),
      root,
      objects,
      cameraTrack: manifest.camera.track,
      roomGeometry: [],
      warnings: [],
      dispose() {},
    } as never,
    report,
  );
}

/** As session.ts does once the player is in a room and net.ready. */
function attach(player: Player): void {
  player.adapter = new NetAdapter(player.net, player.viewer, (message) => player.reports.push(message));
  player.viewer.setAuthority(player.adapter);
  player.adapter.start();
}

const take = (player: Player, branchId: bigint | string, objectId = "ball-1") =>
  player.viewer.timeline.branches.find((b) => b.id === String(branchId))?.tracks.get(objectId);
const ball = (player: Player) => player.viewer.memory.objects.find((o) => o.definition.id === "ball-1")!.root.position;
const near = (a: Vector3, b: Vector3, tolerance = 1e-3) => a.distanceTo(b) < tolerance;
const row = (player: Player, branchId: bigint) => player.conn.db.objectState.key.find(`${branchId}:ball-1`);

/** Pick up, wave and throw the ball, as a hand would at 60 Hz. */
async function throwBall(player: Player, from: Vector3, velocity: Vector3): Promise<void> {
  const position = from.clone(),
    dt = 1 / 60;
  for (let i = 0; i < 20; i++) {
    position.addScaledVector(velocity, dt);
    player.viewer.moveHeld(position.clone(), new Quaternion(), dt);
    await sleep(1000 * dt);
  }
  player.viewer.release();
}

let frameLoop: ReturnType<typeof setInterval> | undefined;
const watchdog = setTimeout(() => {
  console.error("FAIL: timed out after 90 s");
  process.exit(1);
}, 90_000);
try {
  await initPhysics();
  const a = await connect("Alice"),
    b = await connect("Bob");
  let last = performance.now();
  frameLoop = setInterval(() => {
    const now = performance.now(),
      dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const player of players) player.viewer.update(dt);
  }, 16);

  step("room");
  const requestId = crypto.randomUUID();
  await a.conn.reducers.createMemory({
    requestId,
    title: "Adapter test",
    sourceUrl: "",
    manifestUrl: "https://localhost:5173/mock/memory.json",
    pipelineIdentity: a.net.identity!,
    durationUs: BigInt(manifest.timeline.durationSec * 1e6),
  });
  const memory = [...a.conn.db.memory.iter()].find((m) => m.requestId === requestId)!;
  await a.conn.reducers.createRoom({ memoryId: memory.id, name: "Alice", device: "desktop" });
  const room = a.net.room!;
  await b.conn.reducers.joinRoom({ joinCode: room.joinCode, name: "Bob", device: "phone" });
  await until(() => b.net.room?.id === room.id, "Bob in the room");
  attach(a);
  attach(b);
  assert.equal(b.viewer.timeline.playing, true, "a new room plays");

  step("A pauses and seeks; B follows; nothing echoes back");
  const bobCalls = b.calls.length,
    aliceCalls = a.calls.length;
  a.viewer.togglePlay();
  await until(() => a.net.timeline!.paused && !b.viewer.timeline.playing, "the shared pause");
  a.viewer.seek(1.2);
  await until(() => Math.abs(b.viewer.timeline.time - 1.2) < 1e-6, "the shared seek");
  assert.equal(a.net.timeline!.anchorMediaUs, 1_200_000n);
  // The pause also pins the room's time with a seek, but only when the two clocks differ by 1 ms or more.
  const aliceSent = a.calls
    .slice(aliceCalls)
    .filter((name) => name !== "sampleClock")
    .join(",");
  assert.ok(["setPaused,seek", "setPaused,seek,seek"].includes(aliceSent), `Alice sent ${aliceSent}`);
  await sleep(1200); // past the adapter's 1 s drift check
  assert.deepEqual(b.calls.slice(bobCalls), [], "Bob sent nothing back");

  step("A grabs the ball: the server forks the Original and both switch to the take");
  assert.equal(await a.viewer.grab("ball-1"), true, a.reports.join("\n"));
  const x = a.net.timeline!.branchId;
  assert.notEqual(x, 0n);
  assert.equal(a.viewer.held?.definition.id, "ball-1");
  assert.equal(a.viewer.timeline.activeId, String(x));
  await until(() => b.viewer.timeline.activeId === String(x), "Bob on the new take");
  assert.deepEqual(
    b.viewer.timeline.branches.find((br) => br.id === String(x)),
    { id: String(x), parentId: "original", name: "First edit", forkTime: 1.2, tracks: new Map() },
  );

  step("A moves it; B sees the held pose");
  const held = new Vector3(0.2, 1.3, -1.2);
  a.viewer.moveHeld(held.clone(), new Quaternion(), 1 / 60);
  await until(
    () => row(b, x)?.mode === "held" && near(new Vector3(row(b, x)!.px, row(b, x)!.py, row(b, x)!.pz), held, 1e-5),
    "the held pose row",
  );
  await until(() => near(ball(b), held), "the held pose on Bob's screen");

  step("A throws; B follows the flight; the throw is saved in chunks, then released");
  const movesBefore = a.moves,
    flightStart = performance.now();
  let sawPhysics = false;
  const bobSaw: Vector3[] = [];
  await throwBall(a, held, new Vector3(1.5, 2, 0.4));
  await until(() => {
    if (row(b, x)?.mode === "physics") {
      sawPhysics = true;
      bobSaw.push(ball(b).clone());
    }
    return row(b, x)?.mode === "rest";
  }, "the throw to come to rest");
  const flightSeconds = (performance.now() - flightStart) / 1000;
  assert.ok(sawPhysics, "Bob saw the object in flight");
  assert.ok(
    new Set(
      bobSaw.map((p) =>
        p
          .toArray()
          .map((v) => v.toFixed(3))
          .join(),
      ),
    ).size > 3,
    "Bob's view moved during the flight",
  );
  const rate = (a.moves - movesBefore) / flightSeconds;
  assert.ok(rate <= 16, `moveObject at ${rate.toFixed(1)} Hz`);
  const chunksX = [...b.conn.db.branchKeyframes.iter()].filter((c) => c.branchId === x);
  assert.ok(chunksX.length >= 1);
  for (const chunk of chunksX) assert.ok(JSON.parse(chunk.keyframesJson).length <= 120);
  await until(() => JSON.stringify(take(a, x)) === JSON.stringify(take(b, x)), "identical tracks for the take");
  const trackX = take(b, x)!;
  assert.equal(trackX[0].t, 1.2, "the take starts at the grab");
  assert.equal(
    trackX.length,
    chunksX.reduce((n, c) => n + JSON.parse(c.keyframesJson).length, 0),
  );
  for (const t of [1.2, 1.5, 2, 3, 4])
    assert.deepEqual(a.viewer.timeline.track("ball-1", original, t), b.viewer.timeline.track("ball-1", original, t));
  console.log(
    `  ${trackX.length} keyframes in ${chunksX.length} chunk(s), ${a.moves - movesBefore} moves in ${flightSeconds.toFixed(1)} s`,
  );

  step("B re-grabs it: a new take from A's; A cannot take it while B holds it");
  assert.equal(await b.viewer.grab("ball-1"), true, b.reports.join("\n"));
  const y = b.net.timeline!.branchId;
  assert.notEqual(y, x);
  assert.equal(b.viewer.timeline.activeId, String(y));
  await until(() => a.viewer.timeline.activeId === String(y), "Alice on Bob's take");
  assert.deepEqual(b.conn.db.branch.id.find(y), { ...b.conn.db.branch.id.find(y)!, parentId: x, name: "Edit ball-1" });
  assert.equal(await a.viewer.grab("ball-1"), false);
  await until(() => a.reports.some((m) => m.includes("owned by another player")), "Alice told why");
  await throwBall(b, ball(b).clone(), new Vector3(-1, 1.5, 0));
  await until(() => row(a, y)?.mode === "rest", "Bob's throw to come to rest");
  await until(() => JSON.stringify(take(a, y)) === JSON.stringify(take(b, y)), "identical tracks for Bob's take");

  step("a late third player rebuilds every take");
  const c = await connect("Carol");
  await c.conn.reducers.joinRoom({ joinCode: room.joinCode, name: "Carol", device: "quest" });
  await until(() => c.net.room?.id === room.id, "Carol in the room");
  attach(c);
  assert.deepEqual(
    c.viewer.timeline.branches.map((br) => [br.id, br.parentId, br.name]),
    [
      ["original", null, "Original"],
      [String(x), "original", "First edit"],
      [String(y), String(x), "Edit ball-1"],
    ],
  );
  for (const id of [x, y]) assert.equal(JSON.stringify(take(c, id)), JSON.stringify(take(a, id)), `take ${id}`);
  assert.equal(c.viewer.timeline.activeId, String(y));
  assert.equal(c.viewer.timeline.time, a.viewer.timeline.time);

  step("the late player presses play; everyone plays the take in step");
  c.viewer.togglePlay();
  await until(() => players.every((p) => p.viewer.timeline.playing), "everyone playing");
  await sleep(1500);
  const times = players.map((p) => p.viewer.timeline.time);
  assert.ok(
    Math.max(...times) - Math.min(...times) < 0.1,
    `clocks agree: ${times.map((t) => t.toFixed(3)).join(", ")}`,
  );
  await until(() => players.every((p) => !p.viewer.timeline.playing), "the end of the clip", 8000);
  for (const p of players)
    assert.deepEqual(
      ball(p)
        .toArray()
        .map((v) => v.toFixed(4)),
      ball(a)
        .toArray()
        .map((v) => v.toFixed(4)),
      `${p.name} ends on the same pose`,
    );

  const errors = players.flatMap((p) =>
    p.reports
      .filter((m) => (!m.startsWith("viewer:") || m.includes("unknown take")) && !m.includes("owned by another player"))
      .map((m) => `${p.name}: ${m}`),
  );
  assert.deepEqual(errors, [], "no adapter errors");
  console.log(`  reducer calls: ${players.map((p) => `${p.name} ${p.calls.length}`).join(", ")}`);
  console.log(
    "PASS: shared pause/seek/play, grab with server fork, held and in-flight remote poses, chunked keyframes, identical takes, re-grab into a new take, ownership rejection, late-join rebuild",
  );
} catch (error) {
  console.error("FAIL:", error);
  for (const p of players) console.error(`${p.name} reports:\n  ${p.reports.join("\n  ")}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (frameLoop) clearInterval(frameLoop);
  for (const p of players) {
    p.adapter?.dispose();
    p.viewer.dispose();
    p.conn.disconnect();
  }
  setTimeout(() => process.exit(), 200);
}
