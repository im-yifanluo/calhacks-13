// Live test: real WebSocket clients, real reducer permissions, real subscription convergence.
import assert from "node:assert/strict";
import { DbConnection } from "../apps/web/src/module_bindings";
const database = process.env.STDB_DATABASE || "memory-replay";
const uri =
  process.env.STDB_WS_URL || `ws://127.0.0.1:${process.env.STDB_PORT || 3055}`;
const clients: DbConnection[] = [];
async function connect() {
  return new Promise<DbConnection>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error("Connect timed out: publish the current module first"),
        ),
      10000,
    );
    const conn = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .withCompression("none")
      .onConnect((conn) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timeout);
            resolve(conn);
          })
          .onError((ctx) => {
            clearTimeout(timeout);
            reject(ctx.event);
          })
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timeout);
        reject(error);
      })
      .build();
    clients.push(conn);
  });
}
async function until(check: () => unknown, message: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(message);
}
try {
  const leader = await connect(),
    guest = await connect(),
    worker = await connect();
  const requestId = `party-test-${crypto.randomUUID()}`;
  await leader.reducers.createMemory({
    requestId,
    title: "Party integration demo",
    sourceUrl: "",
    manifestUrl: "http://127.0.0.1:5173/demo/memory.json",
    pipelineIdentity: worker.identity!,
    durationUs: 6_000_000n,
  });
  const memory = leader.db.memory.requestId.find(requestId)!;
  await leader.reducers.createParty({
    memoryId: memory.id,
    name: "Test leader",
    device: "desktop",
  });
  const roomId = leader.db.player.identity.find(leader.identity!)!.roomId;
  const room = leader.db.room.id.find(roomId)!;
  await guest.reducers.joinRoom({
    joinCode: room.joinCode.toLowerCase(),
    name: "Test guest",
    device: "phone",
  });
  await until(
    () =>
      [...leader.db.player.iter()].filter(
        (p) => p.roomId === roomId && p.online,
      ).length === 2,
    "Presence did not converge",
  );
  const clock = (c: DbConnection) => c.db.timeline.roomId.find(roomId)!;
  await assert.rejects(guest.reducers.setPaused({ paused: true }), /leader/);
  await assert.rejects(guest.reducers.seek({ mediaUs: 2_000_000n }), /leader/);
  await assert.rejects(guest.reducers.setPlaybackSpeed({ speed: 2 }), /leader/);
  await assert.rejects(guest.reducers.setBranch({ branchId: 0n }), /leader/);
  await leader.reducers.setPaused({ paused: true });
  await leader.reducers.seek({ mediaUs: 2_000_000n });
  await leader.reducers.setPlaybackSpeed({ speed: 0.5 });
  await until(
    () =>
      clock(guest).paused &&
      clock(guest).anchorMediaUs === 2_000_000n &&
      clock(guest).speed === 0.5,
    "Shared clock did not converge",
  );
  const late = await connect();
  await late.reducers.joinRoom({
    joinCode: room.joinCode,
    name: "Late visitor",
    device: "quest",
  });
  assert.equal(clock(late).anchorMediaUs, 2_000_000n);
  console.log(
    "PASS: invite code, presence, late join, synchronized seek/pause/speed; guest writes rejected",
  );
  await leader.reducers.createMemory({
    requestId: `${requestId}-video`,
    title: "Pending video test",
    sourceUrl: "https://assets.example/test-video.mp4",
    manifestUrl: "",
    pipelineIdentity: worker.identity!,
    durationUs: 6_000_000n,
  });
  const video = leader.db.memory.requestId.find(`${requestId}-video`)!;
  await assert.rejects(
    guest.reducers.attachPartyMemory({ memoryId: video.id }),
    /leader/,
  );
  await leader.reducers.attachPartyMemory({ memoryId: video.id });
  assert.equal(leader.db.room.id.find(roomId)!.memoryId, memory.id);
  await until(
    () => guest.db.party.roomId.find(roomId)?.pendingMemoryId === video.id,
    "Pending scene did not arrive",
  );
  const update = {
    memoryId: video.id,
    status: "processing",
    progress: 0.4,
    manifestUrl: "",
    error: "",
  };
  await assert.rejects(
    guest.reducers.setMemoryStatus(update),
    /assigned pipeline/,
  );
  await worker.reducers.setMemoryStatus(update);
  await worker.reducers.setMemoryStatus({
    ...update,
    status: "ready",
    progress: 1,
    manifestUrl: "http://127.0.0.1:5173/demo/memory.json",
  });
  await until(
    () =>
      [leader, guest, late].every(
        (c) =>
          c.db.room.id.find(roomId)?.memoryId === video.id &&
          c.db.party.roomId.find(roomId)?.pendingMemoryId === 0n,
      ),
    "Ready scene did not converge",
  );
  assert.equal(clock(guest).anchorMediaUs, 0n);
  assert.equal(clock(guest).paused, true);
  console.log(
    "PASS: pending reconstruction, worker authorization, atomic ready-scene switch on all clients (test manifest; no model run)",
  );
  await leader.reducers.transferLeadership({ identity: guest.identity! });
  await assert.rejects(leader.reducers.seek({ mediaUs: 1_000_000n }), /leader/);
  await guest.reducers.seek({ mediaUs: 3_000_000n });
  await until(
    () => clock(late).anchorMediaUs === 3_000_000n,
    "New leader seek did not arrive",
  );
  guest.disconnect();
  await until(
    () => !leader.db.room.id.find(roomId)!.host.isEqual(guest.identity!),
    "Disconnected leader was not replaced",
  );
  const next = leader.db.room.id.find(roomId)!.host;
  const nextClient = next.isEqual(leader.identity!) ? leader : late;
  await nextClient.reducers.setPaused({ paused: false });
  await until(
    () => !clock(leader).paused && !clock(late).paused,
    "Replacement leader cannot resume",
  );
  console.log(
    "PASS: explicit leader transfer, revocation, disconnect election, replacement leader playback",
  );
  console.log(
    `Party integration passed against ${database}. Test metadata retained under ${requestId}.`,
  );
} finally {
  for (const conn of clients) conn.disconnect();
}
