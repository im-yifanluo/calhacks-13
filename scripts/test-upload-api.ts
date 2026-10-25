/** Isolated phone API test. Uses real SpacetimeDB, the deployment entrypoint, and a checked-in MP4 fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { DbConnection } from "../apps/web/src/module_bindings";
import { decodeAccountKey, encodeAccountKey } from "../apps/web/src/account-key";

const exec = promisify(execFile), repo = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "memos-phone-api-"));
const database = "memos-phone-api-test", processes: ChildProcess[] = [], clients: DbConnection[] = [];
async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}
async function until(check: () => unknown | Promise<unknown>, message: string, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(message);
}
function launch(command: string, args: string[], env = process.env) {
  const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  let failure: Error | undefined, log = "";
  child.on("error", error => { failure = error; });
  child.stdout?.on("data", b => { log = (log + b).slice(-3000); });
  child.stderr?.on("data", b => { log = (log + b).slice(-3000); });
  return { child, check() { if (failure) throw failure; if (child.exitCode !== null) throw new Error(`Test process exited: ${log}`); } };
}
async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(r => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  await ended; clearTimeout(timer);
}
let cleaning: Promise<void> | undefined;
const cleanup = () => cleaning ??= (async () => {
  clients.forEach(c => c.disconnect());
  await Promise.all(processes.map(stop));
  await rm(directory, { recursive: true, force: true });
})();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });

try {
  const dbBase = `http://127.0.0.1:${await port()}`, apiPort = await port(), base = `http://127.0.0.1:${apiPort}`;
  const cli = process.env.SPACETIME_BIN || "spacetime";
  const db = launch(cli, ["start", "--listen-addr", new URL(dbBase).host, "--data-dir", join(directory, "db"),
    "--in-memory", "--non-interactive", "--page_pool_max_size", "268435456"]);
  await until(async () => {
    db.check();
    try { return (await fetch(dbBase + "/v1/identity", { method: "POST", signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, "Isolated SpacetimeDB did not start");
  await exec(cli, ["publish", "-s", dbBase, "--module-path", "server/spacetime", "--anonymous", "--delete-data=never",
    "--no-config", "--yes=skip-login", database], { cwd: repo, timeout: 90000 });
  const env = { ...process.env, UPLOAD_STORAGE: "local", UPLOAD_HOST: "127.0.0.1", PORT: String(apiPort),
    STDB_HTTP_URL: dbBase, STDB_DATABASE: database, PUBLIC_ORIGIN: base, LOCAL_UPLOAD_DIR: join(directory, "uploads"),
    PIPELINE_IDENTITY: "", UPLOAD_ALLOWED_ORIGINS: "https://memos.example" };
  let workerIdentity = '';
  const startApi = async () => {
    const workerDirectory = globalThis.process.env.UPLOAD_TEST_WORKER_DIR;
    const useR2 = workerDirectory || globalThis.process.env.UPLOAD_TEST_R2 === '1';
    const args = useR2 ? [
      ...(workerDirectory ? ["--import", join(workerDirectory, "scripts/sites-env.mjs")] : []),
      join(workerDirectory || repo, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local",
      "--config", workerDirectory ? join(workerDirectory, "dist/server/wrangler.json") : join(repo, "server/upload/wrangler.jsonc"), "--persist-to", join(directory, "r2"),
      "--ip", "127.0.0.1", "--port", String(apiPort), "--inspector-port", "0",
      "--var", `STDB_HTTP_URL:${dbBase}`, "--var", `STDB_DATABASE:${database}`,
      "--var", `PUBLIC_ORIGIN:${base}`, "--var", "UPLOAD_SIGNING_SECRET:isolated-worker-test-secret-not-a-deployment-secret",
      "--var", `PIPELINE_IDENTITY:${workerIdentity}`,
    ] : ["server/upload/start.mjs"];
    const process = launch(globalThis.process.execPath, args, env);
    await until(async () => { process.check(); try { return (await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, "Upload API did not start");
    return process.child;
  };
  let api = await startApi();
  const call = async (path: string, body?: object, key?: string, status = 200) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, result.error ?? `Unexpected status for ${path}`);
    return result;
  };
  const config = await call("/api/account/config");
  assert.equal(config.server, dbBase); assert.equal(config.database, database);
  const account = await call("/api/account", { displayName: "Phone API test" });
  const decoded = decodeAccountKey(account.personalKey, { server: dbBase, database, uri: dbBase.replace("http:", "ws:") });
  assert.equal(decoded.identity, account.identity); assert.equal(decoded.token, account.token);
  const restored = await call("/api/account", { personalKey: encodeAccountKey(decoded) });
  assert.equal(restored.identity, account.identity); assert.equal(restored.displayName, "Phone API test");
  assert.equal((await call("/api/account", undefined, account.personalKey)).provider, "key");
  await call("/api/account", { personalKey: encodeAccountKey({ ...decoded, database: "wrong-db" }) }, undefined, 401);
  console.log("PASS accounts: configured destination, create/restore/get, website key compatibility, wrong-database rejection");

  const viewer = await new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Viewer subscription timeout")), 15000);
    const conn = DbConnection.builder().withUri(dbBase.replace("http:", "ws:")).withDatabaseName(database).withToken(account.token)
      .withCompression("none")
      .onConnect(c => c.subscriptionBuilder().onApplied(() => { clearTimeout(timer); resolve(c); }).onError(() => reject(new Error("Subscription failed"))).subscribeToAllTables())
      .onConnectError((_c, e) => { clearTimeout(timer); reject(e); }).build();
    clients.push(conn);
  });
  assert.equal(viewer.db.profile.identity.find(viewer.identity!)?.displayName, "Phone API test");
  assert.equal(viewer.db.profile.identity.find(viewer.identity!)?.provider, "key");
  const bytes = await readFile(join(repo, "apps/ios/CameraAccess/TestResources/plant.mp4"));
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const prepared = await call("/api/uploads/presign", { name: "plant.mp4", type: "video/mp4", size: bytes.length,
    title: "[API test] MP4 transport fixture", durationSec: 5, pipeline: false }, account.personalKey);
  await call("/api/uploads/complete", { receipt: prepared.receipt }, account.personalKey, 400);
  const put = await fetch(prepared.putUrl, { method: "PUT", headers: prepared.headers, body: bytes });
  assert.equal(put.status, 200);
  // Restart between PUT and completion: persisted receipts and storage survive a deploy/restart.
  await stop(api); api = await startApi();
  const completed = await call("/api/uploads/complete", { receipt: prepared.receipt }, account.personalKey);
  assert.equal(completed.status, "uploaded");
  const repeated = await call("/api/uploads/complete", { receipt: prepared.receipt }, account.personalKey);
  assert.equal(repeated.memory.id, completed.memory.id);
  const rows = (await call("/api/memories", undefined, account.personalKey)).memories;
  assert.equal(rows.length, 1); assert.equal(rows[0].requestId, prepared.requestId);
  assert.equal(rows[0].pipelineIdentity, account.identity, "test upload must not enter the GPU queue");
  const source = await fetch(rows[0].sourceUrl);
  assert.equal(source.status, 200); assert.equal(sha(Buffer.from(await source.arrayBuffer())), sha(bytes));
  const range = await fetch(rows[0].sourceUrl, { headers: { Range: "bytes=0-1023" } });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024));
  const uploadedMemory = () => [...viewer.db.memory.iter()].find(row => row.requestId === prepared.requestId);
  await until(uploadedMemory, "Uploaded memory missing from viewer subscription");
  assert.equal(uploadedMemory()!.owner.toHexString(), account.identity);
  console.log("PASS upload: real MP4 PUT, restart, completion, one database row, identical downloaded bytes, live viewer subscription");

  const second = await call("/api/account", { name: "Second user" });
  assert.deepEqual((await call("/api/memories", undefined, second.personalKey)).memories, []);
  await call(`/api/memories?identity=${account.identity}`, undefined, second.personalKey, 401);
  await call("/api/uploads/complete", { receipt: prepared.receipt }, second.personalKey, 403);
  await call("/api/uploads/presign", { identity: second.identity, name: "clip.mp4", type: "video/mp4", size: bytes.length,
    title: "wrong owner", durationSec: 5 }, account.personalKey, 401);
  const legacy = await call("/api/identity", {});
  const promoted = await call("/api/account", { identity: legacy.identity, name: "Legacy phone" }, legacy.token);
  assert.equal(promoted.identity, legacy.identity);
  assert.equal((await call(`/api/account?identity=${legacy.identity}`, undefined, legacy.token)).provider, "key");
  assert.equal((await call(`/api/memories?identity=${account.identity}`, undefined, account.token)).memories.length, 1);
  console.log("PASS ownership: second account isolation, receipt/identity tampering rejected, legacy token promotion and listing");
  if (process.env.UPLOAD_TEST_NATIVE_BIN) {
    let dropped = false;
    const proxy = createServer(async (req, res) => {
      try {
        const data: Buffer[] = []; for await (const chunk of req) data.push(chunk);
        const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
        const response = await fetch(base + req.url, { method: req.method, headers: headers as Record<string, string>,
          ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Buffer.concat(data) } : {}) });
        const body = Buffer.from(await response.arrayBuffer());
        if (req.url === '/api/uploads/complete' && response.ok && !dropped) {
          dropped = true; res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'TEST: confirmation deliberately lost' })); return;
        }
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' }); res.end(body);
      } catch { res.writeHead(502); res.end(); }
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const address = `http://127.0.0.1:${(proxy.address() as {port:number}).port}`;
      const native = await exec(process.env.UPLOAD_TEST_NATIVE_BIN, [join(repo, 'apps/ios/CameraAccess/TestResources/plant.mp4'), address, join(directory, 'native-queue')], { timeout: 60000 });
      console.log(native.stdout.trim());
      assert.ok(dropped);
      console.log('PASS actual Swift uploader: no-worker storage fallback and durable retry against the real API');
    } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
  }
  if (process.env.UPLOAD_TEST_WORKER_DIR || process.env.UPLOAD_TEST_R2 === '1') {
    const worker = await (await fetch(dbBase + '/v1/identity', { method: 'POST' })).json();
    workerIdentity = worker.identity.replace(/^0x/, '');
    await stop(api); api = await startApi();
    const job = await call('/api/uploads/presign', { name: 'plant.mp4', type: 'video/mp4', size: bytes.length,
      title: '[Synthetic worker test] transport only', durationSec: 6, pipeline: true }, account.personalKey);
    assert.equal((await fetch(job.putUrl, { method: 'PUT', headers: job.headers, body: bytes })).status, 200);
    const queued = await call('/api/uploads/complete', { receipt: job.receipt }, account.personalKey);
    assert.equal(queued.memory.pipelineIdentity, workerIdentity);
    await call('/api/pipeline/assets/start', { memoryId: queued.memory.id, path: 'memory.json', size: 2 }, account.token, 401);
    const reducer = async (args: unknown[]) => {
      const result = await fetch(`${dbBase}/v1/database/${database}/call/set_memory_status`, {
        method: 'POST', headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      });
      assert.equal(result.status, 200, await result.text());
    };
    await reducer([Number(queued.memory.id), 'processing', 0.1, '', '']);
    const sceneDir = await mkdtemp(join(directory, 'synthetic-scene-'));
    await writeFile(join(sceneDir, 'memory.json'), await readFile(join(repo, 'apps/web/public/demo/memory.json')));
    // Include an actual multipart asset > the old 90 MiB request cap. This is test data, not reconstructed geometry.
    const scene = JSON.parse(await readFile(join(sceneDir, 'memory.json'), 'utf8'));
    scene.background.url = 'transport-fixture.spz';
    await writeFile(join(sceneDir, 'memory.json'), JSON.stringify(scene));
    const large = Buffer.alloc(91 * 1024 ** 2 + 17, 37);
    await writeFile(join(sceneDir, 'transport-fixture.spz'), large);
    const python = await exec('python3', ['-c',
      'from pathlib import Path; import sys; from memreplay.hosted_publish import preflight, publish_hosted; preflight(); print(publish_hosted(Path(sys.argv[1]), int(sys.argv[2])))',
      sceneDir, queued.memory.id], { cwd: repo, timeout: 180000, maxBuffer: 4096,
      env: { ...process.env, PYTHONPATH: join(repo, 'pipeline'), STDB_HTTP_URL: dbBase, STDB_DATABASE: database,
        PIPELINE_IDENTITY: workerIdentity, PIPELINE_TOKEN: worker.token, MEMREPLAY_UPLOAD_API: base } });
    const manifestUrl = python.stdout.trim();
    assert.ok(manifestUrl.startsWith(base + '/media/scenes/'));
    const manifest = await (await fetch(manifestUrl)).json();
    const asset = await fetch(new URL(manifest.background.url, manifestUrl));
    assert.equal(asset.status, 200); assert.equal(sha(Buffer.from(await asset.arrayBuffer())), sha(large));
    await reducer([Number(queued.memory.id), 'ready', 1, manifestUrl, '']);
    await until(() => viewer.db.memory.id.find(BigInt(queued.memory.id))?.status === 'ready', 'Ready scene not received over WebSocket');
    const ready = viewer.db.memory.id.find(BigInt(queued.memory.id))!;
    assert.equal(ready.owner.toHexString(), account.identity); assert.equal(ready.manifestUrl, manifestUrl);
    assert.equal((await call('/api/memories', undefined, second.personalKey)).memories.length, 0);
    console.log('PASS Runpod bridge: assigned worker auth, actual Python publisher, 91 MiB multipart R2 asset, byte equality, manifest, ready status and owner/viewer sync');
    if (process.env.UPLOAD_TEST_SCENE_BIN) {
      let dropped = false, configReads = 0;
      const proxy = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
          const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
          const response = await fetch(base + req.url, { method: req.method, headers: headers as Record<string, string>,
            ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Buffer.concat(chunks) } : {}) });
          let body = Buffer.from(await response.arrayBuffer());
          // The app first signs in before the worker is enabled; upload must refresh config.
          if (req.url === '/api/account/config' && ++configReads === 1) {
            body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), pipelineAvailable: false }));
          }
          if (req.url === '/api/uploads/complete' && response.ok && !dropped) {
            dropped = true; res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'TEST: committed completion response lost' })); return;
          }
          res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' }); res.end(body);
        } catch { res.writeHead(502); res.end(); }
      });
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
      const nativeReport = join(directory, 'scene-native.json');
      try {
        const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
        const native = await exec(process.env.UPLOAD_TEST_SCENE_BIN, ['--api', origin, '--directory', join(directory, 'scene-native'),
          '--output', nativeReport, '--expect-lost-confirmation'], { timeout: 90000 });
        console.log(native.stdout.trim()); assert.ok(dropped); assert.ok(configReads >= 2);
      } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
      const report = JSON.parse(await readFile(nativeReport, 'utf8'));
      const rows = (await call('/api/memories', undefined, report.personalKey)).memories;
      assert.equal(rows.length, 1, 'Lost completion must not duplicate the phone recording');
      assert.equal(rows[0].pipelineIdentity, workerIdentity); assert.equal(rows[0].pipeline, true);
      const statuses = new Set<string>();
      const onUpdate = (_context: unknown, _old: unknown, row: { id: bigint; status: string }) => {
        if (row.id === BigInt(report.memoryId)) statuses.add(row.status);
      };
      viewer.db.memory.onUpdate(onUpdate);
      const workerEnv = { ...process.env, PYTHONPATH: join(repo, 'pipeline'), STDB_HTTP_URL: dbBase, STDB_DATABASE: database,
        PIPELINE_IDENTITY: workerIdentity, PIPELINE_TOKEN: worker.token, MEMREPLAY_UPLOAD_API: base,
        ASSET_BASE_URL: base + '/media', MEMREPLAY_WORK: join(directory, 'pipeline-work') };
      const processed = await exec('python3', ['scripts/test-pipeline-worker.py', report.memoryId, report.sourceSHA256],
        { cwd: repo, timeout: 60000, env: workerEnv });
      console.log(processed.stdout.trim());
      await until(() => viewer.db.memory.id.find(BigInt(report.memoryId))?.status === 'ready', 'Native upload did not become ready');
      viewer.db.memory.removeOnUpdate(onUpdate);
      assert.ok(statuses.has('processing')); assert.ok(statuses.has('ready'));
      const finished = (await call('/api/memories', undefined, report.personalKey)).memories[0];
      assert.equal(finished.id, report.memoryId); assert.equal(finished.status, 'ready'); assert.equal(finished.progress, 1);
      assert.ok(finished.manifestUrl.startsWith(base + '/media/scenes/'));
      assert.equal((await fetch(finished.manifestUrl)).status, 200);
      assert.equal(viewer.db.memory.id.find(BigInt(report.memoryId))!.owner.toHexString(), report.identity);
      // A failing reconstruction must become failed, with no ready manifest or misleading exit status.
      const failedTicket = await call('/api/uploads/presign', { name: 'failure.mp4', type: 'video/mp4', size: bytes.length,
        title: '[TEST] deliberate GPU failure', durationSec: 6, pipeline: true }, report.personalKey);
      assert.equal((await fetch(failedTicket.putUrl, { method: 'PUT', headers: failedTicket.headers, body: bytes })).status, 200);
      const failedJob = await call('/api/uploads/complete', { receipt: failedTicket.receipt }, report.personalKey);
      await assert.rejects(exec('python3', ['scripts/test-pipeline-worker.py', failedJob.memory.id, sha(bytes), '--fail'],
        { cwd: repo, timeout: 60000, env: workerEnv }));
      const failed = (await call('/api/memories', undefined, report.personalKey)).memories.find((m: {id:string}) => m.id === failedJob.memory.id);
      assert.equal(failed.status, 'failed'); assert.equal(failed.manifestUrl, ''); assert.match(failed.error, /Deliberate GPU-stage failure/);
      console.log('PASS integrated phone → R2 → SpacetimeDB → Python worker → scene publication → ready/API/WebSocket; failure reporting verified. GPU computation substituted only.');
    }
  }
  console.log("PASS all phone API checks. Local SpacetimeDB and storage only; no cloud deployment or GPU reconstruction was performed.");
} finally { await cleanup(); }
