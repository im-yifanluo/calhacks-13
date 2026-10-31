/** Explicit public smoke test. Uploads only the repository's non-private MP4 fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DbConnection } from "../../apps/web/src/module_bindings";
import { decodeAccountKey } from "../../apps/web/src/account/key";
const base = process.argv[2];
if (!base || new URL(base).protocol !== "https:" || new URL(base).origin !== base)
  throw new Error("Usage: npx tsx tests/e2e/upload-public.ts https://<API-origin>");
const statePath = "data/public-upload-test.private.json";
await mkdir("data", { recursive: true });
let state: any = {};
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch (e: any) {
  if (e.code !== "ENOENT") throw e;
}
if (state.base && state.base !== base)
  throw new Error("Existing test account belongs to another origin; use a separate checkout.");
const save = () => writeFile(statePath, JSON.stringify({ ...state, base }, null, 2), { mode: 0o600 });
async function call(path: string, body?: object, key?: string, expected = 200) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${data.error || response.status}`);
  return data;
}
const config = await call("/api/account/config");
assert.equal(config.server, "https://maincloud.spacetimedb.com");
assert.equal(config.database, "jerry-memory-replay-phone-20261024");
assert.equal(config.pipelineAvailable, false);
if (!state.account) {
  state.account = await call("/api/account", { displayName: "Memos upload verification" });
  await save();
}
const account = state.account;
assert.equal(
  decodeAccountKey(account.personalKey, { ...config, uri: config.server.replace("https:", "wss:") }).identity,
  account.identity,
);
assert.equal((await call("/api/account", { personalKey: account.personalKey })).identity, account.identity);
assert.equal((await call("/api/account", undefined, account.personalKey)).provider, "key");
await call("/api/memories", undefined, "invalid", 401);
console.log("PASS public HTTPS and account create/restore/get; same website database and password format");
const bytes = await readFile("tests/fixtures/plant.mp4");
if (!state.prepared || (!state.completed && state.prepared.receiptExpiresAt <= Date.now())) {
  state.prepared = await call(
    "/api/uploads/presign",
    {
      name: "plant.mp4",
      type: "video/mp4",
      size: bytes.length,
      title: "[API verification] Sample plant video",
      durationSec: 5,
      pipeline: false,
    },
    account.personalKey,
  );
  state.uploaded = false;
  await save();
}
if (!state.uploaded) {
  const response = await fetch(state.prepared.putUrl, {
    method: "PUT",
    headers: state.prepared.headers,
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200, "R2 PUT failed");
  state.uploaded = true;
  await save();
}
if (!state.completed) {
  state.completed = await call("/api/uploads/complete", { receipt: state.prepared.receipt }, account.personalKey);
  await save();
}
const completed = state.completed;
if (state.prepared.receiptExpiresAt > Date.now()) {
  const duplicate = await call("/api/uploads/complete", { receipt: state.prepared.receipt }, account.personalKey);
  assert.equal(duplicate.memory.id, completed.memory.id);
}
const list = await call("/api/memories", undefined, account.personalKey);
assert.equal(list.memories.filter((row: any) => row.requestId === state.prepared.requestId).length, 1);
assert.equal(completed.memory.pipelineIdentity, account.identity);
const download = await fetch(completed.memory.sourceUrl, { signal: AbortSignal.timeout(60000) });
assert.equal(download.status, 200);
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(bytes));
const range = await fetch(completed.memory.sourceUrl, { headers: { Range: "bytes=0-1023" } });
assert.equal(range.status, 206);
assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024));
console.log(
  "PASS public R2 PUT, completion, duplicate prevention, owner listing, exact downloaded bytes, Safari range",
);
let viewer: DbConnection | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Maincloud viewer verification timed out")), 30000);
    viewer = DbConnection.builder()
      .withUri(config.server.replace("https:", "wss:"))
      .withDatabaseName(config.database)
      .withToken(account.token)
      .withCompression("none")
      .onConnect((c) =>
        c
          .subscriptionBuilder()
          .onApplied(() => {
            try {
              assert.equal(c.identity?.toHexString(), account.identity);
              assert.equal(c.db.profile.identity.find(c.identity!)?.displayName, account.displayName);
              const memory = [...c.db.memory.iter()].find((row) => row.requestId === state.prepared.requestId);
              assert.equal(memory?.id.toString(), completed.memory.id);
              assert.equal(memory?.owner.toHexString(), account.identity);
              assert.equal(memory?.sourceUrl, completed.memory.sourceUrl);
              clearTimeout(timer);
              resolve();
            } catch (e) {
              clearTimeout(timer);
              reject(e);
            }
          })
          .onError(() => {
            clearTimeout(timer);
            reject(new Error("Maincloud subscription failed"));
          })
          .subscribeToAllTables(),
      )
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        reject(e);
      })
      .build();
  });
  console.log("PASS live Maincloud WebSocket: website SDK sees the same profile, owner, recording ID and URL");
} finally {
  viewer?.disconnect();
}
const proof = {
  checkedAt: new Date().toISOString(),
  base,
  database: config.database,
  server: config.server,
  memoryId: completed.memory.id,
  requestId: state.prepared.requestId,
  sourceUrl: completed.memory.sourceUrl,
  fixtureBytes: bytes.length,
  sha256: sha(bytes),
  maxUploadBytes: config.maxUploadBytes,
  pipeline: false,
  publicUpload: true,
  sameDatabaseAndAccount: true,
  rangePlayback: true,
};
await writeFile("data/public-upload-verification.json", JSON.stringify(proof, null, 2) + "\n");
console.log(JSON.stringify(proof, null, 2));
