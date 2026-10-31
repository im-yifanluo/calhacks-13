import { ApiError, accountSettings } from "./accounts.mjs";

/** SpacetimeDB over HTTP for the handler's account, profile and memory hooks (see makeHandler's options). */
export function databaseConfig(env = process.env) {
  const settings = accountSettings(env);
  // The account names the public browser destination; server-side verification uses the internal host.
  const base = accountSettings({ STDB_HTTP_URL: env.STDB_HTTP_URL, STDB_DATABASE: env.STDB_DATABASE }).server;
  const url = `${base}/v1/database/${encodeURIComponent(env.STDB_DATABASE)}`;
  return {
    accountConfig: settings,
    registerAccount: async (name, auth) => {
      const response = await fetch(`${url}/call/register_account`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify([name]),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new ApiError(
          response.status >= 500 ? 502 : 400,
          "Could not register this name. An existing password keeps its registered name.",
        );
    },
    getAccount: async (identity, auth) => {
      if (!/^[a-f0-9]{64}$/.test(identity)) throw new ApiError(401, "Invalid identity");
      const response = await fetch(`${url}/sql`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "text/plain" },
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
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify([displayName]),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Could not save your name");
    },
    getProfile: async (identity, auth) => {
      if (!/^[a-f0-9]{64}$/i.test(identity)) throw new Error("Invalid identity");
      const response = await fetch(`${url}/sql`, {
        method: "POST",
        headers: { Authorization: auth },
        body: `SELECT display_name FROM profile WHERE identity = 0x${identity}`,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Could not load your profile");
      const [result] = await response.json();
      return { identity, displayName: result.rows[0]?.[0] ?? "" };
    },
    listMemories: async (identity, auth) => {
      if (!/^[a-f0-9]{64}$/i.test(identity)) throw new Error("Invalid identity");
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
        ([id, title, sourceUrl, status, durationUs, requestId, pipelineIdentity, manifestUrl, progress, error]) => ({
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
      const response = await fetch(`${base}/v1/database/${encodeURIComponent(env.STDB_DATABASE)}/call/create_memory`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify([d.requestId, d.title, d.sourceUrl, d.manifestUrl || "", ["0x" + pipeline], d.durationUs]),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(`createMemory failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    },
  };
}
