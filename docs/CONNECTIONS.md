# Upload, storage and SpacetimeDB connections (I3 / I4 / I5 / I7)

This guide follows the numbered arrows in [ARCHITECTURE.md](ARCHITECTURE.md). The existing database reducers, GPU worker and viewer client already implement these interfaces. This branch adds a connection report, local scene-file serving, private worker configuration and a single live contract test. It does not change capture, reconstruction, rendering, authentication, the scene schema or the database schema.

## One command to verify all four connections

From the repository root, with Node 22.12+, Python 3 and SpacetimeDB CLI **2.13.0** on `PATH`:

```bash
npm ci
npm run test:connections
# Also run the existing full multiplayer and party suites in the same temporary database:
npm run test:connections -- --full
```

The command starts its own loopback SpacetimeDB on a free port, publishes the current module to an isolated in-memory database, starts the upload service, and cleans up its processes, files and database on exit. It does not use Maincloud, your running database, real recordings, R2 credentials or a GPU. Set `SPACETIME_BIN` / `PYTHON` if those executables are not on `PATH`.

| Arrow | What the live test proves | Existing implementation |
|---|---|---|
| **I3** upload → database | Completion rejects a missing PUT; a verified upload creates one `uploaded` memory; repeating completion, including after `ready`, preserves the same row; a subscriber receives it. | `server/upload/service.mjs` → `create_memory` |
| **I4** worker ↔ database | The real Python worker polls only its assigned jobs, skips simulation/self-assigned uploads and other workers' jobs, reports processing/ready, and causes a waiting party's scene to switch. An uploader cannot impersonate the worker. | `pipeline/memreplay/worker.py` → SQL + `set_memory_status` |
| **I5** worker ↔ storage | The real worker downloads exactly the uploaded bytes and publishes a synthetic manifest plus an asset. Both files are retrieved from storage and their bytes checked. | Worker `download` / `publish_dir`; `server/upload/local.mjs` + `scenes.mjs` |
| **I7** viewer ↔ database | Two real WebSocket clients share a party, ready-scene switch, leader-controlled time, head pose, exclusive grab/release and a clock sample. `--full` also checks late joins, trajectories, reconnects and leadership transfer. | Generated SDK + existing module reducers |

The test's input is explicitly labeled **transport bytes, not a decodable video**. Its output is a **synthetic scene, not a reconstruction**. This validates the interfaces independently of the model. Cloud S3/R2 transfers, GPU execution and physical devices require their own acceptance test below.

Verified on 24 October 2026: this isolated test and its `--full` multiplayer/party suites passed, along with TypeScript checks, the production web build, 136 Vitest tests (two existing Web Locks skips) and 108 viewer tests. No pipeline source or public deployment was changed.

## Inspect an already running service

```bash
npm run connections:check -- http://127.0.0.1:8788
# Through an existing HTTPS upload-service host or app /api proxy:
npm run connections:check -- https://YOUR-UPLOAD-HOST
```

This obtains a temporary SpacetimeDB identity and calls **`GET /api/connections?identity=<64-hex-identity>`** with its bearer token. It performs read-only SQL checks; it creates no memory, room or storage object. Exit 0 means the expected public tables and columns are reachable; exit 1 reports a connection/schema/auth failure. Tokens are not printed or saved.

The authenticated JSON report includes:

- Database name, HTTP endpoint, SDK WebSocket base URL, and individual table-check results.
- **I3:** completion and `create_memory` endpoints; owner-scoped memory listing.
- **I4:** the configured worker identity, its filtered polling SQL, and status-reducer endpoint.
- **I5:** the video/scene base URLs and publishing method. `configured` explicitly does **not** prove storage credentials or transfers work.
- **I7:** the database and WebSocket URL to use with `DbConnection`; SQL reachability explicitly does **not** prove the WebSocket path is reachable.

The response is HTTP **503** if a required database read fails, **401** for missing/mismatched credentials and **403** for a disallowed browser origin. `/api/health` remains a process-liveness check only. A healthy database alone cannot prove bucket permissions, public asset URLs, CORS, a running worker or a device's internet connection.

For an existing client, use its current SpacetimeDB identity/token; do not send a `memos1.…` session wrapper as the bearer token. Browser code already uses `net.identity.toHexString()` and `net.token`. This diagnostic endpoint exposes no worker token, bucket secret or local filesystem path. Keep the upload-service allowlist restricted to your intended app origins.

## Local service and worker wiring

Start the shared local services in separate terminals:

```bash
npm run stdb:start
npm run stdb:publish:local
PUBLIC_ORIGIN=http://127.0.0.1:5173 npm run upload:local
LOCAL_HTTP=1 npm run dev
```

Then run `npm run connections:check`. The app, service and worker must use the same `STDB_HTTP_URL` / `STDB_DATABASE`. The local defaults are `http://127.0.0.1:3055` and `memory-replay`; the browser uses the Vite `/stdb/` proxy. The upload service's default port is 8788. Port/config overrides must be passed consistently to each command.

After the upload service's first start has created its stable worker identity:

```bash
PUBLIC_ORIGIN=http://127.0.0.1:5173 npm run worker:env:local
# In the worker's already prepared Python environment, on this same machine:
source data/worker.local.env
unset S3_BUCKET   # select the worker's local publishing path
memreplay worker --once
```

`worker:env:local` verifies the stored worker token against the configured SpacetimeDB server and writes an owner-readable (0600) shell environment file, without displaying its token. It refuses to overwrite an existing file or export a different configured worker's identity. To regenerate, choose a new ignored output path: `npm run worker:env:local -- data/worker-next.env`. Do not commit, share publicly or paste these files into chat. The helper does not install or start the GPU pipeline.

| Setting | Default / purpose |
|---|---|
| `LOCAL_UPLOAD_DIR` | `data/uploads`; videos and persistent signing/worker credentials |
| `LOCAL_SCENE_DIR` | `<LOCAL_UPLOAD_DIR>/memories`; worker's exported scene files |
| `MEMREPLAY_PUBLISH_DIR` | Generated as the absolute `LOCAL_SCENE_DIR` path |
| `MEMREPLAY_PUBLIC_BASE_URL` | Generated as `<PUBLIC_ORIGIN>/api/local-scenes` |
| `ASSET_BASE_URL` | Generated as `<PUBLIC_ORIGIN>/api/local-media` for source validation |
| `PIPELINE_IDENTITY`, `PIPELINE_TOKEN` | Existing local worker identity; never the uploader's identity |

The worker writes `<memoryId>-<requestId>/memory.json` and its referenced assets beneath the scene directory. `GET`/`HEAD /api/local-scenes/<memoryId>-<requestId>/<asset>` serves JSON, PLY, SPZ, GLB, BIN and M4A with the correct content type, byte-range support and the configured CORS policy. The HTTP route is read-only, rejects unsupported/hidden paths, and does not follow symlinks outside the scene directory. It never exposes worker configuration files. No scene is marked ready by the service; the assigned worker calls the existing status reducer after publishing.

This local directory must be accessible to the worker. A remote Runpod worker should use shared S3/R2 storage; a local pathname is not a network connection. Likewise, `127.0.0.1` URLs work only on the host that serves them. Use reachable HTTPS URLs for other devices.

## Cloud acceptance: the same contracts, real storage

1. Configure the upload host from `server/upload/.env.example`: the shared Maincloud database, stable `PIPELINE_IDENTITY`, S3/R2 bucket credentials, public `ASSET_BASE_URL`, upload signing secret and browser-origin allowlist. Run `npm run upload:dev`. Keep server-only values out of `VITE_*` and Git.
2. On the worker, use the **same database, worker identity and asset base**, with the matching `PIPELINE_TOKEN` and its own bucket credentials. The worker needs video read and scene write permission. The upload service needs video PUT-signing and HEAD access. Provisioning R2 and Runpod is separate from a database publish.
3. Run `connections:check` against the reachable upload host. Compare its database and WebSocket URL with the viewer's `VITE_STDB_DATABASE` / `VITE_STDB_URL`. The static memos demonstration currently has no hosted upload service; pointing this check at that static site is not sufficient.
4. Upload a short real MP4/MOV using normal `/api/uploads/presign` → PUT → `/api/uploads/complete`, with **`pipeline: true`** (the default). Save the returned memory ID/request ID. Confirm `/api/memories?identity=<owner>` returns its source URL, `uploaded` status and the expected worker identity. Capture simulation uploads use `pipeline: false` and deliberately never enter the GPU queue.
5. From the worker host, poll the I4 SQL endpoint using the worker bearer token, fetch `source_url`, and run `memreplay worker --once` in the prepared pipeline environment. One worker process per queue remains the existing contract; no job leasing/scheduler is added here.
6. Confirm the same row progresses to `processing`, then `ready` with progress 1 and a reachable `manifest_url`. Fetch that manifest and every referenced relative asset from both the worker and a browser. Configure bucket CORS for GET/HEAD/PUT as needed; the API report alone cannot certify CORS or asset permissions.
7. Attach that memory to a party. A waiting party should switch when it becomes ready. Join with a second device using the room code; verify both names, leader-only time, grabs and head poses. The viewer continues to connect directly to SpacetimeDB for I7.

No public deployment, cloud database mutation, bucket provisioning or GPU run is performed by this branch's isolated test. Existing phone upload payloads and DB reducer signatures remain compatible.
