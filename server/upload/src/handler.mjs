import { randomUUID } from "node:crypto";
import { ApiError, accountName, credentials, decodePersonalKey, encodePersonalKey } from "./accounts.mjs";
import { readTicket, ticket } from "./tickets.mjs";

/**
 * Validates a presign request. `pipeline: false` marks a test upload (capture simulation,
 * test-video): its memory row is assigned to the uploader instead of the pipeline worker,
 * and the worker only takes `uploaded` rows assigned to its own identity.
 */
export function metadata(body, owner, base) {
  const { name, type, size, title, durationSec, pipeline = true } = body;
  if (typeof name !== "string" || !/^.+\.(mp4|mov|webm)$/i.test(name)) throw new Error("Select an MP4, MOV or WebM");
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(type)) throw new Error("Unsupported video type");
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3)
    throw new Error("Video must be 1 byte to 2 GiB");
  if (typeof title !== "string" || !title.trim() || title.length > 120)
    throw new Error("Title must be 1–120 characters");
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 3600)
    throw new Error("Video duration must be 0–3600 seconds");
  if (typeof pipeline !== "boolean") throw new Error("pipeline must be true or false");
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
const systemError = (error) => typeof error?.code === "string" && /^E[A-Z0-9_]+$/.test(error.code);
async function json(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new ApiError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ApiError(400, "Send a JSON object");
  }
}

/**
 * Build the Node request handler for every /api route. Storage and database access are injected, so the same
 * handler serves S3/R2, local disk and Cloudflare Workers. Every hook is optional to the handler itself: the upload
 * routes need `secret`, `assetBase`, `sign`, `head`, `createMemory` and `pipelineIdentity`, and other hooks enable
 * their own routes.
 *
 * @param {object} options
 * @param {string} [options.secret] HMAC secret that signs upload tickets.
 * @param {string} [options.assetBase] Public base URL of stored uploads.
 * @param {string[]} options.allowedOrigins Browser origins allowed by CORS.
 * @param {(identity: string, authorization: string) => Promise<boolean>} options.verify
 * @param {(upload: object) => Promise<string>} [options.sign] Returns a signed PUT URL for an upload ticket.
 * @param {(key: string) => Promise<{ size: number, type?: string } | null>} [options.head]
 * @param {(upload: object, authorization: string, assignee: string) => Promise<unknown>} [options.createMemory]
 * @param {string} [options.pipelineIdentity] The GPU worker's SpacetimeDB identity.
 * @param {() => Promise<{ identity: string, token: string }>} [options.registerIdentity]
 * @param {(owner: string, authorization: string) => Promise<any[]>} [options.listMemories]
 * @param {(identity: string, authorization: string) => Promise<unknown>} [options.getProfile]
 * @param {(displayName: string, authorization: string) => Promise<unknown>} [options.setProfile]
 * @param {(authorization: string) => Promise<unknown>} [options.connections] Enables GET /api/connections.
 * @param {object} [options.accountConfig] Enables the /api/account routes.
 * @param {(name: string, authorization: string) => Promise<unknown>} [options.registerAccount]
 * @param {(identity: string, authorization: string) => Promise<object>} [options.getAccount]
 * @param {{ issue: Function, restore: Function }} [options.passwords] Enables six-digit passwords.
 * @param {number} [options.maxUploadBytes]
 * @param {boolean} [options.pipelineEnabled]
 */
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
  passwords,
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
    if (origin && !allowedOrigins.includes(origin)) return send(403, { error: "Origin not allowed" });
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
      return send(200, {
        version: passwords ? 2 : 1,
        ...accountConfig,
        keyPrefix: "memos1.",
        ...(passwords ? { passwordLength: 6 } : {}),
        maxUploadBytes,
        pipelineAvailable: pipelineEnabled,
      });
    if (req.method === "POST" && route.pathname === "/api/identity" && registerIdentity) {
      try {
        return send(200, await registerIdentity());
      } catch {
        return send(502, { error: "Could not connect to SpacetimeDB" });
      }
    }
    const connectionsRoute = req.method === "GET" && route.pathname === "/api/connections" && connections;
    const profileRoute =
      route.pathname === "/api/profile" &&
      ((req.method === "GET" && getProfile) || (req.method === "POST" && setProfile));
    const passwordRoute = route.pathname === "/api/account/password" && req.method === "POST";
    const accountRoute =
      (route.pathname === "/api/account" || passwordRoute) &&
      accountConfig &&
      getAccount &&
      registerAccount &&
      ["GET", "POST"].includes(req.method);
    const listing = req.method === "GET" && route.pathname === "/api/memories" && listMemories;
    if (
      !listing &&
      !profileRoute &&
      !connectionsRoute &&
      !accountRoute &&
      (req.method !== "POST" || !["/api/uploads/presign", "/api/uploads/complete"].includes(route.pathname))
    )
      return send(404, { error: "Not found" });
    if (!(accountRoute && req.method === "POST" && !passwordRoute) && !req.headers.authorization?.startsWith("Bearer "))
      return send(401, { error: "Connect to SpacetimeDB first" });
    try {
      const body =
        listing || connectionsRoute || ((profileRoute || accountRoute) && req.method === "GET")
          ? { identity: route.searchParams.get("identity") }
          : await json(req);
      // POST /account either creates/promotes an identity or restores an existing password.
      let credential;
      const client = req.socket?.remoteAddress || "unknown"; // Never trust arbitrary forwarding headers.
      const restoring =
        accountRoute &&
        req.method === "POST" &&
        !passwordRoute &&
        (body.personalKey !== undefined || body.password !== undefined);
      const creating = accountRoute && req.method === "POST" && !passwordRoute && !restoring;
      const name = creating ? accountName(body) : undefined;
      if (restoring) {
        if (
          req.headers.authorization ||
          body.identity !== undefined ||
          body.name !== undefined ||
          body.displayName !== undefined ||
          (body.personalKey !== undefined && body.password !== undefined)
        )
          throw new ApiError(400, "Send only password when restoring an account");
        if (body.password !== undefined) {
          if (!passwords) throw new ApiError(503, "Six-digit passwords are not configured on this server");
          credential = await passwords.restore(body.password, client);
        } else credential = decodePersonalKey(body.personalKey, accountConfig);
      } else if (creating && !req.headers.authorization) {
        if (body.identity !== undefined) throw new ApiError(401, "An existing identity requires authentication");
        const created = await registerIdentity();
        credential = { ...accountConfig, identity: created.identity.replace(/^0x/, ""), token: created.token };
      } else credential = credentials(req.headers.authorization, body.identity, accountConfig);
      const auth = `Bearer ${credential.token}`;
      body.identity = credential.identity;
      if (!(await verify(credential.identity, auth))) return send(401, { error: "Identity/token mismatch" });
      if (accountRoute) {
        if (creating) await registerAccount(name, auth);
        const profile = await getAccount(credential.identity, auth);
        if (profile.provider !== "key" || !profile.displayName)
          throw new ApiError(401, "This identity has no registered password account");
        const result = { ...accountConfig, ...profile };
        if (passwordRoute) {
          if (!passwords) throw new ApiError(503, "Six-digit passwords are not configured on this server");
          return send(200, { password: await passwords.issue(credential, client) });
        }
        if (req.method === "POST") {
          Object.assign(result, { token: credential.token, personalKey: encodePersonalKey(credential) });
          if (passwords)
            result.password =
              restoring && body.password !== undefined ? body.password : await passwords.issue(credential, client);
        }
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
      if (listing) return send(200, { memories: await listMemories(body.identity, auth) });
      if (route.pathname === "/api/uploads/presign") {
        if (body.size > maxUploadBytes)
          throw new ApiError(413, `Video exceeds this server's ${maxUploadBytes} byte upload limit`);
        if (body.pipeline === undefined) body.pipeline = pipelineEnabled;
        if (body.pipeline && !pipelineEnabled)
          throw new ApiError(503, "Reconstruction is not configured. Send pipeline:false to save the recording.");
        const data = metadata(body, body.identity, assetBase);
        // A test row is assigned to its uploader; for the worker itself that is its queue.
        if (!data.pipeline && data.owner.toLowerCase() === String(pipelineIdentity).toLowerCase())
          throw new Error("The pipeline worker's identity cannot make test uploads");
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
      if (data.owner !== body.identity) return send(403, { error: "Receipt belongs to another identity" });
      const stored = await head(data.key);
      if (stored.size !== data.size || stored.type !== data.type)
        throw new Error("Upload is incomplete or has incorrect content type/size");
      // The flag is inside the signed receipt, so a retry assigns the same identity
      // (create_memory rejects a repeated request ID with a different one).
      const queued = data.pipeline !== false;
      await createMemory(data, auth, queued ? pipelineIdentity : data.owner);
      const memory = listMemories
        ? (await listMemories(data.owner, auth)).find((row) => row.requestId === data.requestId)
        : undefined;
      if (listMemories && !memory)
        throw new Error("Upload stored, but database confirmation is missing. Retry completion.");
      return send(200, {
        requestId: data.requestId,
        status: memory?.status || "uploaded",
        pipeline: queued,
        memory,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) res.setHeader("Retry-After", "900");
      if (systemError(error)) console.error("Upload request failed:", error);
      send(error instanceof ApiError ? error.status : 400, {
        error: error instanceof Error && !systemError(error) ? error.message : "Upload failed; retry",
      });
    }
  };
}
