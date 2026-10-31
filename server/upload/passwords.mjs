import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto";
import { ApiError } from "./accounts.mjs";

export const validPassword = (value) => typeof value === "string" && value.length === 6 && /^[0-9]{6}$/.test(value);

/** One encrypted registry per database. Compare-and-swap commits serialize all replicas,
 * including failed login counters. No passwords or identity tokens enter public DB tables. */
export function passwordVault({
  store,
  secret,
  settings,
  now = Date.now,
  generate = () => String(randomInt(1_000_000)).padStart(6, "0"),
}) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("Password storage needs a stable server secret");
  const scope = JSON.stringify([settings.server, settings.database]);
  const derive = (purpose) =>
    createHmac("sha256", secret)
      .update(purpose + scope)
      .digest();
  const encryptionKey = derive("memos-password-encryption-v1:");
  const objectKey = "_private/accounts/" + derive("memos-password-location-v1:").toString("hex");
  const clientKey = (client) =>
    createHmac("sha256", derive("memos-password-rate-v1:"))
      .update(client || "unknown")
      .digest("hex");
  const encrypt = (state) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(state), "utf8")), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  };
  const decrypt = (value) => {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", encryptionKey, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(data.subarray(12, 28));
    const state = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
    if (state.version !== 1 || !state.accounts || !state.passwords || !state.limits)
      throw new Error("Invalid registry");
    return state;
  };
  async function update(operation) {
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const previous = await store.read(objectKey);
        const state = previous ? decrypt(previous.value) : { version: 1, accounts: {}, passwords: {}, limits: {} };
        const before = JSON.stringify(state);
        let value, error;
        try {
          value = operation(state);
        } catch (caught) {
          if (!(caught instanceof ApiError)) throw caught;
          error = caught;
        }
        if (JSON.stringify(state) !== before || !previous) {
          if (!(await store.write(objectKey, encrypt(state), previous?.version))) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(25 * (attempt + 1), 250)));
            continue;
          }
        }
        if (error) throw error;
        return value;
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Storage/provider errors may include paths or payloads. Fail closed without exposing them.
    }
    throw new ApiError(503, "Password service unavailable. Please retry.");
  }
  function charge(state, client, purpose) {
    const time = now();
    for (const [key, limit] of Object.entries(state.limits)) if (limit.until <= time) delete state.limits[key];
    const limits = [
      [purpose + ":global", 30, 60_000],
      [purpose + ":" + clientKey(client), 5, 900_000],
    ];
    for (const [key, maximum, window] of limits) {
      const limit = (state.limits[key] ??= { count: 0, until: time + window });
      if (limit.count >= maximum) throw new ApiError(429, "Too many attempts. Please wait before trying again.");
    }
    for (const [key] of limits) state.limits[key].count++;
  }
  return {
    async issue(credential, client) {
      if (credential.server !== settings.server || credential.database !== settings.database)
        throw new ApiError(401, "Account destination mismatch");
      return update((state) => {
        const existing = state.accounts[credential.identity];
        if (existing) {
          // Refresh the stored host credential after an authenticated client refreshes its session.
          state.passwords[existing] = credential;
          return existing;
        }
        charge(state, client, "create");
        // Bound the single-object demo registry; do not silently overwrite or reuse a password.
        if (Object.keys(state.accounts).length >= 10_000) throw new ApiError(503, "Account capacity reached");
        for (let attempt = 0; attempt < 100; attempt++) {
          const password = generate();
          if (!validPassword(password)) throw new Error("Invalid password generator");
          if (state.passwords[password]) continue;
          state.passwords[password] = credential;
          state.accounts[credential.identity] = password;
          return password;
        }
        throw new ApiError(503, "Could not allocate a password. Please retry.");
      });
    },
    async restore(password, client) {
      if (!validPassword(password)) throw new ApiError(400, "Enter exactly six digits.");
      return update((state) => {
        charge(state, client, "login");
        const credential = state.passwords[password];
        if (!credential) throw new ApiError(401, "Password not recognized.");
        return credential;
      });
    },
  };
}

export function r2PasswordStore(bucket) {
  return {
    async read(key) {
      const object = await bucket.get(key);
      return object ? { value: await object.text(), version: object.etag } : null;
    },
    async write(key, value, version) {
      try {
        return !!(await bucket.put(key, value, {
          onlyIf: version ? { etagMatches: version } : { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/octet-stream", cacheControl: "no-store" },
        }));
      } catch (error) {
        // R2 permits one write per second to a single object. Re-read before retrying.
        if (/429|TooManyRequests|too many requests|rate.limit/i.test(error?.message || "")) {
          await new Promise((resolve) => setTimeout(resolve, 1100 + randomInt(150)));
          return false;
        }
        throw error;
      }
    },
  };
}
