/** Cloudflare transport for the same upload/account core used by the Node server. */
import { makeHandler, databaseConfig, ticket, readTicket } from "./core.mjs";
import { pipelineRequest, sceneKey } from './pipeline.mjs';
import { sceneImportRequest, importedSceneKey } from './scene-import.mjs';

export const HOSTED_MAX_UPLOAD_BYTES = 90 * 1024 ** 2;
const videoKey = /^videos\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(mp4|mov|webm)$/;
const result = (status, data, headers = {}) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
});

/** Keep the HTTP-independent account/upload logic identical to server/upload/service.mjs. */
export async function fetchHandler(handler, request) {
  const headers = new Headers(); let status = 200, body = null;
  const url = new URL(request.url);
  await handler({
    method: request.method, url: url.pathname + url.search,
    headers: Object.fromEntries(request.headers),
    async *[Symbol.asyncIterator]() {
      if (!request.body) return;
      const reader = request.body.getReader();
      try {
        while (true) { const part = await reader.read(); if (part.done) break; yield Buffer.from(part.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    },
  }, {
    setHeader: (name, value) => headers.set(name, value),
    writeHead(code, fields = {}) { status = code; for (const [name, value] of Object.entries(fields)) headers.set(name, value); },
    end(value) { body = value ?? null; },
  });
  return new Response(body, { status, headers });
}

function settings(env) {
  if (!env.BUCKET || !env.UPLOAD_SIGNING_SECRET || env.UPLOAD_SIGNING_SECRET.length < 32)
    throw new Error("Upload storage is not configured");
  const url = new URL(env.PUBLIC_ORIGIN);
  if (!["https:", "http:"].includes(url.protocol) || url.origin !== env.PUBLIC_ORIGIN)
    throw new Error("PUBLIC_ORIGIN must be an origin");
  const pipelineEnabled = /^[a-f0-9]{64}$/i.test(env.PIPELINE_IDENTITY || "");
  const allowedOrigins = (env.UPLOAD_ALLOWED_ORIGINS || url.origin).split(",").map(s => s.trim()).filter(Boolean);
  return { origin: url.origin, pipelineEnabled, allowedOrigins };
}

export function hostedConfig(env) {
  const config = settings(env);
  return {
    ...databaseConfig(env), secret: env.UPLOAD_SIGNING_SECRET,
    assetBase: `${config.origin}/media`, allowedOrigins: config.allowedOrigins,
    pipelineIdentity: env.PIPELINE_IDENTITY || "", pipelineEnabled: config.pipelineEnabled,
    maxUploadBytes: HOSTED_MAX_UPLOAD_BYTES,
    sign: async data => `${config.origin}/api/uploads/put?ticket=${encodeURIComponent(ticket({
      kind: "r2-put", key: data.key, size: data.size, type: data.type, expires: Date.now() + 900_000,
    }, env.UPLOAD_SIGNING_SECRET))}`,
    head: async key => {
      const object = await env.BUCKET.head(key);
      if (!object) throw new Error("Upload not found; PUT the video first");
      return { size: object.size, type: object.httpMetadata?.contentType };
    },
  };
}

async function putVideo(request, env, config) {
  const origin = request.headers.get("Origin");
  const cors = { "Access-Control-Allow-Methods": "PUT,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
  if (origin && !config.allowedOrigins.includes(origin)) return result(403, { error: "Origin not allowed" });
  if (origin) cors["Access-Control-Allow-Origin"] = origin;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "PUT") return result(405, { error: "Use PUT" }, cors);
  let upload;
  try { upload = readTicket(new URL(request.url).searchParams.get("ticket"), env.UPLOAD_SIGNING_SECRET); }
  catch { return result(401, { error: "Invalid or expired upload URL" }, cors); }
  if (upload.kind !== "r2-put" || !videoKey.test(upload.key) || !Number.isSafeInteger(upload.size) ||
      upload.size <= 0 || upload.size > HOSTED_MAX_UPLOAD_BYTES ||
      !["video/mp4", "video/quicktime", "video/webm"].includes(upload.type))
    return result(401, { error: "Invalid upload URL" }, cors);
  const length = request.headers.get("Content-Length");
  if (length === null) return result(411, { error: "Use a file upload with Content-Length" }, cors);
  if (Number(length) !== upload.size || request.headers.get("Content-Type") !== upload.type || !request.body)
    return result(400, { error: "Video size or Content-Type does not match the presign request" }, cors);
  // R2 commits atomically and refuses an overwrite, including concurrent/replayed PUTs.
  // The body streams to storage; it is never buffered in the 128 MB Worker isolate.
  const object = await env.BUCKET.put(upload.key, request.body, {
    httpMetadata: { contentType: upload.type }, onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!object) return result(409, { error: "Video already uploaded; call /api/uploads/complete with the original receipt" }, cors);
  return result(200, { stored: true, size: object.size }, cors);
}

/** Public recording URLs match the existing shared library. No listing or arbitrary R2 keys. */
async function getVideo(request, env) {
  if (!["GET", "HEAD"].includes(request.method)) return result(405, { error: "Use GET or HEAD" });
  const key = new URL(request.url).pathname.slice("/media/".length);
  if (!videoKey.test(key) && !sceneKey(key) && !importedSceneKey(key)) return result(404, { error: "Media not found" });
  const meta = await env.BUCKET.head(key);
  if (!meta) return result(404, { error: "Video not found" });
  const headers = new Headers({
    "Content-Type": meta.httpMetadata?.contentType || "application/octet-stream",
    "Accept-Ranges": "bytes", "Content-Length": String(meta.size), ETag: meta.httpEtag,
    "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length,Content-Range,ETag",
    "Cache-Control": sceneKey(key) ? "no-cache" : "public,max-age=3600,immutable", "X-Content-Type-Options": "nosniff",
  });
  const value = request.headers.get("Range"); let range;
  if (value && request.method === "GET") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    let start, end;
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, meta.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), meta.size - 1) : meta.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= meta.size) {
      headers.set("Content-Range", `bytes */${meta.size}`); headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    range = { offset: start, length: end - start + 1 };
    headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);
    headers.set("Content-Length", String(range.length));
  }
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await env.BUCKET.get(key, range ? { range } : {});
  if (!object) return result(404, { error: "Video not found" });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function handleHostedRequest(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/") && !path.startsWith("/media/")) return null;
  try {
    const config = settings(env);
    if (path.startsWith('/api/scenes/')) return await sceneImportRequest(request, env);
    if (path.startsWith('/api/pipeline/')) return await pipelineRequest(request, env);
    if (path === "/api/uploads/put") return await putVideo(request, env, config);
    if (path.startsWith("/media/")) return await getVideo(request, env);
    return await fetchHandler(makeHandler(hostedConfig(env)), request);
  } catch {
    return result(503, { error: "Upload service unavailable; please retry" });
  }
}
