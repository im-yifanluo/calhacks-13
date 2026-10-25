# Deployable phone upload API

This is the repository's Node service in `server/upload`, with the iPhone account routes added. It supports six-digit account passwords, legacy `memos1.` session credentials, and the original SpacetimeDB token + identity protocol. Video bytes go to local disk in tests or S3/R2 in deployment; SpacetimeDB stores the account and memory metadata. No database schema change is required.

**Live API:** https://memos.alightdell64.chatgpt.site — configure this HTTPS origin on the iPhone, with no `/api` suffix. All five expected paths are deployed on the same origin as the website. The deployment runs this repository's shared `server/upload/core.mjs` and account implementation through `server/upload/worker.mjs` on Cloudflare Workers, using a Sites-managed durable R2 bucket. The standalone Node entrypoint remains available for S3/R2 deployments. This is the same service logic and protocol, with a different HTTP/storage adapter.

The API and website both use `https://maincloud.spacetimedb.com`, database `jerry-memory-replay-phone-20261024`, and the same `register_account` reducer and `profile` table. A six-digit password created on either updated client restores the same identity after the API and clients are deployed together. The API and storage do not depend on a running laptop.

The hosted transport accepts **90 MiB (94,371,840 bytes)** per clip. `GET /api/account/config` reports `maxUploadBytes` and `pipelineAvailable:false`. Omit `pipeline` or send `false` to store a recording; explicit `true` returns 503 until a real worker identity is configured. No 3D reconstruction is claimed. The standalone Node/S3 service retains its 2 GiB limit.

Public verification on **October 24, 2026, 9:48 PM Pacific** created/restored a test account, uploaded the repository's 2,231,432-byte `plant.mp4`, completed it as **memory #4**, retried completion without a duplicate, downloaded identical SHA-256 bytes, exercised HTTP byte ranges, and checked the same profile and recording through the website's Maincloud WebSocket SDK. The shared library shows `[API verification] Sample plant video` with **Watch original**. No private glasses video was used. Physical iPhone upload remains a device test.

## Phone settings and first test

- API origin: `https://memos.alightdell64.chatgpt.site`
- Auth: `Authorization: Bearer memos1.…` (or the existing raw JWT plus identity).
- Create: `POST /api/account` with `{"displayName":"Your name"}`.
- Restore the website account: `POST /api/account` with `{"personalKey":"memos1.…"}`; use the returned registered name and identity.
- Record a short MP4/MOV under 90 MiB, presign, raw PUT using the returned URL/headers, complete with the receipt, then GET `/api/memories`.
- Open `/library` and select **Watch original** on the recording. Importing the same password keeps the same sign-in across phone and web.

The hosted presigned URL points to `/api/uploads/put?ticket=…`, which streams into R2. Treat it as opaque: no bearer credential on that PUT, no multipart wrapper, and supply the real file length (`URLSession.upload(for:fromFile:)`). A repeated PUT returns 409 to prevent overwrites; if the first upload succeeded, retry **completion** with the original receipt. Native callers need no ChatGPT login or Sites bypass credential.

## Verify locally

From the repository root with Node 22.12+ and SpacetimeDB CLI 2.13:

```sh
npm ci
npm run test:upload-api
```

The script starts an isolated local database and the actual `server/upload/start.mjs` entrypoint, publishes the module, creates/restores accounts, verifies the website password format, PUTs the checked-in `plant.mp4`, restarts the API, completes the upload, checks the database and a WebSocket viewer subscription, compares downloaded bytes, checks duplicate completion, and rejects cross-account access. It removes its temporary database/files/processes afterward. It never writes to Maincloud or queues a GPU job. Set `SPACETIME_BIN` if the CLI is not on PATH.

For a continuously running local API, start/publish your local database as described in `P4.md`, then run:

```sh
UPLOAD_STORAGE=local PORT=8788 PUBLIC_ORIGIN=http://127.0.0.1:8788 \
  STDB_HTTP_URL=http://127.0.0.1:3055 STDB_DATABASE=memory-replay npm run upload:start
```

`PUBLIC_ORIGIN` must be reachable by the client because it is used in upload/video URLs. Local mode is for development; the phone's public deployment uses S3/R2 and HTTPS.

## Standalone Node/S3 deployment (alternative)

1. Copy `server/upload/memos.env.example` to `server/upload/.env`. This template already selects the website's destination:

   ```env
   STDB_HTTP_URL=https://maincloud.spacetimedb.com
   STDB_DATABASE=jerry-memory-replay-phone-20261024
   ```

2. Supply the S3/R2 bucket, credentials and public HTTPS asset origin. The service needs permission to sign video PUTs and inspect objects with HEAD. The worker uses its own credentials. Set a random `UPLOAD_SIGNING_SECRET` of at least 32 characters and keep it stable across deployments/replicas.
3. Set `PIPELINE_IDENTITY` to the worker's stable 64-character identity, without `0x`. Reuse an existing worker identity. For a new worker, obtain an identity/token once with `POST https://maincloud.spacetimedb.com/v1/identity`; keep the returned token only on the worker, and put the identity in this service's configuration. `pipeline:false` uploads are assigned to the uploader and stay out of the worker queue. `pipeline:true` does not start a worker.
4. Deploy on a Node/Docker host with a public HTTPS endpoint. No administrator or database-owner token is needed by the API; reducers run using each caller's verified token.

Docker build (from repo root):

```sh
docker build -f server/upload/Dockerfile -t memos-upload .
docker run --rm --env-file server/upload/.env -p 8788:8788 memos-upload
```

Use the host's TLS endpoint/reverse proxy. The process honors `PORT`, defaults to `8788`, binds to `0.0.0.0`, handles SIGTERM, and runs as an unprivileged user in the image. The Docker build allowlist excludes `.env`, video files, the local `data/` directory, and unrelated app sources. The image uses only the root production dependencies.

Alternatively, on a server with Docker Compose and a domain you control, set `UPLOAD_DOMAIN` in `.env`, point its DNS records to that server, allow inbound ports 80/443, then run:

```sh
docker compose --env-file server/upload/.env -f server/upload/compose.yaml up --build -d
```

The included Caddy proxy provisions and renews HTTPS certificates using persistent volumes. These requirements follow [Caddy's automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https). Compose interpolation is described in [Docker's documentation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/). Do not use the existing `chatgpt.site` hostname here; its DNS/hosting is managed separately.

Without Docker, install the root production dependencies and start the service:

```sh
npm ci --omit=dev --ignore-scripts --workspaces=false
node --env-file=server/upload/.env server/upload/start.mjs
```

Health check: `GET /api/health` → `{"status":"ok"}`. This is liveness, not a claim that the bucket or database works. Check `/api/account/config` against the expected server/database before entering a password. An authenticated `/api/connections` checks the existing database interfaces. Finish deployment validation with the actual phone upload/GET flow below.

For browser uploads, configure bucket CORS for PUT/GET/HEAD from `https://memos.alightdell64.chatgpt.site`, allow `Content-Type`, and expose `ETag`/`Content-Length`. Asset hosting must also allow cross-origin reads by the viewer. Native URLSession uploads do not use browser CORS. The current demo stores public asset URLs and uses public SpacetimeDB tables; account-scoped API listings do not make those underlying assets private.

## Phone contract

The user-facing **password** is exactly six ASCII digits, including leading zeros (for example, `000007`). It is a string, never a JSON number. `POST /api/account` exchanges it for the existing host-signed session credential. Use that long session credential for uploads and WebSockets; do not send six digits as an upload bearer token. Existing `memos1.` credentials and `provider: "key"` profiles remain compatible. Names are still display labels, and two accounts with the same name get different passwords.

Deploy this upload service and the updated viewer together. The returned account server must match the browser's `VITE_STDB_URL` (with HTTP(S) scheme). For the default Vite `/stdb` proxy, set `ACCOUNT_SERVER_URL=<viewer-origin>/stdb` while keeping `STDB_HTTP_URL` pointed at the internal database; `npm run party:dev` sets this automatically. This public alias never changes where the API verifies tokens. `/api/account/config` advertises `version:2,passwordLength:6`. Older servers are reported as needing an update, rather than silently generating long passwords. Previously signed-in users choose **Copy password** or **Save password file** to allocate their six-digit password without changing their identity or memories. Signed-out users can choose **Restore an older saved account** and paste the old credential first.

All API responses are JSON with `Cache-Control: no-store`. Errors have `{"error":"message"}`. Expected error statuses: 429 login/creation limit, 503 unavailable password storage, 400 invalid request/reducer rejection, 401 missing/rejected/mismatched credentials, 403 wrong origin or another user's receipt, 404 unknown route, 413 oversized JSON, and 502 for explicit account-backend failures. A failed upload completion may be retried with the same receipt.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/account/config` | No authentication | `{version:2,server,database,passwordLength:6,keyPrefix:"memos1.",maxUploadBytes:2147483648}` |
| `POST /api/account` | `{displayName:"Jerry"}` or `{name:"Jerry"}` | Registered account plus password/token (example below) |
| `POST /api/account` | `{password:"000007"}` | Restores that verified identity and registered name; does not create an account |
| `POST /api/account` | `{personalKey:"memos1.…"}` | Legacy account restoration; also returns its six-digit password |
| `POST /api/account/password` | Authenticated session + `{identity:"<64 hex>"}` for raw JWT, or `{}` for portable bearer | `{password:"000007"}` for the verified registered account |
| `GET /api/account` | Bearer session credential | `{server,database,identity,displayName,provider:"key"}` |
| `POST /api/uploads/presign` | Bearer auth + video metadata | Signed PUT URL, headers, receipt, request ID, source URL, expiry |
| `POST /api/uploads/complete` | Bearer auth + `{receipt:"…"}` | Confirmed database memory and request ID |
| `GET /api/memories` | Bearer session credential | `{memories:[...]}` for the authenticated identity |

Account creation/restoration response (placeholders):

```json
{
  "server": "https://maincloud.spacetimedb.com",
  "database": "jerry-memory-replay-phone-20261024",
  "identity": "<64 lowercase hex characters>",
  "displayName": "Jerry",
  "provider": "key",
  "token": "<SpacetimeDB JWT>",
  "personalKey": "memos1.<base64url payload>",
  "password": "000007"
}
```

Save `personalKey` and `password` in the iPhone Keychain. Only display/copy `password` to the user. Send it as `Authorization: Bearer memos1.…`; never put it in a URL. The API unwraps it, checks its destination against server configuration, verifies the token with that SpacetimeDB host, and uses `register_account`/`profile` for the same name-and-password account as the website. Names are not unique; the password identifies the person. A registered name stays fixed. Restoring an account requires a registered `provider:"key"` profile; a public identity alone cannot sign in. `GET /api/account` does not echo credentials.

For compatibility, `Authorization: Bearer <raw JWT>` also works when `identity` (64 hex, no `0x`) is supplied in each POST body or GET query. To promote the old iPhone guest identity without losing its uploads, POST `/api/account` with `{identity,displayName}` using its raw token. A request authenticated with the portable session credential can optionally include the same identity field; conflicting identities are rejected. Existing `/api/identity` and `/api/profile` routes remain available, but `/api/profile` alone does not register a password account.

### Upload and independently verify

1. POST `/api/uploads/presign` with bearer auth:

   ```json
   {"name":"glasses.mp4","type":"video/mp4","size":12345678,"title":"Glasses test","durationSec":15,"pipeline":false}
   ```

   Use `pipeline:false` for the first storage/database test. Use `true` for real reconstruction work when the worker is configured. Supported types: MP4 (`video/mp4`), MOV (`video/quicktime`), WebM (`video/webm`), 1 byte–2 GiB, duration greater than zero and at most 3600 seconds. `size` must be the exact encoded file length.

   Response shape:

   ```json
   {
     "putUrl":"https://<storage>/<signed PUT URL>",
     "headers":{"Content-Type":"video/mp4"},
     "receipt":"<signed completion receipt>",
     "requestId":"<uuid>",
     "sourceUrl":"https://<assets>/videos/<identity>/<uuid>.mp4",
     "pipeline":false,
     "expiresIn":900,
     "receiptExpiresAt":1792904400000
   }
   ```

   `receiptExpiresAt` is epoch milliseconds (the example is illustrative). PUT signatures last 15 minutes; completion receipts last one hour. Keep the receipt/request ID for retries.

2. PUT **raw file bytes** to `putUrl` using exactly the returned headers. No multipart wrapper and no memos bearer credential on this storage request. Set the actual `Content-Length` or let URLSession's file upload supply it.
3. POST `/api/uploads/complete` with bearer auth and `{"receipt":"<receipt>"}`. The service checks stored size/type before creating the memory, then independently reads its database row. Response:

   ```json
   {
     "requestId":"<uuid>","status":"uploaded","pipeline":false,
     "memory":{
       "id":"42","title":"Glasses test","sourceUrl":"https://<assets>/videos/<identity>/<uuid>.mp4",
       "status":"uploaded","durationUs":"15000000","requestId":"<uuid>",
       "pipelineIdentity":"<64 hex>","manifestUrl":"","progress":0,"error":""
     }
   }
   ```

4. GET `/api/memories` with the returned `personalKey` bearer credential. Confirm a row with the same `requestId` and `memory.id`, then play/download its `sourceUrl`. Retrying completion must return the same row, not create another. IDs and durations are JSON strings to preserve integer precision. `status` can advance while the worker runs.
5. Import the same password on the memos website. With identical server/database settings, its profile identity matches the uploaded row's owner. Uploaded video is visible as a recording; a 3D view requires a real worker to set `manifestUrl` and `ready`. This API does not reconstruct video.

## Hosted build and regression tests

`server/upload/sites-worker.ts` is the entrypoint template for the Sites Vinext starter; copy it to that checkout's `worker/index.ts`. Copy `core.mjs`, `accounts.mjs` and `worker.mjs` to its `server/upload/` directory. Keep the starter's `sites()` build integration and declare `r2: "BUCKET"` (no static-only manifest). Its asset binding uses `ASSETS`, `run_worker_first:true`, `html_handling:"none"`; runtime secrets are held in Sites settings, not Git. The production settings are `STDB_HTTP_URL`, `STDB_DATABASE`, `PUBLIC_ORIGIN`, `UPLOAD_ALLOWED_ORIGINS`, and a stable secret `UPLOAD_SIGNING_SECRET`. `PIPELINE_IDENTITY` is optional and currently unset.

From the canonical repo, `node scripts/build-hosted-web.mjs <hosting-checkout>/public` rebuilds the viewer with the shared cloud settings. It excludes private local memories and enables web uploads. Publish with the Sites source/build workflow; preserve the current site ID and audience.

`UPLOAD_TEST_WORKER_DIR=<absolute-hosting-checkout> npm run test:upload-api` uses the actual built Cloudflare Worker, local R2 and an isolated real SpacetimeDB, including restart, exact-byte playback, and byte ranges. The default command exercises the Node service. `npx tsx scripts/test-upload-public.ts https://memos.alightdell64.chatgpt.site` explicitly performs a real public upload using the non-private repository fixture. It keeps resumable test credentials only in ignored `data/public-upload-test.private.json` (mode 0600), and a credential-free verification record in `data/public-upload-verification.json`.

The hosted R2 upload and public TLS are verified. Physical iPhone capture/upload and GPU reconstruction remain separate tests. Docker is not installed on the development machine; the standalone image itself has not been built here. The exact production dependency install and Node S3-mode startup were tested outside Docker.

## Runpod scene publication

The account-scoped memory response also includes `pipeline: true|false`, derived from whether the assigned pipeline identity differs from the uploader. `false` means the video was stored without requesting reconstruction; it must not be shown as a pending GPU job. Existing fields remain compatible with Nikko's app.

`npm run test:pipeline` runs the actual native queue and worker transport using the standalone `server/upload/wrangler.jsonc` configuration, so no private Sites checkout is needed. It verifies retry recovery, worker assignment, publication, `ready` subscriptions and failure reporting with substituted reconstruction stages. Real GPU acceptance is a separate `npm run test:pipeline:live -- --clip /absolute/clip.mp4` command.

See [RUNPOD_INTEGRATION.md](RUNPOD_INTEGRATION.md) for the worker-authenticated multipart scene API, setup, and tests. The website now filters its library to the current owner; sign in with the phone’s same password to see its recording. Local scene imports are also account-scoped but remain on that browser. The live worker remains unconfigured until the Runpod setup steps are completed.

## Password persistence and deployment

Six-digit passwords are randomly generated, unique per database, and stable across replicas/restarts. Allocation retries collisions. The registry is capped at 10,000 accounts for this demo. Passwords and host tokens are AES-256-GCM encrypted under a purpose-specific key derived from `UPLOAD_SIGNING_SECRET` and the database destination. The object name is also derived with HMAC. Conditional storage writes serialize allocation and attempt counters across replicas; failed authentication is counted before responding. No password/token is added to a public SpacetimeDB table.

- Node local mode requires Node 22.13+ (the pinned 22.23.2 works) for built-in SQLite and uses `.accounts.sqlite` (mode 0600) under `LOCAL_UPLOAD_DIR` and the existing `.signing-secret`. Keep that directory on persistent storage and back up both files together.
- Node S3/R2 mode uses `ACCOUNT_PASSWORD_BUCKET` when supplied, otherwise `S3_BUCKET`. Prefer a dedicated private bucket. It must support conditional `If-Match` / `If-None-Match` writes.
- Cloudflare uses the optional private R2 binding `ACCOUNT_PASSWORDS`, otherwise the existing `BUCKET`. The public `/media/` handler rejects `_private/accounts/` paths. The encrypted registry and attempt counters persist in R2, not Worker memory. R2 [limits writes to one per second per object](https://developers.cloudflare.com/r2/platform/limits/); the adapter backs off on throttling and re-reads before retrying. Already-issued passwords are read without rewriting the registry when the session token is unchanged. This single-registry design is for small demos, not high-throughput authentication.

Keep the signing secret, bucket/disk, and database destination stable across deployments. Changing any of them makes the previous password registry inaccessible. Existing authenticated devices/legacy credentials can still obtain a new password, but a six-digit password alone cannot recover a lost registry. Storage failures and write conflicts fail closed with 503; they never create a temporary in-memory account.

Login and new-password allocation each allow five attempts per source address per 15 minutes, plus 30 globally per minute. Counters are shared by replicas and survive restart; successful logins count too. Node uses the socket address (forwarding headers cannot spoof it); Cloudflare uses its platform-provided `CF-Connecting-IP`. A Node reverse proxy therefore shares one client limit unless a separately validated client-address integration is added. Requests using already-issued session tokens do not use the six-digit login limit. The short code remains lower-entropy demo authentication, not equivalent to a long password or MFA; the global limit also means a sustained guessing attack can temporarily deny new sign-ins.

Verification: `npm test` covers format, leading zeros, migration, collisions, concurrent replicas, encrypted persistence, throttling and failed storage. `npm run test:upload-api` exercises six-digit restore before and after a real Node API restart, the real local database, an actual MP4 upload and owner-scoped listing. `UPLOAD_TEST_R2=1 npm run test:upload-api` repeats the path against the actual Cloudflare Worker with local R2 emulation. These checks do not deploy the public site.
