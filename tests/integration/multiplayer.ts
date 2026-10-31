import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { makeHandler } from "../../server/upload/src/handler.mjs";
import { s3Config } from "../../server/upload/src/node/s3.mjs";
import { DbConnection } from "../../apps/web/src/module_bindings";
const database = process.env.STDB_DATABASE || "memory-replay";
const uri = process.env.STDB_WS_URL || `ws://127.0.0.1:${process.env.STDB_PORT || 3055}`;
const clients: DbConnection[] = [];
async function connect(token?: string, endpoint = uri, reconnected?: () => void) {
  return new Promise<{ conn: DbConnection; token: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection/subscription timed out")), 10000);
    const conn = DbConnection.builder()
      .withUri(endpoint)
      .withDatabaseName(database)
      .withToken(token)
      .withAutomaticReconnect()
      .onAutomaticReconnect(() => reconnected?.())
      .withCompression("none")
      .onConnect((conn, _id, token) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timeout);
            resolve({ conn, token });
          })
          .onError((ctx) => reject(ctx.event))
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
async function until(predicate: () => unknown) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Subscription did not converge");
}
const pose = {
  px: 0,
  py: 1,
  pz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  vx: 1,
  vy: 0,
  vz: 0,
};
try {
  const a = await connect(),
    b = await connect();
  const requestId = crypto.randomUUID();
  await a.conn.reducers.createMemory({
    requestId,
    title: "Integration test",
    sourceUrl: "",
    manifestUrl: "https://localhost:5173/mock/memory.json",
    pipelineIdentity: a.conn.identity!,
    durationUs: 6_000_000n,
  });
  await until(() => [...a.conn.db.memory.iter()].find((row) => row.requestId === requestId));
  const m = [...a.conn.db.memory.iter()].find((row) => row.requestId === requestId)!;
  await a.conn.reducers.createRoom({
    memoryId: m.id,
    name: "Alice",
    device: "phone",
  });
  const r = [...a.conn.db.room.iter()].find((r) => r.memoryId === m.id)!;
  assert.match(r.joinCode, /^[A-Z0-9]{7}$/);
  await b.conn.reducers.joinRoom({
    joinCode: r.joinCode,
    name: "Bob",
    device: "quest",
  });
  await until(() => [...a.conn.db.player.iter()].filter((p) => p.roomId === r.id && p.online).length === 2);
  await a.conn.reducers.setPose({
    hx: 2,
    hy: 1.6,
    hz: 0,
    hqx: 0,
    hqy: 0,
    hqz: 0,
    hqw: 1,
    lx: 0,
    ly: 0,
    lz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
  });
  await until(() => b.conn.db.player.identity.find(a.conn.identity!)?.hx === 2);
  await a.conn.reducers.setPaused({ paused: true });
  await a.conn.reducers.seek({ mediaUs: 0n });
  await until(() => b.conn.db.timeline.roomId.find(r.id)?.paused);
  await a.conn.reducers.grab({ objectId: "ball-1", ...pose });
  const branchId = a.conn.db.timeline.roomId.find(r.id)!.branchId;
  assert.notEqual(branchId, 0n);
  await assert.rejects(() => b.conn.reducers.grab({ objectId: "ball-1", ...pose }));
  await a.conn.reducers.release({ objectId: "ball-1", rest: false, ...pose });
  await a.conn.reducers.moveObject({ objectId: "ball-1", ...pose, px: 2 });
  await until(() => b.conn.db.objectState.key.find(`${branchId}:ball-1`)?.px === 2);
  await a.conn.reducers.saveBranchKeyframes({
    branchId,
    objectId: "ball-1",
    startMediaUs: 0n,
    keyframesJson: JSON.stringify([
      { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1] },
      { t: 1, p: [2, 1, 0], q: [0, 0, 0, 1] },
    ]),
  });
  await a.conn.reducers.release({
    objectId: "ball-1",
    rest: true,
    ...pose,
    px: 2,
  });
  const late = await connect();
  await late.conn.reducers.joinRoom({
    joinCode: r.joinCode,
    name: "Late",
    device: "phone",
  });
  assert.equal([...late.conn.db.branchKeyframes.iter()].filter((c) => c.branchId === branchId).length, 1);
  await b.conn.reducers.grab({ objectId: "ball-1", ...pose });
  const childBranch = b.conn.db.timeline.roomId.find(r.id)!.branchId;
  assert.notEqual(childBranch, branchId);
  assert.ok(b.conn.db.objectState.key.find(`${childBranch}:ball-1`)?.simOwner);
  const childFork = b.conn.db.branch.id.find(childBranch)!.forkMediaUs;
  // Alice must see Bob's hold on his new take first, or the checks below pass on a stale cache.
  await until(
    () =>
      a.conn.db.objectState.key.find(`${childBranch}:ball-1`)?.simOwner &&
      a.conn.db.timeline.roomId.find(r.id)?.branchId === childBranch,
  );
  b.conn.disconnect();
  await until(() => !a.conn.db.objectState.key.find(`${childBranch}:ball-1`)?.simOwner);
  // Bob dropped before saving a chunk, so the room leaves the empty take his grab forked.
  await until(() => a.conn.db.timeline.roomId.find(r.id)?.branchId === branchId);
  const back = a.conn.db.timeline.roomId.find(r.id)!;
  assert.equal(back.paused, true);
  assert.equal(back.anchorMediaUs, childFork);
  assert.ok(a.conn.db.branch.id.find(childBranch), "the empty take is kept");
  const resumed = await connect(b.token);
  await until(() => a.conn.db.player.identity.find(resumed.conn.identity!)?.online);
  assert.equal(resumed.conn.identity!.toHexString(), b.conn.identity!.toHexString());
  // A player who left stays out of the room after reconnecting.
  await resumed.conn.reducers.leaveRoom({});
  resumed.conn.disconnect();
  const again = await connect(b.token);
  assert.equal(again.conn.identity!.toHexString(), b.conn.identity!.toHexString());
  const gone = again.conn.db.player.identity.find(again.conn.identity!)!;
  assert.equal(gone.online, false);
  assert.equal(gone.roomId, 0n);
  await until(() => !a.conn.db.player.identity.find(again.conn.identity!)?.online);
  // Exercise pipeline HTTP reducer permissions and the array payload consumed by the signing service.
  const http = uri.replace(/^ws/, "http");
  const uploadId = crypto.randomUUID();
  const config = s3Config({
    S3_BUCKET: "local-test",
    ASSET_BASE_URL: "https://assets.example",
    UPLOAD_SIGNING_SECRET: "local-test-only-".repeat(3),
    PIPELINE_IDENTITY: a.conn.identity!.toHexString(),
    STDB_HTTP_URL: http,
    STDB_DATABASE: database,
  });
  let stored: Buffer | undefined, storedType: string | undefined;
  let storageUrl = "";
  const uploadHandler = makeHandler({
    ...config,
    sign: async () => storageUrl,
    head: async () => ({ size: stored?.length, type: storedType }),
  });
  const uploadServer = createServer(async (req, res) => {
    if (req.method === "PUT" && req.url === "/test-storage") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      stored = Buffer.concat(chunks);
      storedType = req.headers["content-type"];
      res.writeHead(200);
      res.end();
    } else await uploadHandler(req, res);
  });
  await new Promise<void>((r) => uploadServer.listen(0, "127.0.0.1", r));
  const uploadBase = `http://127.0.0.1:${(uploadServer.address() as any).port}`;
  storageUrl = uploadBase + "/test-storage";
  const api = (path: string, body: unknown) =>
    fetch(`${uploadBase}/api/uploads/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${a.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identity: a.conn.identity!.toHexString(),
        ...(body as any),
      }),
    });
  let receipt = "",
    uploadedRequest = "";
  try {
    const presign = await api("presign", {
      name: "fixture.mp4",
      type: "video/mp4",
      size: 4,
      title: "Local transport fixture",
      durationSec: 6,
    });
    assert.equal(presign.status, 200);
    const prepared = await presign.json();
    receipt = prepared.receipt;
    uploadedRequest = prepared.requestId;
    assert.equal((await api("complete", { receipt })).status, 400);
    assert.equal(
      (
        await fetch(prepared.putUrl, {
          method: "PUT",
          headers: prepared.headers,
          body: new Uint8Array([0, 1, 2, 3]),
        })
      ).status,
      200,
    );
    const complete = await api("complete", { receipt });
    assert.equal(complete.status, 200, await complete.text());
  } catch (error) {
    await new Promise<void>((r) => uploadServer.close(() => r()));
    throw error;
  }
  await until(() => [...a.conn.db.memory.iter()].find((row) => row.requestId === uploadedRequest));
  const upload = [...a.conn.db.memory.iter()].find((row) => row.requestId === uploadedRequest)!;
  const callStatus = (token: string, status: string, progress: number, url = "") =>
    fetch(`${http}/v1/database/${database}/call/set_memory_status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([Number(upload.id), status, progress, url, ""]),
    });
  assert.equal((await callStatus(b.token, "processing", 0.1)).ok, false);
  assert.equal((await callStatus(a.token, "processing", 0.1)).ok, true);
  assert.equal((await callStatus(a.token, "ready", 1, "https://assets.example/memory.json")).ok, true);
  await until(() => late.conn.db.memory.id.find(upload.id)?.status === "ready");
  try {
    assert.equal((await api("complete", { receipt })).status, 200);
  } finally {
    await new Promise<void>((r) => uploadServer.close(() => r()));
  }
  // Interrupt a real WebSocket transport; the SDK must replay subscriptions on the same identity.
  const transportServer = createServer(async (req, res) => {
    // The SDK exchanges its retained identity token over HTTP before reconnecting.
    const response = await fetch(`${http}${req.url}`, {
      method: req.method,
      headers: req.headers.authorization ? { Authorization: req.headers.authorization } : undefined,
    });
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(await response.text());
  });
  const proxy = new WebSocketServer({ server: transportServer });
  await new Promise<void>((r) => transportServer.listen(0, "127.0.0.1", r));
  const upstreams = new Set<WebSocket>();
  proxy.on("connection", (client, request) => {
    const upstream = new WebSocket(
      `${uri}${request.url}`,
      request.headers["sec-websocket-protocol"]?.split(",").map((s) => s.trim()),
    );
    upstreams.add(upstream);
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else upstream.once("open", () => upstream.send(data, { binary: isBinary }));
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on("close", () => {
      upstreams.delete(upstream);
      client.terminate();
    });
    client.on("close", () => upstream.terminate());
    upstream.on("error", () => client.terminate());
  });
  try {
    let reconnects = 0;
    const auto = await connect(
      undefined,
      `ws://127.0.0.1:${(transportServer.address() as any).port}`,
      () => reconnects++,
    );
    const identity = auto.conn.identity!.toHexString();
    for (const socket of proxy.clients) socket.terminate();
    await until(() => reconnects > 0);
    await until(() => [...auto.conn.db.memory.iter()].find((row) => row.requestId === uploadedRequest));
    assert.equal(auto.conn.identity!.toHexString(), identity);
    await auto.conn.reducers.sampleClock({
      clientSentUs: BigInt(Date.now()) * 1000n,
    });
    auto.conn.disconnect();
  } finally {
    for (const socket of proxy.clients) socket.terminate();
    for (const socket of upstreams) socket.terminate();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => transportServer.close(() => r()));
  }
  console.log(
    "PASS: actual WebSocket presence, shared clock, ownership contention, post-release sync, late-join trajectories, disconnect/reconnect, automatic transport recovery, authenticated upload PUT/completion and HTTP pipeline status",
  );
} finally {
  for (const c of clients) c.disconnect();
}
