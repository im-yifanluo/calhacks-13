import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
const [file, seconds] = process.argv.slice(2);
const durationSec = Number(seconds),
  base = (process.env.APP_ORIGIN || "http://127.0.0.1:5173").replace(/\/$/, "");
if (!file || !Number.isFinite(durationSec) || durationSec <= 0)
  throw new Error(
    "Usage: npm run test:video -- /path/to/video.mp4 DURATION_SECONDS",
  );
const bytes = await readFile(file),
  hash = createHash("sha256").update(bytes).digest("hex");
const authResponse = await fetch(`${base}/api/identity`, { method: "POST" });
assert.ok(authResponse.ok, "Start the upload service and app first");
const auth = await authResponse.json(),
  identity = auth.identity.replace(/^0x/, "");
const headers = {
  Authorization: `Bearer ${auth.token}`,
  "Content-Type": "application/json",
};
async function api(path: string, body: unknown) {
  const response = await fetch(base + path, {
    method: "POST",
    headers,
    body: JSON.stringify({ identity, ...(body as any) }),
  });
  const value = await response.json();
  assert.ok(response.ok, value.error || String(response.status));
  return value;
}
const prepared = await api("/api/uploads/presign", {
  name: basename(file),
  type:
    extname(file).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4",
  size: bytes.length,
  title: `Video verification ${new Date().toISOString()}`,
  durationSec,
});
assert.ok(
  (
    await fetch(prepared.putUrl, {
      method: "PUT",
      headers: prepared.headers,
      body: bytes,
    })
  ).ok,
  "Video PUT failed",
);
console.log(`PASS 1/4: uploaded ${bytes.length} video bytes`);
const completed = await api("/api/uploads/complete", {
  receipt: prepared.receipt,
});
assert.ok(completed.memory?.id, "No database row confirmed");
const list = await fetch(`${base}/api/memories?identity=${identity}`, {
  headers,
});
assert.ok(list.ok);
const rows = (await list.json()).memories;
const row = rows.find((m: any) => m.requestId === prepared.requestId);
assert.equal(row?.id, completed.memory.id);
assert.equal(row?.status, "uploaded");
console.log(
  `PASS 2/4: independent database query found memory #${row.id}, status=${row.status}`,
);
const response = await fetch(row.sourceUrl);
assert.ok(response.ok, "Stored video could not be retrieved");
const retrieved = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(retrieved).digest("hex"), hash);
assert.equal(retrieved.length, bytes.length);
console.log(
  `PASS 3/4: downloaded video is byte-for-byte identical (SHA-256 ${hash})`,
);
const retry = await api("/api/uploads/complete", { receipt: prepared.receipt });
assert.equal(retry.memory.id, row.id);
console.log("PASS 4/4: repeated completion returns the same database row");
console.log(
  `Watch the stored recording: ${base}/capture.html?request=${prepared.requestId}`,
);
