/** Read-only interface discovery. Reachable tables do not imply a running GPU worker. */
export function connectionConfig(env, storage) {
  const http = new URL(env.STDB_HTTP_URL);
  if (!["http:", "https:"].includes(http.protocol) || http.username || http.password || http.search || http.hash)
    throw new Error("STDB_HTTP_URL must be an HTTP(S) server URL without credentials or query parameters");
  const base = http.href.replace(/\/$/, "");
  const database = env.STDB_DATABASE;
  if (!database) throw new Error("STDB_DATABASE is required");
  const endpoint = `${base}/v1/database/${encodeURIComponent(database)}`;
  const worker = String(env.PIPELINE_IDENTITY || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(worker)) throw new Error("PIPELINE_IDENTITY must be a 64-character hex identity");
  const websocket = new URL(base + "/");
  websocket.protocol = http.protocol === "https:" ? "wss:" : "ws:";
  const tables = {
    memory: "SELECT id, owner, request_id, source_url, pipeline_identity, status, progress, manifest_url, error, duration_us FROM memory WHERE id = 0",
    room: "SELECT id, join_code, memory_id, host FROM room WHERE id = 0",
    party: "SELECT room_id, pending_memory_id, scene_revision FROM party WHERE room_id = 0",
    timeline: "SELECT room_id, branch_id, paused, speed, anchor_media_us, anchor_server_ts FROM timeline WHERE room_id = 0",
    player: "SELECT identity, room_id, online, hx FROM player WHERE identity = 0x" + "0".repeat(64),
    object_state: "SELECT key, branch_id, object_id FROM object_state WHERE branch_id = 0",
    branch: "SELECT id, room_id FROM branch WHERE id = 0",
    branch_keyframes: "SELECT key, branch_id FROM branch_keyframes WHERE branch_id = 0",
    clock_sample: "SELECT identity FROM clock_sample WHERE identity = 0x" + "0".repeat(64),
  };
  return async (auth) => {
    const checks = await Promise.all(Object.entries(tables).map(async ([table, query]) => {
      try {
        const response = await fetch(`${endpoint}/sql`, {
          method: "POST", headers: { Authorization: auth, "Content-Type": "text/plain" },
          body: query, signal: AbortSignal.timeout(5000),
        });
        // Do not relay provider errors, tokens or internal server details.
        if (!response.ok) return { table, status: "unavailable", httpStatus: response.status };
        const result = await response.json();
        return { table, status: Array.isArray(result) && result.length === 1 && Array.isArray(result[0]?.rows) ? "reachable" : "unavailable" };
      } catch { return { table, status: "unavailable" }; }
    }));
    const memoryReady = checks.find(c => c.table === "memory").status === "reachable";
    const liveReady = checks.every(c => c.status === "reachable");
    return {
      status: liveReady ? "reachable" : "unavailable",
      database: { name: database, httpUrl: base, websocketUrl: websocket.href, checks },
      interfaces: {
        I3: { status: memoryReady ? "reachable" : "unavailable", complete: "/api/uploads/complete", reducer: `${endpoint}/call/create_memory`, memories: "/api/memories?identity=<your-identity>" },
        I4: { status: memoryReady ? "reachable" : "unavailable", workerIdentity: worker, sql: `${endpoint}/sql`, pendingQuery: `SELECT * FROM memory WHERE status = 'uploaded' AND pipeline_identity = 0x${worker}`, reducer: `${endpoint}/call/set_memory_status`, workerRunning: "not_checked" },
        I5: { status: "configured", ...storage, readVideo: "memory.sourceUrl", readScene: "memory.manifestUrl", transferVerified: false },
        I7: { status: liveReady ? "tables_reachable" : "unavailable", websocketUrl: websocket.href, database, websocketVerified: false, test: "npm run test:connections" },
      },
      note: "Read-only checks. Run test:connections to exercise transfers, reducers and WebSocket sync locally. A reachable database does not verify the GPU worker or cloud storage.",
    };
  };
}
