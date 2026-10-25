/** Isolated I3/I4/I5/I7 contract test: real DB, HTTP storage, existing Python worker, two WS clients. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createLocalHandler } from "../server/upload/local.mjs";
import { DbConnection } from "../apps/web/src/module_bindings";

const exec = promisify(execFile), repo = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "memos-connections-"));
const database = "memos-connections-test", clients: DbConnection[] = [];
let dbProcess: ChildProcess | undefined, dbLog = "";
const servers: ReturnType<typeof createServer>[] = [];
async function listen(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
async function until(check: () => unknown | Promise<unknown>, message: string, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(message);
}
async function connect(uri: string, token?: string) {
  return new Promise<DbConnection>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("I7 WebSocket subscription timed out")), 10000);
    const fail = (error: unknown) => { clearTimeout(timeout); reject(error); };
    const conn = DbConnection.builder().withUri(uri).withDatabaseName(database).withToken(token).withCompression("none")
      .onConnect(c => c.subscriptionBuilder().onApplied(() => { clearTimeout(timeout); resolve(c); }).onError(ctx => fail(ctx.event)).subscribeToAllTables())
      .onConnectError((_ctx, error) => fail(error)).build();
    clients.push(conn);
  });
}
const cleanup = async () => {
  clients.forEach(c => c.disconnect());
  await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  if (dbProcess?.pid && dbProcess.exitCode === null && dbProcess.signalCode === null) {
    const exited = new Promise<void>(resolve => dbProcess!.once("exit", () => resolve()));
    dbProcess.kill("SIGTERM");
    const force = setTimeout(() => dbProcess?.kill("SIGKILL"), 3000);
    await exited; clearTimeout(force);
  }
  await rm(directory, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
try {
  // Allocate a loopback-only server. No existing database, cloud account or ports are touched.
  const slot = await listen((_req, res) => res.end());
  await new Promise<void>(resolve => slot.server.close(() => resolve()));
  const base = slot.origin, uri = base.replace("http:", "ws:");
  dbProcess = spawn(process.env.SPACETIME_BIN || "spacetime", ["start", "--listen-addr", new URL(base).host,
    "--data-dir", join(directory, "db"), "--in-memory", "--non-interactive", "--page_pool_max_size", "268435456"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: Error | undefined;
  dbProcess.on("error", error => { spawnError = error; });
  dbProcess.stdout?.on("data", b => { dbLog = (dbLog + b).slice(-10000); });
  dbProcess.stderr?.on("data", b => { dbLog = (dbLog + b).slice(-10000); });
  await until(async () => {
    if (spawnError) throw new Error("SpacetimeDB CLI not found. Install 2.13.0 or set SPACETIME_BIN.");
    if (dbProcess!.exitCode !== null) throw new Error("Isolated SpacetimeDB failed to start: " + dbLog);
    try { return (await fetch(base + "/v1/identity", { method: "POST", signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, "Isolated SpacetimeDB startup timed out", 20000);
  await exec(process.env.SPACETIME_BIN || "spacetime", ["publish", "-s", base, "--module-path", "server/spacetime", "--anonymous", "--delete-data=never", "--no-config", "--yes=skip-login", database], { cwd: repo, timeout: 60000 });
  console.log("PASS setup: isolated real SpacetimeDB published");

  let handler: RequestListener = (_req, res) => { res.writeHead(503); res.end(); };
  const app = await listen((req, res) => handler(req, res));
  const uploadDir = join(directory, "uploads"), sceneDir = join(uploadDir, "memories");
  const settings = { STDB_HTTP_URL: base, STDB_DATABASE: database, LOCAL_UPLOAD_DIR: uploadDir, PUBLIC_ORIGIN: app.origin };
  handler = await createLocalHandler(settings);
  const owner = await (await fetch(app.origin + "/api/identity", { method: "POST" })).json();
  const auth = { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" };
  const post = async (path: string, body: object, expected = 200) => {
    const result = await fetch(app.origin + path, { method: "POST", headers: auth, body: JSON.stringify({ identity: owner.identity, ...body }) });
    const data = await result.json(); assert.equal(result.status, expected, JSON.stringify(data)); return data;
  };
  const reportUrl = `${app.origin}/api/connections?identity=${owner.identity}`;
  assert.equal((await fetch(reportUrl)).status, 401);
  const report = await fetch(reportUrl, { headers: auth });
  const connections = await report.json(); assert.equal(report.status, 200, JSON.stringify(connections));
  assert.equal(connections.interfaces.I5.transferVerified, false);
  assert.equal(connections.interfaces.I7.websocketVerified, false);
  await exec(process.execPath, ["scripts/check-connections.mjs", app.origin], { cwd: repo });

  const leader = await connect(uri, owner.token), guest = await connect(uri);
  const bytes = Buffer.from("MEMOS CONNECTION TEST: transport bytes, not a video");
  const upload = async (pipeline: boolean) => {
    const prepared = await post("/api/uploads/presign", { name: "transport.mov", type: "video/quicktime", size: bytes.length, title: "[CONNECTION TEST] transport fixture", durationSec: 6, pipeline });
    const early = await post("/api/uploads/complete", { receipt: prepared.receipt }, 400);
    assert.match(early.error, /PUT the video first/);
    const put = await fetch(prepared.putUrl, { method: "PUT", headers: prepared.headers, body: bytes });
    assert.equal(put.status, 200);
    const complete = await post("/api/uploads/complete", { receipt: prepared.receipt });
    const repeated = await post("/api/uploads/complete", { receipt: prepared.receipt });
    assert.equal(repeated.memory.id, complete.memory.id);
    return { ...prepared, memory: complete.memory };
  };
  const queued = await upload(true), skipped = await upload(false);
  await until(() => guest.db.memory.requestId.find(queued.requestId), "I3 uploaded memory not subscribed");
  assert.equal(guest.db.memory.requestId.find(queued.requestId)!.status, "uploaded");
  console.log("PASS I3: verified PUT → create_memory → one row on completion retries → live subscriber");

  const worker = JSON.parse(await readFile(join(uploadDir, ".worker-identity.json"), "utf8"));
  const workerEnv = { ...process.env, ...settings, PIPELINE_IDENTITY: worker.identity, PIPELINE_TOKEN: worker.token,
    ASSET_BASE_URL: app.origin + "/api/local-media", MEMREPLAY_PUBLISH_DIR: sceneDir, MEMREPLAY_PUBLIC_BASE_URL: app.origin + "/api/local-scenes" };
  const python = async (...args: string[]) => (await exec(process.env.PYTHON || "python3", ["-I", "scripts/test-connection-worker.py", ...args], { cwd: repo, env: workerEnv, timeout: 20000 })).stdout;
  const foreignRequest = randomUUID();
  await leader.reducers.createMemory({ requestId: foreignRequest, title: "[CONNECTION TEST] another worker", sourceUrl: queued.sourceUrl,
    manifestUrl: "", pipelineIdentity: guest.identity!, durationUs: 6000000n });
  const jobs = JSON.parse(await python("poll"));
  assert(jobs.some((r: any) => String(r.id) === queued.memory.id));
  assert(!jobs.some((r: any) => String(r.id) === skipped.memory.id));
  assert(!jobs.some((r: any) => (r.request_id || r.requestId) === foreignRequest));
  await assert.rejects(leader.reducers.setMemoryStatus({ memoryId: BigInt(queued.memory.id), status: "processing", progress: 0.1, manifestUrl: "", error: "" }));

  const placeholder = randomUUID();
  await leader.reducers.createMemory({ requestId: placeholder, title: "[CONNECTION TEST] waiting scene", sourceUrl: "", manifestUrl: app.origin + "/demo/memory.json", pipelineIdentity: leader.identity!, durationUs: 6000000n });
  await leader.reducers.createParty({ memoryId: leader.db.memory.requestId.find(placeholder)!.id, name: "Connection leader", device: "desktop" });
  const roomId = leader.db.player.identity.find(leader.identity!)!.roomId;
  await guest.reducers.joinRoom({ joinCode: leader.db.room.id.find(roomId)!.joinCode, name: "Connection phone", device: "phone" });
  await leader.reducers.attachPartyMemory({ memoryId: BigInt(queued.memory.id) });
  const published = JSON.parse(await python("publish", queued.memory.id, join(directory, "synthetic-scene")));
  assert.equal(published.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(published.files, 2);
  await until(() => guest.db.memory.requestId.find(queued.requestId)?.status === "processing", "I4 processing status not subscribed");
  const manifestReply = await fetch(published.manifestUrl, { headers: { Origin: app.origin } });
  assert.equal(manifestReply.status, 200);
  assert.equal(manifestReply.headers.get("access-control-allow-origin"), app.origin);
  const manifest = await manifestReply.json(); assert.match(manifest.title, /not a reconstruction/);
  const asset = await fetch(new URL(manifest.background.url, published.manifestUrl));
  assert.equal(createHash("sha256").update(Buffer.from(await asset.arrayBuffer())).digest("hex"), published.assetSha256);
  console.log("PASS I5: existing worker downloads exact video bytes, publishes manifest + asset, both retrievable");
  await python("ready", queued.memory.id, published.manifestUrl);
  await until(() => guest.db.room.id.find(roomId)?.memoryId === BigInt(queued.memory.id), "I4 ready scene did not activate for both clients");
  const afterReady = await post("/api/uploads/complete", { receipt: queued.receipt });
  assert.equal(afterReady.memory.status, "ready"); assert.equal(afterReady.memory.manifestUrl, published.manifestUrl);
  console.log("PASS I4: actual Python polling/status helpers, assigned-worker permission, test-upload exclusion, ready scene activation");

  await leader.reducers.setPaused({ paused: true });
  await leader.reducers.seek({ mediaUs: 1000000n });
  await assert.rejects(guest.reducers.seek({ mediaUs: 2000000n }));
  await leader.reducers.setPose({ hx: 2, hy: 1.6, hz: 0, hqx: 0, hqy: 0, hqz: 0, hqw: 1, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0 });
  await leader.reducers.sampleClock({ clientSentUs: 123456n });
  const pose = { px: 0, py: 1, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0 };
  await leader.reducers.grab({ objectId: "ball-1", ...pose });
  await until(() => [...guest.db.objectState.iter()].some(o => o.objectId === "ball-1" && o.mode === "held"), "I7 grab not subscribed");
  await assert.rejects(guest.reducers.grab({ objectId: "ball-1", ...pose }));
  await leader.reducers.release({ objectId: "ball-1", rest: true, ...pose });
  await until(() => guest.db.player.identity.find(leader.identity!)?.hx === 2 && guest.db.timeline.roomId.find(roomId)?.anchorMediaUs === 1000000n, "I7 pose/clock not subscribed");
  assert.equal(leader.db.clockSample.identity.find(leader.identity!)!.clientSentUs, 123456n);
  console.log("PASS I7: two WebSocket clients, party, leader-only clock, poses, exclusive grab/release, clock sample");

  const output = join(directory, "worker.env");
  await exec(process.execPath, ["scripts/local-worker-env.mjs", output], { cwd: repo, env: { ...process.env, ...settings } });
  assert.match(await readFile(output, "utf8"), /MEMREPLAY_PUBLIC_BASE_URL=/);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(exec(process.execPath, ["scripts/local-worker-env.mjs", output], { cwd: repo, env: { ...process.env, ...settings } }));
  console.log("PASS setup: private local worker environment generated and token verified");
  if (process.argv.includes("--full")) {
    for (const script of ["scripts/test-multiplayer.ts", "scripts/test-party.ts"]) {
      const result = await exec(process.execPath, ["--import", "tsx", script], { cwd: repo, env: { ...process.env, STDB_DATABASE: database, STDB_WS_URL: uri }, timeout: 60000 });
      console.log(result.stdout.trim());
    }
  }
  console.log("PASS all connections. Isolated fixtures removed; no GPU reconstruction or R2 cloud transfer was tested.");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { await cleanup(); }
