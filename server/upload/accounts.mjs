/** Same portable password format as apps/web/src/account-key.ts. No credentials live in the database. */
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function accountSettings(env) {
  const url = new URL(env.ACCOUNT_SERVER_URL || env.STDB_PUBLIC_URL || env.STDB_HTTP_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Account server must be an HTTP(S) URL without credentials or query parameters");
  if (!env.STDB_DATABASE) throw new Error("STDB_DATABASE is required");
  return { server: url.href.replace(/\/$/, ""), database: env.STDB_DATABASE };
}

export function encodePersonalKey(account) {
  return "memos1." + Buffer.from(JSON.stringify(account)).toString("base64url");
}

export function decodePersonalKey(value, settings) {
  if (typeof value !== "string" || value.length > 16384 || !/^memos1\.[A-Za-z0-9_-]+$/.test(value.trim()))
    throw new ApiError(401, "Use the complete password beginning with memos1.");
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value.trim().slice(7), "base64url")));
    if (!data || typeof data !== "object" || typeof data.identity !== "string" || !/^[a-f0-9]{64}$/.test(data.identity) ||
      typeof data.token !== "string" || data.token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token)) throw new Error();
  } catch { throw new ApiError(401, "The password is incomplete or damaged"); }
  if (data.server !== settings?.server || data.database !== settings?.database)
    throw new ApiError(401, "This password belongs to a different memos server or database");
  return { ...settings, identity: data.identity, token: data.token };
}

/** Resolve credentials using configured destinations only. Verification still happens at SpacetimeDB. */
export function credentials(header, identity, settings) {
  if (typeof header !== "string" || !header.startsWith("Bearer "))
    throw new ApiError(401, "Sign in with a password or SpacetimeDB token first");
  const bearer = header.slice(7);
  if (bearer.startsWith("memos1.")) {
    const account = decodePersonalKey(bearer, settings);
    if (identity !== undefined && identity !== null && identity !== account.identity)
      throw new ApiError(401, "Identity/token mismatch");
    return account;
  }
  if (typeof identity !== "string" || !/^[a-f0-9]{64}$/i.test(identity))
    throw new ApiError(401, "A token requires its 64-character identity, without 0x");
  return { ...settings, identity: identity.toLowerCase(), token: bearer };
}

export function accountName(body) {
  const name = body.displayName ?? body.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40)
    throw new ApiError(400, "Name must be 1–40 characters");
  return name.trim();
}
