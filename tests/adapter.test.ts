import { readFileSync } from "node:fs";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { Group, Quaternion, Vector3 } from "three";
import type { Keyframe } from "@memreplay/shared";
import * as mod from "../server/spacetime/src/index";
import { importBranches, NetAdapter, parseChunk, recordingChunks, type ReportOptions, serverBranchId, viewerBranchId } from "../apps/web/src/net/adapter";
import { initPhysics, STEP } from "../apps/web/src/physics";
import { Viewer } from "../apps/web/src/viewer";
import { Notice } from "../apps/web/src/session";
import { type FakeClient, RoomServer } from "./room-harness";

const manifest = JSON.parse(readFileSync(new URL("../apps/web/public/mock/memory.json", import.meta.url), "utf8"));
const pose = (px = 0, py = 1, pz = 0) => ({ px, py, pz, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0 });
const frame = (t: number, x = 0, y = 1, z = 0): Keyframe => ({ t, p: [x, y, z], q: [0, 0, 0, 1] });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => unknown, what = "condition", ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Player {
  client: FakeClient; viewer: Viewer; adapter: NetAdapter; reports: string[];
  /** Every adapter message with its kind, and every kind it said succeeded. */
  notices: Array<{ message: string } & Partial<ReportOptions>>; resolved: string[];
}
const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dispose of cleanup.splice(0)) dispose(); });
beforeAll(() => initPhysics());

function makeViewer(reports: string[]): Viewer {
  const objects = manifest.objects.map((definition: any) => ({ definition: structuredClone(definition), root: new Group(), track: structuredClone(definition.track) }));
  const root = new Group();
  for (const object of objects) root.add(object.root);
  const memory = { manifest: structuredClone(manifest), root, objects, cameraTrack: manifest.camera.track, roomGeometry: [], warnings: [], dispose() {} };
  const viewer = new Viewer(memory as never, message => reports.push(`viewer: ${message}`));
  cleanup.push(() => viewer.dispose());
  return viewer;
}

/** A player with a viewer and an adapter, as session.ts wires them (optionally into a status line). */
function attach(client: FakeClient, status?: Notice): Player {
  const reports: string[] = [], notices: Player["notices"] = [], resolved: string[] = [];
  const viewer = makeViewer(reports);
  const adapter = new NetAdapter(client.net, viewer,
    (message, options) => { reports.push(message); notices.push({ message, ...options }); status?.show(message, options); },
    kind => { resolved.push(kind); status?.resolve(kind); });
  viewer.setAuthority(adapter);
  adapter.start();
  cleanup.push(() => adapter.dispose());
  return { client, viewer, adapter, reports, notices, resolved };
}

/** A room for a 6 s memory, created by `host`, paused at 0 unless told otherwise. */
async function openRoom(room: RoomServer, host: FakeClient, paused = true): Promise<{ code: string; roomId: bigint }> {
  const requestId = `memory-${host.name}-${Math.random()}`;
  await host.reducers.createMemory({ requestId, title: "Test", sourceUrl: "", manifestUrl: "https://assets.example/memory.json",
    pipelineIdentity: host.net.identity, durationUs: 6_000_000n });
  const memory = host.tables.memory.requestId as { find(v: string): any };
  await host.reducers.createRoom({ memoryId: memory.find(requestId).id, name: host.name, device: "desktop" });
  if (paused) await host.reducers.setPaused({ paused: true });
  if (paused) await host.reducers.seek({ mediaUs: 0n });
  const roomId = host.net.room!.id;
  return { code: host.net.room!.joinCode, roomId };
}
async function joined(room: RoomServer, name: string, code: string, latency = 0): Promise<FakeClient> {
  const client = room.client(name, { latency });
  await client.reducers.joinRoom({ joinCode: code, name, device: "quest" });
  return client;
}
const serverTimeline = (room: RoomServer, roomId: bigint) => room.h.db.timeline.roomId.find(roomId)!;
const serverRow = (room: RoomServer, branchId: bigint, objectId: string) => room.h.db.objectState.key.find(`${branchId}:${objectId}`);
const trackOf = (player: Player, branchId: bigint | string, objectId = "ball-1") =>
  player.viewer.timeline.branches.find(b => b.id === String(branchId))?.tracks.get(objectId);
const original = manifest.objects[0].track as Keyframe[];
async function settle(...players: Player[]): Promise<void> {
  for (let i = 0; i < 2000 && players.some(p => p.viewer.recording); i++) for (const p of players) p.viewer.update(STEP);
  expect(players.some(p => p.viewer.recording)).toBe(false);
}

test("branch ids, units and parent-first branch import", () => {
  expect(viewerBranchId(0n)).toBe("original");
  expect(viewerBranchId(12n)).toBe("12");
  expect(serverBranchId("original")).toBe(0n);
  expect(serverBranchId("12")).toBe(12n);
  for (const local of ["local-3", "", "007", "1.5", "-2", "12a"]) expect(serverBranchId(local)).toBeUndefined();
  const rows = [
    { id: 9n, roomId: 1n, memoryId: 1n, parentId: 4n, forkMediaUs: 2_500_000n, name: "Edit ball-1", creator: undefined },
    { id: 4n, roomId: 1n, memoryId: 1n, parentId: 0n, forkMediaUs: 1_250_000n, name: "First edit", creator: undefined },
    { id: 11n, roomId: 1n, memoryId: 1n, parentId: 9n, forkMediaUs: 9_000_000n, name: "Late", creator: undefined },
  ] as never[];
  expect(importBranches(rows, 6)).toEqual([
    { id: "4", parentId: "original", name: "First edit", forkTime: 1.25 },
    { id: "9", parentId: "4", name: "Edit ball-1", forkTime: 2.5 },
    { id: "11", parentId: "9", name: "Late", forkTime: 6 }, // clamped to the viewer's clip
  ]);
});

test("a throw's recording is filtered to the grab, downsampled to 30 Hz and split into disjoint 120-frame chunks", () => {
  const prefix = [frame(0.5, -1), frame(0.9, -1)]; // the branch's earlier frames, which the viewer includes
  const throwFrames = Array.from({ length: 301 }, (_, i) => frame(1 + i / 60, i / 100)); // 1 s → 6 s at 60 Hz
  const chunks = recordingChunks([...prefix, ...throwFrames], 1_000_000n, 5_500_000n);
  const all = chunks.flat();
  expect(all[0].t).toBe(1);
  expect(all.at(-1)!.t).toBeCloseTo(5.5, 9); // the last frame inside the memory is kept
  expect(all.length).toBe(136); // 1 s → 5.5 s at 30 Hz, plus nothing extra: 5.5 is on the 30 Hz grid
  for (let i = 1; i < all.length; i++) expect(all[i].t - all[i - 1].t).toBeGreaterThan(1 / 30 - 1e-6);
  expect(chunks.map(c => c.length)).toEqual([120, 16]);
  expect(chunks[0].at(-1)!.t).toBeLessThan(chunks[1][0].t);
  // The last frame survives downsampling even off the grid.
  const odd = recordingChunks(throwFrames.slice(0, 4), 1_000_000n, 6_000_000n).flat();
  expect(odd.map(f => f.t)).toEqual([1, 1 + 2 / 60, 1 + 3 / 60]);
  expect(recordingChunks(prefix, 1_000_000n, 6_000_000n)).toEqual([]);
  // Only the keyframe fields go to the server.
  expect(Object.keys(recordingChunks([{ ...frame(1), s: 1, v: [1, 2, 3], junk: 1 } as never], 0n, 6_000_000n)[0][0]).sort()).toEqual(["p", "q", "s", "t"]);
});

test("server chunks parse once into validated keyframes", () => {
  expect(parseChunk(JSON.stringify([frame(1), { ...frame(2), s: 2, extra: true }]))).toEqual([frame(1), { ...frame(2), s: 2 }]);
  for (const bad of ["{", "{}", "[]", JSON.stringify([frame(2), frame(1)]), JSON.stringify([null]), JSON.stringify([{ t: 1, p: [0, 0], q: [0, 0, 0, 1] }])]) {
    expect(parseChunk(bad)).toBeUndefined();
  }
});

test("a late joiner rebuilds every take from the cache: branches parents-first, recordings, clock, remote holds", async () => {
  const room = new RoomServer();
  const alice = room.client("alice");
  const { code, roomId } = await openRoom(room, alice);
  const r = alice.reducers;
  await r.seek({ mediaUs: 1_000_000n });
  await r.grab({ objectId: "ball-1", ...pose(-0.5, 0.6, -1.5) }); // forks X ("First edit") at 1 s
  const x = serverTimeline(room, roomId).branchId;
  await r.saveBranchKeyframes({ branchId: x, objectId: "ball-1", startMediaUs: 1_000_000n, keyframesJson: JSON.stringify([frame(1, 0), frame(1.5, 0.5), frame(2, 1)]) });
  await r.release({ objectId: "ball-1", rest: true, ...pose(1, 0.2, 0) });
  await r.seek({ mediaUs: 1_500_000n });
  await r.grab({ objectId: "ball-1", ...pose() }); // re-editing a resting object forks Y ("Edit ball-1") from X
  const y = serverTimeline(room, roomId).branchId;
  await r.saveBranchKeyframes({ branchId: y, objectId: "ball-1", startMediaUs: 1_500_000n, keyframesJson: JSON.stringify([frame(1.5, 3), frame(2.5, 4)]) });
  await r.release({ objectId: "ball-1", rest: true, ...pose(4, 0.2, 0) });
  await r.forkBranch({ name: "Z" }); // Z from Y, and the room moves to Z
  const z = serverTimeline(room, roomId).branchId;
  await r.setBranch({ branchId: y }); // back on Y, paused at its fork time
  await r.grab({ objectId: "can-1", ...pose(0.7, 0.2, -0.7) }); // no row for the can on Y: edited in place, no fork
  await r.moveObject({ objectId: "can-1", ...pose(0.2, 0.9, -0.5) });
  expect(serverTimeline(room, roomId).branchId).toBe(y);

  const late = room.client("carol", { reversed: true }); // newest rows first: children before their parents
  await late.reducers.joinRoom({ joinCode: code, name: "Carol", device: "phone" });
  const carol = attach(late);
  expect(carol.reports).toEqual([]);
  expect(carol.viewer.timeline.branches.map(b => [b.id, b.parentId, b.forkTime])).toEqual([
    ["original", null, 0], [String(x), "original", 1], [String(y), String(x), 1.5], [String(z), String(y), 1.5]]);
  expect(trackOf(carol, x)!.map(f => f.t)).toEqual([1, 1.5, 2]);
  expect(trackOf(carol, y)!.map(f => f.p[0])).toEqual([3, 4]);
  expect(carol.viewer.timeline.activeId).toBe(String(y));
  expect(carol.viewer.timeline.time).toBeCloseTo(1.5, 9);
  expect(carol.viewer.timeline.playing).toBe(false);
  await sleep(80); carol.viewer.update(0.1); // remote poses interpolate over 1/15 s of wall time
  const can = carol.viewer.memory.objects.find(o => o.definition.id === "can-1")!.root.position;
  expect([can.x, can.y, can.z].map(v => +v.toFixed(5))).toEqual([0.2, 0.9, -0.5]);
  expect(room.calls(late).map(c => c.reducer)).toEqual(["joinRoom"]); // starting sends nothing
});

test("chunk inserts, updates and deletes rebuild the take's track from all its chunks", async () => {
  const room = new RoomServer();
  const alice = room.client("alice");
  const { roomId } = await openRoom(room, alice);
  await alice.reducers.seek({ mediaUs: 1_000_000n });
  await alice.reducers.grab({ objectId: "ball-1", ...pose() });
  const x = serverTimeline(room, roomId).branchId;
  const bob = attach(await joined(room, "bob", alice.net.room!.joinCode));
  const save = (startUs: bigint, frames: Keyframe[]) =>
    alice.reducers.saveBranchKeyframes({ branchId: x, objectId: "ball-1", startMediaUs: startUs, keyframesJson: JSON.stringify(frames) });
  await save(2_000_000n, [frame(2, 2), frame(2.5, 2.5)]);
  await save(1_000_000n, [frame(1, 1), frame(1.5, 1.5)]); // arrives second, sorts first
  await until(() => trackOf(bob, x)?.length === 4, "both chunks");
  expect(trackOf(bob, x)!.map(f => f.t)).toEqual([1, 1.5, 2, 2.5]);
  const key = `${x}:ball-1:2000000`;
  room.mutate(alice.auth, ctx => ctx.db.branchKeyframes.key.update({ ...ctx.db.branchKeyframes.key.find(key), keyframesJson: JSON.stringify([frame(2, 9), frame(3, 9)]) }));
  await until(() => trackOf(bob, x)?.at(-1)?.t === 3, "the updated chunk");
  expect(trackOf(bob, x)!.map(f => f.p[0])).toEqual([1, 1.5, 9, 9]);
  room.mutate(alice.auth, ctx => ctx.db.branchKeyframes.key.delete(`${x}:ball-1:1000000`));
  await until(() => trackOf(bob, x)?.length === 2, "the deleted chunk");
  room.mutate(alice.auth, ctx => ctx.db.branchKeyframes.insert({ key: `${x}:ball-1:4000000`, branchId: x, objectId: "ball-1",
    startMediaUs: 4_000_000n, endMediaUs: 4_000_000n, keyframesJson: "[{\"t\":4}]", author: ctx.sender }));
  await until(() => bob.reports.some(m => m.includes("unreadable")), "the malformed chunk warning");
  expect(trackOf(bob, x)!.map(f => f.t)).toEqual([2, 3]);
  room.mutate(alice.auth, ctx => ctx.db.branchKeyframes.key.delete(key));
  await until(() => trackOf(bob, x) === undefined, "the last chunk gone");
});

test("two players: pause, seek, grab, hold, throw and replay the same take; a re-grab makes a new take", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice", { latency: 2 });
  const { code, roomId } = await openRoom(room, hostClient, false); // playing, as a new room is
  const guest = room.client("bob", { latency: 3 });
  await guest.reducers.joinRoom({ joinCode: code, name: "Bob", device: "phone" });
  const alice = attach(hostClient), bob = attach(guest);
  expect(bob.viewer.timeline.playing).toBe(true);

  alice.viewer.togglePlay(); // pause
  await until(() => serverTimeline(room, roomId).paused && !bob.viewer.timeline.playing, "the shared pause");
  alice.viewer.seek(1.5);
  await until(() => Math.abs(bob.viewer.timeline.time - 1.5) < 1e-6, "the shared seek");
  expect(serverTimeline(room, roomId).anchorMediaUs).toBe(1_500_000n);
  expect(room.calls(guest).map(c => c.reducer)).toEqual(["joinRoom"]); // applied clocks never echo back

  const applied: unknown[][] = [];
  const applyClock = alice.viewer.applyClock.bind(alice.viewer);
  alice.viewer.applyClock = (...args: Parameters<Viewer["applyClock"]>) => { applied.push(args); applyClock(...args); };
  expect(await alice.viewer.grab("ball-1")).toBe(true);
  const x = serverTimeline(room, roomId).branchId;
  expect(x).not.toBe(0n);
  expect(applied).toEqual([]); // the fork's clock row arrived before the grant and was held back
  expect(alice.viewer.held?.definition.id).toBe("ball-1");
  expect(alice.viewer.timeline.activeId).toBe(String(x));
  expect(alice.viewer.timeline.time).toBe(1.5);
  await sleep(10);
  expect(applied).toEqual([]); // and the grant left nothing to reconcile
  await until(() => bob.viewer.timeline.activeId === String(x), "bob on the new take");
  expect(bob.viewer.timeline.branches.find(b => b.id === String(x))).toMatchObject({ parentId: "original", name: "First edit", forkTime: 1.5 });

  alice.viewer.moveHeld(new Vector3(0.3, 1.4, -1.2), new Quaternion(), 1 / 60);
  await until(() => Math.abs((guest.tables.objectState.key as any).find(`${x}:ball-1`)?.px - 0.3) < 1e-6, "the held pose");
  await sleep(80); bob.viewer.update(0.1); // remote poses interpolate over 1/15 s of wall time
  const bobBall = bob.viewer.memory.objects[0].root.position;
  expect([bobBall.x, bobBall.y, bobBall.z].map(v => +v.toFixed(5))).toEqual([0.3, 1.4, -1.2]);

  alice.viewer.moveHeld(new Vector3(0.5, 1.5, -1.2), new Quaternion(), 1 / 60);
  alice.viewer.release(); // throw
  await settle(alice);
  await until(() => !serverRow(room, x, "ball-1")?.simOwner, "the throw to rest");
  const calls = room.calls(hostClient, "start").map(c => c.reducer);
  expect(calls.slice(calls.indexOf("grab"))).toEqual(expect.arrayContaining(["release", "saveBranchKeyframes"]));
  const releases = room.calls(hostClient, "start").filter(c => c.reducer === "release").map(c => c.args.rest);
  expect(releases).toEqual([false, true]);
  const chunks = [...room.h.db.branchKeyframes.iter()].filter(c => c.branchId === x);
  expect(chunks.length).toBeGreaterThanOrEqual(2); // 1.5 s → up to 6 s at 30 Hz is more than 120 frames
  await until(() => JSON.stringify(trackOf(alice, x)) === JSON.stringify(trackOf(bob, x)), "identical tracks");
  const shared = trackOf(bob, x)!;
  expect(shared[0].t).toBe(1.5);
  expect(shared.length).toBe(chunks.reduce((n, c) => n + JSON.parse(c.keyframesJson).length, 0));
  for (const t of [1.5, 2, 3, 5]) expect(bob.viewer.timeline.track("ball-1", original, t)).toEqual(alice.viewer.timeline.track("ball-1", original, t));

  expect(await bob.viewer.grab("ball-1")).toBe(true); // the ball rests on X: editing it again forks
  const y = serverTimeline(room, roomId).branchId;
  expect(y).not.toBe(x);
  expect(bob.viewer.timeline.activeId).toBe(String(y));
  await until(() => alice.viewer.timeline.activeId === String(y), "alice on bob's take");
  expect(alice.viewer.timeline.branches.find(b => b.id === String(y))).toMatchObject({ parentId: String(x), name: "Edit ball-1", forkTime: 1.5 });

  // While bob holds it, alice cannot have it; the reason reaches her status line.
  expect(await alice.viewer.grab("ball-1")).toBe(false);
  await until(() => alice.reports.some(m => m.includes("owned by another player")), "the rejection reason");
  expect(alice.viewer.timeline.branches.length).toBe(3); // no local take
  bob.viewer.release();
  await settle(bob);
  await until(() => !serverRow(room, y, "ball-1")?.simOwner && JSON.stringify(trackOf(alice, y)) === JSON.stringify(trackOf(bob, y)), "bob's take everywhere");
});

test("one queue: a caught throw's saves and release(rest) finish before the catch seeks and grabs", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice", { latency: 4 });
  const { roomId } = await openRoom(room, hostClient);
  const alice = attach(hostClient);
  alice.viewer.seek(1);
  await until(() => serverTimeline(room, roomId).anchorMediaUs === 1_000_000n, "the seek");
  expect(await alice.viewer.grab("ball-1")).toBe(true);
  const x = serverTimeline(room, roomId).branchId;
  alice.viewer.moveHeld(new Vector3(0, 2.5, -1), new Quaternion(), 1 / 60);
  alice.viewer.release();
  for (let i = 0; i < 30; i++) alice.viewer.update(STEP); // half a second of flight
  const before = room.log.length;
  expect(await alice.viewer.grab("ball-1")).toBe(true); // catches it mid-air at 1.5 s
  const log = room.log.slice(before).filter(c => c.reducer !== "moveObject");
  const started = log.filter(c => c.phase === "start").map(c => c.reducer === "release" ? `release:${c.args.rest}` : c.reducer);
  expect(started).toEqual([...started.filter(r => r === "release:false"), ...started.filter(r => r === "saveBranchKeyframes"), "release:true", "seek", "grab"]);
  // Each call starts only after the previous one finished.
  for (let i = 1; i < log.length; i++) if (log[i].phase === "start") expect(log[i - 1].phase).toBe("done");
  const y = serverTimeline(room, roomId).branchId;
  expect(room.h.db.branch.id.find(y)).toMatchObject({ parentId: x, forkMediaUs: 1_500_000n });
  expect(alice.viewer.timeline.activeId).toBe(String(y));
  expect(alice.viewer.timeline.time).toBeCloseTo(1.5, 9);
  expect(alice.reports.filter(m => m.startsWith("Could not"))).toEqual([]);
});

test("remote poses follow only the room's current take; a resting object goes back to its track", async () => {
  const room = new RoomServer();
  const alice = room.client("alice");
  const { code, roomId } = await openRoom(room, alice);
  const bob = attach(await joined(room, "bob", code));
  const other = room.client("dana"); // another room, with its own takes
  await openRoom(room, other);
  await other.reducers.grab({ objectId: "ball-1", ...pose(5, 5, 5) });
  await other.reducers.moveObject({ objectId: "ball-1", ...pose(6, 6, 6) });
  await sleep(5);
  const remotes = () => (bob.viewer as any).remotePoses as Map<string, unknown>;
  expect(remotes().size).toBe(0);
  await alice.reducers.grab({ objectId: "ball-1", ...pose(1, 1, 1) });
  await until(() => bob.viewer.timeline.activeId === String(serverTimeline(room, roomId).branchId), "bob on alice's take");
  await until(() => remotes().has("ball-1"), "alice's hold on bob's screen");
  await alice.reducers.release({ objectId: "ball-1", rest: false, ...pose(1, 2, 1) });
  await until(() => remotes().has("ball-1"), "the throw on bob's screen");
  await alice.reducers.release({ objectId: "ball-1", rest: true, ...pose(1, 0.2, 1) });
  await until(() => !remotes().has("ball-1"), "the rest");
  await other.reducers.moveObject({ objectId: "ball-1", ...pose(7, 7, 7) });
  await sleep(5);
  expect(remotes().size).toBe(0);
});

test("when the server clears our hold (we left, or the connection dropped) the viewer lets go", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice");
  const { code } = await openRoom(room, hostClient);
  const alice = attach(hostClient);
  const bob = attach(await joined(room, "bob", code));
  for (const midFlight of [false, true]) {
    alice.viewer.seek(midFlight ? 2 : 1);
    await sleep(5);
    expect(await alice.viewer.grab("ball-1")).toBe(true);
    const take = alice.viewer.timeline.activeId;
    if (midFlight) {
      alice.viewer.moveHeld(new Vector3(0, 2, -1), new Quaternion(), 1 / 60);
      alice.viewer.release();
      for (let i = 0; i < 10; i++) alice.viewer.update(STEP);
      expect(alice.viewer.recording).toBe(true);
      expect(trackOf(alice, take)!.length).toBeGreaterThan(1); // the local preview's frames
    }
    const before = room.log.length;
    room.mutate(hostClient.auth, ctx => (mod.leaveRoom as any)(ctx, {})); // e.g. another tab of hers left
    await until(() => alice.viewer.held === null && !alice.viewer.recording, "the revocation");
    await sleep(80);
    expect(alice.reports.at(-1)).toMatch(/no longer hold the ball/); // and no stale "Could not throw" after it
    expect(trackOf(alice, take)).toBeUndefined(); // the take shows what the server has: nothing was saved
    // Only what was already queued when the server cleared the hold (the throw and its first moves): no saves, no
    // release(rest), nothing after the revocation.
    const after = room.log.slice(before).filter(c => c.client === "alice" && c.phase === "start");
    expect(after.every(c => c.reducer === "moveObject" || (c.reducer === "release" && !c.args.rest))).toBe(true);
    if (!midFlight) expect(after).toEqual([]);
    await hostClient.reducers.joinRoom({ joinCode: code, name: "Alice", device: "desktop" }); // back for round two
    await until(() => !!hostClient.net.room, "alice back in the room");
  }
  expect(bob.reports.filter(m => m.startsWith("Could not"))).toEqual([]);
});

test("clock: a refused change is reported and the viewer returns to the room's clock; drift past 100 ms is corrected", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice");
  const { code, roomId } = await openRoom(room, hostClient);
  const alice = attach(hostClient);
  const bob = attach(await joined(room, "bob", code));
  alice.viewer.seek(1);
  await sleep(5);
  expect(await alice.viewer.grab("ball-1")).toBe(true);
  await until(() => bob.viewer.timeline.activeId === alice.viewer.timeline.activeId, "bob on the take");
  bob.viewer.seek(3); // the server refuses while alice holds the ball
  await until(() => bob.reports.some(m => m.includes("Wait for objects to settle")), "the refusal");
  await until(() => Math.abs(bob.viewer.timeline.time - 1) < 1e-6, "bob back on the room's time");
  expect(alice.viewer.held?.definition.id).toBe("ball-1");
  alice.viewer.release();
  await settle(alice);
  await until(() => !serverRow(room, serverTimeline(room, roomId).branchId, "ball-1")?.simOwner, "the rest");

  bob.viewer.togglePlay(); // play, from bob this time
  await until(() => !serverTimeline(room, roomId).paused && alice.viewer.timeline.playing, "the shared play");
  bob.viewer.timeline.time += 0.4; // a hitch: bob's clock jumps ahead, and keeps running from there
  const drift = () => bob.viewer.timeline.time - bob.client.net.time();
  let last = performance.now();
  const tick = () => { const now = performance.now(); bob.viewer.update((now - last) / 1000); last = now; };
  tick();
  expect(drift()).toBeGreaterThan(0.3);
  await until(() => { tick(); return Math.abs(drift()) < 0.05; }, "the drift correction", 2500);
  expect(bob.viewer.timeline.playing).toBe(true);
});

test("a refused clock change stays up until a later one succeeds, and never lands in the room panel's error", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice");
  const { code, roomId } = await openRoom(room, hostClient);
  const alice = attach(hostClient);
  // Bob's status line, wired as session.ts does: the viewer and the adapter share it.
  const hint = "In room. Pause to grab and throw; everyone sees the same take.";
  let line = hint;
  const status = new Notice(text => (line = text), text => line === text, () => hint);
  const bob = attach(await joined(room, "bob", code), status);
  alice.viewer.seek(1);
  await until(() => Math.abs(bob.viewer.timeline.time - 1) < 1e-6, "the shared seek");
  expect(alice.resolved).toContain("clock");
  expect(bob.resolved).toEqual([]); // applying alice's seek is not a change of bob's
  expect(await alice.viewer.grab("ball-1")).toBe(true);
  await until(() => bob.viewer.timeline.activeId === alice.viewer.timeline.activeId, "bob on the take");
  bob.viewer.seek(3); // refused while alice holds the ball
  await until(() => line.includes("Wait for objects to settle"), "the refusal");
  expect(bob.notices.at(-1)).toMatchObject({ kind: "clock", error: true });
  expect(bob.client.net.error).toBe(""); // the adapter shows its own errors
  expect(bob.resolved).toEqual([]);
  alice.viewer.release();
  await settle(alice);
  await until(() => !serverRow(room, serverTimeline(room, roomId).branchId, "ball-1")?.simOwner, "the rest");
  expect(line).toMatch(/Wait for objects to settle/); // still the newest message
  bob.viewer.seek(2); // goes through now
  await until(() => serverTimeline(room, roomId).anchorMediaUs === 2_000_000n, "bob's seek");
  await until(() => bob.resolved.includes("clock"), "the success");
  expect(line).toBe(hint);
  expect(alice.notices.filter(n => n.error)).toEqual([]);
});

test("a play pressed while a grab is still waiting runs after the unused grant is given back", async () => {
  // Found in review: the queue used to start the clock change as soon as the grab's call finished, before the viewer
  // gave the grant back, so the server refused it ("Wait for objects to settle") and the room stayed on the new take.
  const room = new RoomServer();
  const hostClient = room.client("alice", { latency: 60 });
  const { roomId } = await openRoom(room, hostClient);
  const host = attach(hostClient);
  host.viewer.seek(1);
  await until(() => serverTimeline(room, roomId).anchorMediaUs === 1_000_000n, "seek");
  await sleep(150);
  const grab = host.viewer.grab("ball-1");
  await sleep(5);
  host.viewer.togglePlay(); // cancels the pending grab in the viewer
  expect(await grab).toBe(false);
  await until(() => !serverTimeline(room, roomId).paused, "the room to play");
  expect(serverTimeline(room, roomId).branchId).toBe(0n);
  await until(() => host.viewer.timeline.playing, "the viewer to play");
  expect(host.viewer.timeline.activeId).toBe("original");
  const calls = room.calls(hostClient);
  expect(calls.filter(c => c.error).map(c => `${c.reducer}: ${c.error}`)).toEqual([]);
  const order = calls.map(c => c.reducer);
  expect(order.lastIndexOf("release")).toBeGreaterThan(order.lastIndexOf("grab"));
  expect(order.lastIndexOf("release")).toBeLessThan(order.lastIndexOf("setBranch"));
  expect(host.reports.filter(r => r.startsWith("Could not"))).toEqual([]);
  expect([...room.h.db.objectState.iter()].some(o => o.simOwner)).toBe(false);
});

test("acquire never leaves the viewer pending: a grant that comes too late is given back", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice");
  const { roomId } = await openRoom(room, hostClient);
  const alice = attach(hostClient);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  hostClient.latency = 10_000; // the grab's answer takes 10 s
  const grab = alice.viewer.grab("ball-1");
  await vi.advanceTimersByTimeAsync(8_100);
  expect(await grab).toBe(false);
  expect(alice.viewer.busy).toBe(false);
  const x = serverTimeline(room, roomId).branchId;
  expect(serverRow(room, x, "ball-1")?.simOwner).toBeDefined(); // the server did grant it
  await vi.advanceTimersByTimeAsync(2_000); // the late grant arrives and goes straight back
  expect(serverRow(room, x, "ball-1")?.simOwner).toBeUndefined();
  expect(serverRow(room, x, "ball-1")?.mode).toBe("rest");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(alice.reports.some(m => m.includes("did not answer in time"))).toBe(true);
});

test("moves are throttled to 15 Hz per object, keeping the latest pose", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice");
  await openRoom(room, hostClient);
  const alice = attach(hostClient);
  alice.viewer.seek(1);
  await sleep(5);
  expect(await alice.viewer.grab("ball-1")).toBe(true);
  alice.viewer.moveHeld(new Vector3(0, 2, -1), new Quaternion(), 1 / 60);
  alice.viewer.release();
  for (let i = 0; i < 120; i++) alice.viewer.update(STEP); // two seconds of flight in a few milliseconds: 30 pose events
  await sleep(150);
  const moves = room.calls(hostClient).filter(c => c.reducer === "moveObject");
  expect(moves.length).toBeGreaterThanOrEqual(1);
  expect(moves.length).toBeLessThanOrEqual(3);
});

test("a take made only on this device is never sent; the viewer returns to the room's take", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice");
  await openRoom(room, hostClient);
  const reports: string[] = [];
  const viewer = makeViewer(reports);
  viewer.seek(1);
  expect(await viewer.grab("ball-1")).toBe(true); // no authority yet: a local take
  viewer.release();
  for (let i = 0; i < 600 && viewer.recording; i++) viewer.update(STEP);
  const local = viewer.timeline.activeId;
  expect(local).toMatch(/^local-/);
  const adapter = new NetAdapter(hostClient.net, viewer, m => reports.push(m));
  viewer.setAuthority(adapter); adapter.start(); cleanup.push(() => adapter.dispose());
  expect(viewer.timeline.activeId).toBe("original");
  const before = room.log.length;
  viewer.selectBranch(local);
  await until(() => viewer.timeline.activeId === "original", "the room's take");
  expect(reports.some(m => m.includes("only on this device"))).toBe(true);
  expect(room.log.length).toBe(before);
});

test("dispose removes every hook, listener and timer", async () => {
  const room = new RoomServer();
  const hostClient = room.client("alice");
  const { roomId } = await openRoom(room, hostClient);
  const clearInterval = vi.spyOn(globalThis, "clearInterval");
  const alice = attach(hostClient);
  expect(Object.values(hostClient.tables).reduce((n, t) => n + t.listenerCount, 0)).toBeGreaterThan(0);
  alice.adapter.dispose();
  expect(Object.values(hostClient.tables).map(t => t.listenerCount)).toEqual(Object.values(hostClient.tables).map(() => 0));
  expect(alice.viewer.listeners.size).toBe(0);
  expect(clearInterval).toHaveBeenCalled();
  expect((alice.adapter as any).timers.size).toBe(0);
  const before = room.log.length;
  alice.viewer.seek(2);
  await sleep(20);
  expect(room.log.length).toBe(before);
  await hostClient.reducers.seek({ mediaUs: 4_000_000n });
  expect(serverTimeline(room, roomId).anchorMediaUs).toBe(4_000_000n);
  expect(alice.viewer.timeline.time).toBe(2);
  expect(await alice.adapter.acquire({ objectId: "ball-1", branchId: "original", time: 2, pose: frame(2) })).toBe(false);
});
