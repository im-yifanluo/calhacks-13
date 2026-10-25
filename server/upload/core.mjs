import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { ApiError, accountSettings, accountName, credentials, decodePersonalKey, encodePersonalKey } from "./accounts.mjs";

export function ticket(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
export function readTicket(value, secret) {
  const [data, sig] = String(value).split(".");
  const expected = createHmac("sha256", secret)
    .update(data ?? "")
    .digest();
  const received = Buffer.from(sig ?? "", "base64url");
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    throw new Error("Invalid upload receipt");
  const payload = JSON.parse(Buffer.from(data, "base64url").toString());
  if (payload.expires < Date.now())
    throw new Error("Upload receipt expired; request a new upload");
  return payload;
}
/**
 * Validates a presign request. `pipeline: false` marks a test upload (capture simulation,
 * test-video): its memory row is assigned to the uploader instead of the pipeline worker,
 * and the worker only takes `uploaded` rows assigned to its own identity.
 */
export function metadata(body, owner, base) {
  const { name, type, size, title, durationSec, pipeline = true } = body;
  if (typeof name !== "string" || !/^.+\.(mp4|mov|webm)$/i.test(name))
    throw new Error("Select an MP4, MOV or WebM");
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(type))
    throw new Error("Unsupported video type");
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3)
    throw new Error("Video must be 1 byte to 2 GiB");
  if (typeof title !== "string" || !title.trim() || title.length > 120)
    throw new Error("Title must be 1–120 characters");
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 3600)
    throw new Error("Video duration must be 0–3600 seconds");
  if (typeof pipeline !== "boolean")
    throw new Error("pipeline must be true or false");
  const requestId = randomUUID();
  const extension = name.toLowerCase().split(".").pop();
  const key = `videos/${owner}/${requestId}.${extension}`;
  return {
    owner,
    requestId,
    key,
    type,
    size,
    title: title.trim(),
    durationUs: Math.round(durationSec * 1e6),
    sourceUrl: `${base.replace(/\/$/, "")}/${key}`,
    pipeline,
    expires: Date.now() + 3600_000,
  };
}
/** Node system errors (ENOENT, ECONNREFUSED…) can name absolute paths on this machine. */
const systemError = (error) =>
  typeof error?.code === "string" && /^E[A-Z0-9_]+$/.test(error.code);
async function json(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new ApiError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, "Send a JSON object"); }
}
export function makeHandler({
  secret,
  assetBase,
  allowedOrigins,
  verify,
  sign,
  head,
  createMemory,
  pipelineIdentity,
  registerIdentity,
  listMemories,
  getProfile,
  setProfile,
  connections,
  accountConfig,
  registerAccount,
  getAccount,
  maxUploadBytes = 2 * 1024 ** 3,
  pipelineEnabled = true,
}) {
  return async (req, res) => {
    const origin = req.headers.origin;
    const route = new URL(req.url, "http://localhost");
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    if (origin && !allowedOrigins.includes(origin))
      return send(403, { error: "Origin not allowed" });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (route.pathname === "/api/health") return send(200, { status: "ok" });
    if (route.pathname === "/api/account/config" && req.method === "GET" && accountConfig)
      return send(200, { version: 1, ...accountConfig, keyPrefix: "memos1.", maxUploadBytes, pipelineAvailable: pipelineEnabled });
    if (
      req.method === "POST" &&
      route.pathname === "/api/identity" &&
      registerIdentity
    ) {
      try {
        return send(200, await registerIdentity());
      } catch {
        return send(502, { error: "Could not connect to SpacetimeDB" });
      }
    }
    const connectionsRoute = req.method === "GET" && route.pathname === "/api/connections" && connections;
    const profileRoute = route.pathname === "/api/profile" &&
      ((req.method === "GET" && getProfile) || (req.method === "POST" && setProfile));
    const accountRoute = route.pathname === "/api/account" && accountConfig && getAccount && registerAccount &&
      ["GET", "POST"].includes(req.method);
    const listing =
      req.method === "GET" &&
      route.pathname === "/api/memories" &&
      listMemories;
    if (
      !listing && !profileRoute && !connectionsRoute && !accountRoute &&
      (req.method !== "POST" ||
        !["/api/uploads/presign", "/api/uploads/complete"].includes(
          route.pathname,
        ))
    )
      return send(404, { error: "Not found" });
    if (!(accountRoute && req.method === "POST") && !req.headers.authorization?.startsWith("Bearer "))
      return send(401, { error: "Connect to SpacetimeDB first" });
    try {
      const body = listing || connectionsRoute || ((profileRoute || accountRoute) && req.method === "GET")
        ? { identity: route.searchParams.get("identity") }
        : await json(req);
      // POST /account either creates/promotes an identity or restores an existing personal key.
      let credential;
      const restoring = accountRoute && req.method === "POST" && body.personalKey !== undefined;
      const creating = accountRoute && req.method === "POST" && !restoring;
      const name = creating ? accountName(body) : undefined;
      if (restoring) {
        if (req.headers.authorization || body.identity !== undefined || body.name !== undefined || body.displayName !== undefined)
          throw new ApiError(400, "Send only personalKey when restoring an account");
        credential = decodePersonalKey(body.personalKey, accountConfig);
      } else if (creating && !req.headers.authorization) {
        if (body.identity !== undefined) throw new ApiError(401, "An existing identity requires authentication");
        const created = await registerIdentity();
        credential = { ...accountConfig, identity: created.identity.replace(/^0x/, ""), token: created.token };
      } else credential = credentials(req.headers.authorization, body.identity, accountConfig);
      const auth = `Bearer ${credential.token}`;
      body.identity = credential.identity;
      if (!(await verify(credential.identity, auth)))
        return send(401, { error: "Identity/token mismatch" });
      if (accountRoute) {
        if (creating) await registerAccount(name, auth);
        const profile = await getAccount(credential.identity, auth);
        if (profile.provider !== "key" || !profile.displayName)
          throw new ApiError(401, "This identity has no registered personal-key account");
        const result = { ...accountConfig, ...profile };
        if (req.method === "POST") Object.assign(result, { token: credential.token, personalKey: encodePersonalKey(credential) });
        return send(200, result);
      }
      if (connectionsRoute) {
        const report = await connections(auth);
        return send(report.status === "reachable" ? 200 : 503, report);
      }
      if (profileRoute) {
        if (req.method === "POST") {
          if (typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.trim().length > 40)
            throw new Error("Name must be 1–40 characters");
          await setProfile(body.displayName.trim(), auth);
        }
        return send(200, await getProfile(body.identity, auth));
      }
      if (listing)
        return send(200, { memories: await listMemories(body.identity, auth) });
      if (route.pathname === "/api/uploads/presign") {
        if (body.size > maxUploadBytes)
          throw new ApiError(413, `Video exceeds this server's ${maxUploadBytes} byte upload limit`);
        if (body.pipeline === undefined) body.pipeline = pipelineEnabled;
        if (body.pipeline && !pipelineEnabled)
          throw new ApiError(503, "Reconstruction is not configured. Send pipeline:false to save the recording.");
        const data = metadata(body, body.identity, assetBase);
        // A test row is assigned to its uploader; for the worker itself that is its queue.
        if (
          !data.pipeline &&
          data.owner.toLowerCase() === String(pipelineIdentity).toLowerCase()
        )
          throw new Error(
            "The pipeline worker's identity cannot make test uploads",
          );
        return send(200, {
          putUrl: await sign(data),
          receipt: ticket(data, secret),
          requestId: data.requestId,
          sourceUrl: data.sourceUrl,
          headers: { "Content-Type": data.type },
          pipeline: data.pipeline,
          expiresIn: 900,
          receiptExpiresAt: data.expires,
        });
      }
      const data = readTicket(body.receipt, secret);
      // Storage tickets (upload:local's PUT URLs) carry a kind; only receipts complete.
      if (data.kind) throw new Error("Invalid upload receipt");
      if (data.owner !== body.identity)
        return send(403, { error: "Receipt belongs to another identity" });
      const stored = await head(data.key);
      if (stored.size !== data.size || stored.type !== data.type)
        throw new Error(
          "Upload is incomplete or has incorrect content type/size",
        );
      // The flag is inside the signed receipt, so a retry assigns the same identity
      // (create_memory rejects a repeated request ID with a different one).
      const queued = data.pipeline !== false;
      await createMemory(data, auth, queued ? pipelineIdentity : data.owner);
      const memory = listMemories
        ? (await listMemories(data.owner, auth)).find(
            (row) => row.requestId === data.requestId,
          )
        : undefined;
      if (listMemories && !memory)
        throw new Error(
          "Upload stored, but database confirmation is missing. Retry completion.",
        );
      return send(200, {
        requestId: data.requestId,
        status: memory?.status || "uploaded",
        pipeline: queued,
        memory,
      });
    } catch (error) {
      if (systemError(error)) console.error("Upload request failed:", error);
      send(error instanceof ApiError ? error.status : 400, {
        error:
          error instanceof Error && !systemError(error)
            ? error.message
            : "Upload failed; retry",
      });
    }
  };
}
export function databaseConfig(env = process.env) {
  const settings = accountSettings(env);
  const base = settings.server;
  const url = `${base}/v1/database/${encodeURIComponent(env.STDB_DATABASE)}`;
  return {
    accountConfig: settings,
    registerAccount: async (name, auth) => {
      const response = await fetch(`${url}/call/register_account`, {
        method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify([name]), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new ApiError(response.status >= 500 ? 502 : 400, "Could not register this name. An existing personal key keeps its registered name.");
    },
    getAccount: async (identity, auth) => {
      if (!/^[a-f0-9]{64}$/.test(identity)) throw new ApiError(401, "Invalid identity");
      const response = await fetch(`${url}/sql`, {
        method: "POST", headers: { Authorization: auth, "Content-Type": "text/plain" },
        body: `SELECT display_name, provider FROM profile WHERE identity = 0x${identity}`,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new ApiError(502, "Could not read the account from SpacetimeDB");
      const [result] = await response.json();
      return { identity, displayName: result.rows[0]?.[0] ?? "", provider: result.rows[0]?.[1] ?? "guest" };
    },
    verify: async (id, auth) =>
      (
        await fetch(`${base}/v1/identity/${id}/verify`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(10000),
        })
      ).ok,
    registerIdentity: async () => {
      const response = await fetch(`${base}/v1/identity`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Identity registration failed");
      return response.json();
    },
    setProfile: async (displayName, auth) => {
      const response = await fetch(`${url}/call/set_display_name`, {
        method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify([displayName]), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Could not save your name");
    },
    getProfile: async (identity, auth) => {
      if (!/^[a-f0-9]{64}$/i.test(identity)) throw new Error("Invalid identity");
      const response = await fetch(`${url}/sql`, {
        method: "POST", headers: { Authorization: auth },
        body: `SELECT display_name FROM profile WHERE identity = 0x${identity}`,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Could not load your profile");
      const [result] = await response.json();
      return { identity, displayName: result.rows[0]?.[0] ?? "" };
    },
    listMemories: async (identity, auth) => {
      if (!/^[a-f0-9]{64}$/i.test(identity))
        throw new Error("Invalid identity");
      const response = await fetch(`${url}/sql`, {
        method: "POST",
        headers: { Authorization: auth },
        body: `SELECT id, title, source_url, status, duration_us, request_id, pipeline_identity, manifest_url, progress, error FROM memory WHERE owner = 0x${identity}`,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Database lookup failed");
      const [result] = await response.json();
      // SQL returns an identity as ["0x<64 hex>"]; report it like the API's identities.
      const hex = (value) =>
        String(Array.isArray(value) ? value[0] : value)
          .replace(/^0x/, "")
          .toLowerCase();
      return result.rows.map(
        ([
          id,
          title,
          sourceUrl,
          status,
          durationUs,
          requestId,
          pipelineIdentity,
          manifestUrl,
          progress,
          error,
        ]) => ({
          id: String(id),
          title,
          sourceUrl,
          status,
          durationUs: String(durationUs),
          requestId,
          pipelineIdentity: hex(pipelineIdentity),
          pipeline: hex(pipelineIdentity) !== identity.toLowerCase(),
          manifestUrl,
          progress,
          error,
        }),
      );
    },
    createMemory: async (d, auth, pipeline) => {
      const response = await fetch(
        `${base}/v1/database/${encodeURIComponent(env.STDB_DATABASE)}/call/create_memory`,
        {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify([
            d.requestId,
            d.title,
            d.sourceUrl,
            d.manifestUrl || "",
            ["0x" + pipeline],
            d.durationUs,
          ]),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok)
        throw new Error(
          `createMemory failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
    },
  };
}
