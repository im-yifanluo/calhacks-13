/** Account-owned, immutable rendered bundles. Registration happens after asset verification. */
import { randomUUID } from "node:crypto";
import { ApiError, credentials, accountSettings } from "./accounts.mjs";
import { databaseConfig, ticket, readTicket } from "./core.mjs";

const types = {
  json: "application/json",
  spz: "application/octet-stream",
  ply: "application/octet-stream",
  bin: "application/octet-stream",
  glb: "model/gltf-binary",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const pathOK = (p) =>
  typeof p === "string" &&
  p.length <= 500 &&
  p.split("/").every((s) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)) &&
  Object.hasOwn(types, p.split(".").at(-1));
export const importedSceneKey = (key) =>
  /^imports\/[a-f0-9]{64}\/[a-f0-9-]{36}\//.test(key) && pathOK(key.split("/").slice(3).join("/"));
const fail = (code, message) => {
  throw new ApiError(code, message);
};
const response = (status, data) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const maxBytes = 64 * 1024 ** 2;
async function body(request) {
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Send JSON");
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) fail(413, "Request too large");
      parts.push(Buffer.from(value));
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      fail(400, "Send JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(400, "Send a JSON object");
    return parsed;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function unpack(value, env, kind) {
  let data;
  try {
    data = readTicket(value, env.UPLOAD_SIGNING_SECRET);
  } catch {
    fail(401, "Invalid or expired scene receipt");
  }
  if (data.kind !== kind || !/^[a-f0-9]{64}$/.test(data.owner) || !uuid.test(data.requestId))
    fail(401, "Invalid scene receipt");
  return data;
}
export function sceneReferences(manifest) {
  const refs = new Set();
  const add = (p) => {
    if (!pathOK(p)) fail(400, "Scene references must be safe relative paths");
    refs.add(p);
    if (refs.size > 256) fail(400, "At most 256 referenced assets per scene");
  };
  const visit = (v, depth = 0) => {
    if (depth > 40) fail(400, "Scene nesting is too deep");
    if (!v || typeof v !== "object") return;
    if (v.kind === "splat-sequence") {
      if (!Number.isInteger(v.frameCount) || v.frameCount < 1 || v.frameCount > 256 || typeof v.urlPattern !== "string")
        fail(400, "Invalid splat sequence");
      for (let i = 0; i < v.frameCount; i++) add(v.urlPattern.replace("{frame}", String(i)));
    }
    for (const [k, item] of Object.entries(v)) {
      if (["url", "audioUrl", "videoUrl", "colliderUrl"].includes(k) && item) add(item);
      else if (typeof item === "object") visit(item, depth + 1);
    }
  };
  if (
    !manifest?.background?.url ||
    !Number.isFinite(manifest?.timeline?.durationSec) ||
    manifest.timeline.durationSec <= 0 ||
    manifest.timeline.durationSec > 3600
  )
    fail(400, "Scene needs a background and a valid timeline");
  visit(manifest);
  return [...refs];
}
export async function sceneImportRequest(request, env) {
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (
      origin &&
      !(env.UPLOAD_ALLOWED_ORIGINS || env.PUBLIC_ORIGIN)
        .split(",")
        .map((s) => s.trim())
        .includes(origin)
    )
      fail(403, "Origin not allowed");
    if (url.pathname === "/api/scenes/put" && request.method === "PUT") {
      const d = unpack(url.searchParams.get("ticket"), env, "scene-file");
      if (
        !importedSceneKey(d.key) ||
        !Number.isSafeInteger(d.size) ||
        d.size < 1 ||
        d.size > maxBytes ||
        Number(request.headers.get("Content-Length")) !== d.size ||
        !request.body
      )
        fail(400, "Incorrect asset size");
      const stored = await env.BUCKET.put(d.key, request.body, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: types[d.key.split(".").at(-1)] },
      });
      if (!stored) fail(409, "Asset already uploaded");
      return response(200, { stored: true, size: stored.size });
    }
    if (request.method !== "POST") fail(405, "Use POST");
    const input = await body(request),
      db = databaseConfig(env);
    const account = credentials(request.headers.get("Authorization"), input.identity, accountSettings(env));
    const auth = "Bearer " + account.token;
    if (!(await db.verify(account.identity, auth))) fail(401, "Account rejected");
    if (url.pathname === "/api/scenes/start") {
      const requestId = input.requestId || randomUUID();
      if (!uuid.test(requestId) || typeof input.title !== "string" || !input.title.trim() || input.title.length > 120)
        fail(400, "Use a UUID request ID and a scene title");
      const d = {
        kind: "scene-bundle",
        owner: account.identity,
        requestId,
        title: input.title.trim(),
        expires: Date.now() + 86400000,
      };
      return response(200, { receipt: ticket(d, env.UPLOAD_SIGNING_SECRET), requestId });
    }
    const d = unpack(input.receipt, env, "scene-bundle");
    if (d.owner !== account.identity) fail(403, "Scene belongs to another account");
    const prefix = `imports/${d.owner}/${d.requestId}/`;
    if (url.pathname === "/api/scenes/presign") {
      if (!pathOK(input.path) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > maxBytes)
        fail(400, "Use a supported relative path and asset size up to 64 MiB");
      const key = prefix + input.path;
      const existing = await env.BUCKET.head(key);
      if (existing) {
        if (existing.size !== input.size) fail(409, "Existing asset has a different size; start a new import");
        return response(200, { stored: true, size: existing.size });
      }
      const signed = ticket({ ...d, kind: "scene-file", key, size: input.size }, env.UPLOAD_SIGNING_SECRET);
      return response(200, {
        putUrl: `${env.PUBLIC_ORIGIN}/api/scenes/put?ticket=${encodeURIComponent(signed)}`,
        headers: { "Content-Type": types[input.path.split(".").at(-1)] },
      });
    }
    if (url.pathname !== "/api/scenes/complete") fail(404, "Unknown scene route");
    const entry = input.manifest || "memory.json";
    if (!["memory.json", "memory.static.json"].includes(entry)) fail(400, "Choose memory.json or memory.static.json");
    const object = await env.BUCKET.get(prefix + entry);
    if (!object || object.size > 8 * 1024 ** 2) fail(400, "Upload the scene manifest first (maximum 8 MiB)");
    let manifest;
    try {
      manifest = await object.json();
    } catch {
      fail(400, "Invalid scene JSON");
    }
    const refs = sceneReferences(manifest);
    for (const path of refs) {
      const asset = await env.BUCKET.head(prefix + path);
      if (!asset?.size) fail(400, "Missing scene asset: " + path);
    }
    const manifestUrl = `${env.PUBLIC_ORIGIN}/media/${prefix}${entry}`;
    // A distinct request ID allows the static alternative to be registered separately.
    await db.createMemory(
      {
        requestId: d.requestId,
        title: d.title,
        sourceUrl: "",
        manifestUrl,
        durationUs: Math.round(manifest.timeline.durationSec * 1e6),
      },
      auth,
      account.identity,
    );
    const memory = (await db.listMemories(account.identity, auth)).find((m) => m.requestId === d.requestId);
    if (!memory) fail(502, "Scene registration not visible yet; retry completion");
    return response(200, { memory, assets: refs.length, manifestUrl });
  } catch (e) {
    return response(e instanceof ApiError ? e.status : 502, {
      error: e instanceof ApiError ? e.message : "Scene import failed; retry",
    });
  }
}
