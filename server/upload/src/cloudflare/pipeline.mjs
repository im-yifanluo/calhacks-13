/** Runpod → managed R2 bridge. Only the assigned, verified SpacetimeDB worker may publish. */
import { randomUUID } from "node:crypto";
import { ApiError } from "../accounts.mjs";
import { databaseConfig } from "../database.mjs";
import { readTicket, ticket } from "../tickets.mjs";

export const SCENE_PART_BYTES = 16 * 1024 ** 2;
export const MAX_SCENE_ASSET_BYTES = 2 * 1024 ** 3;
const types = {
  json: "application/json",
  spz: "application/octet-stream",
  ply: "application/octet-stream",
  glb: "model/gltf-binary",
  bin: "application/octet-stream",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};
const pathOK = (path) =>
  typeof path === "string" &&
  path.length <= 500 &&
  path.split("/").every((p) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p)) &&
  Object.hasOwn(types, path.split(".").at(-1));
export const sceneKey = (key) =>
  /^scenes\/[1-9][0-9]*-[a-f0-9-]{36}\//.test(key) && pathOK(key.split("/").slice(2).join("/"));
const hex = (v) =>
  String(Array.isArray(v) ? v[0] : v)
    .replace(/^0x/, "")
    .toLowerCase();
const json = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function body(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Send a JSON object");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 32768) throw new ApiError(413, "Request too large");
      chunks.push(Buffer.from(part.value));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError(400, "Send a JSON object");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function worker(request, env, memoryId) {
  if (!/^[a-f0-9]{64}$/.test(env.PIPELINE_IDENTITY || ""))
    throw new ApiError(503, "Reconstruction worker is not configured");
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ") || !(await databaseConfig(env).verify(env.PIPELINE_IDENTITY, auth)))
    throw new ApiError(401, "Worker credential rejected");
  if (memoryId === undefined) return;
  if (!/^[1-9][0-9]*$/.test(String(memoryId))) throw new ApiError(400, "Invalid memory ID");
  const response = await fetch(
    `${env.STDB_HTTP_URL.replace(/\/$/, "")}/v1/database/${encodeURIComponent(env.STDB_DATABASE)}/sql`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "text/plain" },
      body: `SELECT pipeline_identity, owner, request_id, status FROM memory WHERE id = ${memoryId}`,
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new ApiError(502, "Could not read worker assignment");
  const row = (await response.json())[0]?.rows?.[0];
  if (!row || hex(row[0]) !== env.PIPELINE_IDENTITY || hex(row[1]) === env.PIPELINE_IDENTITY)
    throw new ApiError(403, "Memory is not assigned to this worker");
  if (row[3] !== "processing") throw new ApiError(409, "Start processing before publishing scene files");
  if (!/^[a-f0-9-]{36}$/.test(row[2])) throw new ApiError(400, "Memory has no valid upload request ID");
  return `scenes/${memoryId}-${row[2]}/`;
}

function receipt(value, env) {
  let data;
  try {
    data = readTicket(value, env.UPLOAD_SIGNING_SECRET);
  } catch {
    throw new ApiError(401, "Invalid or expired scene upload ticket");
  }
  if (
    data.kind !== "scene-multipart" ||
    !sceneKey(data.key) ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    data.size > MAX_SCENE_ASSET_BYTES ||
    typeof data.uploadId !== "string"
  )
    throw new ApiError(401, "Invalid scene upload ticket");
  return data;
}

export async function pipelineRequest(request, env) {
  const url = new URL(request.url),
    route = url.pathname;
  try {
    if (route === "/api/pipeline/config" && request.method === "GET") {
      await worker(request, env);
      return json(200, {
        version: 1,
        server: env.STDB_HTTP_URL,
        database: env.STDB_DATABASE,
        workerIdentity: env.PIPELINE_IDENTITY,
        partBytes: SCENE_PART_BYTES,
        maxAssetBytes: MAX_SCENE_ASSET_BYTES,
      });
    }
    if (route === "/api/pipeline/assets/start" && request.method === "POST") {
      const input = await body(request),
        prefix = await worker(request, env, input.memoryId);
      if (
        !pathOK(input.path) ||
        !Number.isSafeInteger(input.size) ||
        input.size <= 0 ||
        input.size > MAX_SCENE_ASSET_BYTES
      )
        throw new ApiError(400, "Use a relative scene asset path and a size from 1 byte to 2 GiB");
      const key = prefix + input.path,
        nonce = randomUUID();
      const upload = await env.BUCKET.createMultipartUpload(key, {
        httpMetadata: { contentType: types[input.path.split(".").at(-1)] },
        customMetadata: { nonce },
      });
      const signed = ticket(
        {
          kind: "scene-multipart",
          key,
          size: input.size,
          memoryId: String(input.memoryId),
          uploadId: upload.uploadId,
          nonce,
          expires: Date.now() + 86_400_000,
        },
        env.UPLOAD_SIGNING_SECRET,
      );
      return json(200, {
        ticket: signed,
        partBytes: SCENE_PART_BYTES,
        partCount: Math.ceil(input.size / SCENE_PART_BYTES),
        partUrl: `${env.PUBLIC_ORIGIN}/api/pipeline/assets/part`,
        assetUrl: `${env.PUBLIC_ORIGIN}/media/${key}`,
      });
    }
    if (route === "/api/pipeline/assets/part" && request.method === "PUT") {
      const data = receipt(url.searchParams.get("ticket"), env);
      await worker(request, env, data.memoryId);
      const part = Number(url.searchParams.get("part")),
        count = Math.ceil(data.size / SCENE_PART_BYTES);
      if (!Number.isSafeInteger(part) || part < 1 || part > count) throw new ApiError(400, "Invalid part number");
      const size = part === count ? data.size - (part - 1) * SCENE_PART_BYTES : SCENE_PART_BYTES;
      if (!request.body || Number(request.headers.get("Content-Length")) !== size)
        throw new ApiError(400, "Incorrect part length");
      const uploaded = await env.BUCKET.resumeMultipartUpload(data.key, data.uploadId).uploadPart(part, request.body);
      return json(200, uploaded);
    }
    if (["/api/pipeline/assets/complete", "/api/pipeline/assets/abort"].includes(route) && request.method === "POST") {
      const input = await body(request),
        data = receipt(input.ticket, env);
      await worker(request, env, data.memoryId);
      const upload = env.BUCKET.resumeMultipartUpload(data.key, data.uploadId);
      if (route.endsWith("/abort")) {
        await upload.abort();
        return json(200, { aborted: true });
      }
      const count = Math.ceil(data.size / SCENE_PART_BYTES);
      if (
        !Array.isArray(input.parts) ||
        input.parts.length !== count ||
        input.parts.some((p, i) => p?.partNumber !== i + 1 || typeof p.etag !== "string" || p.etag.length > 200)
      )
        throw new ApiError(400, "Missing or invalid parts");
      // A lost completion response can be retried without uploading the entire asset again.
      let object = await env.BUCKET.head(data.key);
      if (object?.customMetadata?.nonce !== data.nonce) object = await upload.complete(input.parts);
      if (object.size !== data.size) throw new ApiError(400, "Stored scene size does not match");
      return json(200, { stored: true, size: object.size, assetUrl: `${env.PUBLIC_ORIGIN}/media/${data.key}` });
    }
    return json(404, { error: "Unknown pipeline route or method" });
  } catch (e) {
    return json(e instanceof ApiError ? e.status : 502, {
      error: e instanceof ApiError ? e.message : "Pipeline storage request failed; retry",
    });
  }
}
