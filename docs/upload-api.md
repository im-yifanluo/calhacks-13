# Upload API

The upload API is the HTTP service between the capture clients and storage. It signs video uploads, checks each stored
file and registers it as a `memory` row in SpacetimeDB; it exchanges six-digit passwords for account credentials; and on
Cloudflare it also takes the GPU worker's finished scene files and the scenes published from the web library. Video and
scene bytes never pass through the database: storage holds the bytes, SpacetimeDB holds the rows.

One request handler ([`handler.mjs`](../server/upload/src/handler.mjs)) serves three runtimes:

- **Node with S3/R2** (`UPLOAD_STORAGE=s3`, the default): clients PUT videos straight to the bucket with presigned URLs.
  Started by `npm run upload:dev`, `npm run upload:start` and the Docker image.
- **Node with local disk** (`UPLOAD_STORAGE=local`): videos stream through the service into `data/uploads`. Started by
  `npm run upload:local`, for development and capture tests without a cloud account.
- **Cloudflare Worker** ([`src/cloudflare/`](../server/upload/src/cloudflare/)): videos stream through the Worker into
  an R2 bucket, and the Worker serves the stored files at `/media/`. The hosted site runs this one.

[server/upload/README.md](../server/upload/README.md) has the package layout and run commands,
[development.md](./development.md) the local stack and [deployment.md](./deployment.md) the hosting options.

## Routes

Every runtime serves:

- `GET /api/health`: liveness.
- `GET /api/account/config`: the account destination and the upload limits.
- `POST /api/account`, `GET /api/account` and `POST /api/account/password`: password accounts.
- `POST /api/identity`: a new SpacetimeDB identity.
- `GET /api/profile` and `POST /api/profile`: display names.
- `POST /api/uploads/presign` and `POST /api/uploads/complete`: video uploads.
- `GET /api/memories`: the caller's memories.

Some routes exist on one runtime only:

- Node, both storage modes: `GET /api/connections`, the [connection report](#connection-report).
- Node with local disk: `PUT /api/local-upload`, `GET /api/local-media/*` and `GET /api/local-scenes/*`
  ([storage routes](#storage-routes)).
- Cloudflare: `PUT /api/uploads/put` and `GET /media/*` ([storage routes](#storage-routes)), `/api/pipeline/*` and
  `/api/scenes/*` ([scene publishing](#scene-publishing)).

Any other path answers 404.

## Conventions

- **Requests.** POST bodies are JSON objects of at most 32 KiB (413 above that, 400 for anything that is not a JSON
  object). GET routes take `identity` as a query parameter.
- **Responses.** JSON, with `Cache-Control: no-store`. An error is `{"error": "<message>"}`.
- **Numbers and identities.** A memory's `id` and `durationUs` are JSON strings, to keep 64-bit precision. Identities
  are 64 lowercase hex characters without `0x`.
- **CORS.** A request whose `Origin` header is not in the allowed list (`UPLOAD_ALLOWED_ORIGINS`) gets 403 on every
  route. An allowed origin is echoed in `Access-Control-Allow-Origin`, and `OPTIONS` preflights answer 204. Requests
  without an `Origin` header, such as the iPhone app's, curl's and other servers', are not restricted.

Error statuses:

- 400: an invalid request, or a reducer call that SpacetimeDB rejected.
- 401: missing, malformed, mismatched or rejected credentials.
- 403: a disallowed `Origin`, or another identity's receipt.
- 404: an unknown route.
- 413: a JSON body over 32 KiB, or a video over the runtime's size limit.
- 429: too many password attempts, with `Retry-After: 900`.
- 502: SpacetimeDB failed to answer an account or identity request.
- 503: password storage unavailable, reconstruction not configured or a failing connection report; on Cloudflare also a
  missing setting or binding.

## Authentication

Authenticated routes take an `Authorization: Bearer <credential>` header in one of three forms:

- **Session credential**, `memos1.<payload>`: the `personalKey` that `POST /api/account` returns. The payload is
  base64url JSON `{server, database, identity, token}`: the SpacetimeDB server and database, the account's identity and
  its SpacetimeDB token. The web app uses the same format ([`account/key.ts`](../apps/web/src/account/key.ts)). The API
  refuses a credential for another server or database, and an `identity` field, when one is sent, must match it.
- **SpacetimeDB token with identity**, the original protocol, which the web upload panel and the capture page use:
  `Bearer <token>`, plus the token's `identity` in the JSON body (POST) or the query string (GET).
- **Worker token** (`PIPELINE_TOKEN`), for `/api/pipeline/*` only: the SpacetimeDB token of the GPU worker's identity.

Each request verifies the token with SpacetimeDB (`GET /v1/identity/<identity>/verify`). The service holds no
administrator or database-owner token: reducer calls and SQL reads run with the caller's own token, so the module's
rules apply to them. The six-digit password is never a bearer credential; `POST /api/account` exchanges it for the
session credential.

No credential is needed for `GET /api/health`, `GET /api/account/config`, `POST /api/identity`, creating or restoring an
account with `POST /api/account`, the storage PUTs (the signed URL is the authorization) and public media reads.

## Accounts

### `GET /api/account/config`

No credential. On the Cloudflare runtime without a worker, it returns:

```json
{
  "version": 2,
  "server": "https://maincloud.spacetimedb.com",
  "database": "<database>",
  "keyPrefix": "memos1.",
  "passwordLength": 6,
  "maxUploadBytes": 94371840,
  "pipelineAvailable": false
}
```

- `server` and `database`: the SpacetimeDB destination clients must use. `server` is `ACCOUNT_SERVER_URL` (default
  `STDB_HTTP_URL`). It must equal the web app's `VITE_STDB_URL` with `https:` for `wss:` and no trailing slash, so that
  one password works on the phone and the website alike. Clients compare both values with their own before sending a
  password.
- `version` 2 and `passwordLength` 6: six-digit passwords are supported.
- `maxUploadBytes`: 2147483648 (2 GiB) on Node, 94371840 (90 MiB) on Cloudflare.
- `pipelineAvailable`: whether uploads can be queued for the GPU worker. Node always reports `true`; Cloudflare reports
  `false` until `PIPELINE_IDENTITY` is set.

### `POST /api/account`

Four forms, told apart by the body:

- `{"displayName": "Ada"}` (or `"name"`), without `Authorization`: creates a new SpacetimeDB identity, registers the
  name with the `register_account` reducer and allocates a password.
- `{"name": "Ada"}` with a credential: registers a password account for the caller's existing identity and keeps its
  memories. This is how a guest identity becomes an account. With a token, include `identity`.
- `{"password": "000007"}` alone, without `Authorization`: restores that account.
- `{"personalKey": "memos1.…"}` alone, without `Authorization`: restores from a saved session credential, and allocates
  a password if the account has none.

A name is 1–40 characters after trimming. Names are labels, not unique: two people can share a name, and their passwords
tell them apart. A registered name stays fixed, so registering a different one for the same identity fails with 400.
Restoring needs a registered account; an identity without one gets 401.

Every form returns the account with its credentials:

```json
{
  "server": "https://maincloud.spacetimedb.com",
  "database": "<database>",
  "identity": "<64 hex characters>",
  "displayName": "Ada",
  "provider": "key",
  "token": "<SpacetimeDB token>",
  "personalKey": "memos1.<base64url payload>",
  "password": "000007"
}
```

Keep `personalKey` and `password` in secure storage (the iPhone app uses the Keychain), show only the password to the
person and never put either in a URL. Use `personalKey` as the bearer credential from then on.

Errors: 400 for an invalid name, a malformed password or other fields next to `password` or `personalKey`; 401 for an
unknown password or a damaged or foreign `personalKey`; 429 and 503 from the password registry
([six-digit passwords](#six-digit-passwords)); 502 when SpacetimeDB fails.

### `GET /api/account`

With a credential: `{server, database, identity, displayName, provider: "key"}`. It never echoes the token. An identity
without a registered account gets 401.

### `POST /api/account/password`

With a credential (`{}` with a session credential, `{"identity": "…"}` with a token): `{"password": "000007"}`, the
account's existing password or a newly allocated one. A browser that is already signed in gets its six-digit password
this way without changing identity. An identity without a registered account gets 401.

### `POST /api/identity`

No credential and no body. Returns SpacetimeDB's answer to `POST /v1/identity`, a new anonymous identity:
`{"identity": "…", "token": "…"}`. It creates no profile. 502 when SpacetimeDB can't be reached. The connection check
uses it.

### `GET /api/profile` and `POST /api/profile`

- `GET /api/profile?identity=<hex>` returns `{identity, displayName}`.
- `POST /api/profile` with `{"displayName": "Ada"}` (1–40 characters) sets the caller's display name with the
  `set_display_name` reducer and returns the profile.

Both need a credential for that identity. A display name is not an account: it registers no password, and a registered
account's name can't change.

## Uploading a video

An upload takes three requests. The service keeps no state between them: the presign response carries a signed receipt.

1. `POST /api/uploads/presign` with the file's metadata. The response has a PUT URL, its headers and a receipt.
2. PUT the raw file to that URL within 15 minutes.
3. `POST /api/uploads/complete` with the receipt within an hour of the presign. The memory row now exists.

### `POST /api/uploads/presign`

```json
{
  "name": "glasses.mp4",
  "type": "video/mp4",
  "size": 12345678,
  "title": "Kitchen, Saturday",
  "durationSec": 15,
  "pipeline": true
}
```

- `name`: the file name, ending in `.mp4`, `.mov` or `.webm`. The extension names the stored object.
- `type`: `video/mp4`, `video/quicktime` or `video/webm`.
- `size`: the exact byte length, from 1 byte to the runtime's `maxUploadBytes` (413 above it).
- `title`: 1–120 characters.
- `durationSec`: more than 0 and at most 3600. It is stored as `durationUs`, in microseconds.
- `pipeline`: `true` queues the clip for the GPU worker; `false` only stores it ([test uploads](#test-uploads)). It
  defaults to the server's `pipelineAvailable`, and `true` on a server without a worker answers 503.
- `identity`: required with a token credential.

Response:

```json
{
  "putUrl": "https://<storage>/<signed PUT URL>",
  "receipt": "<signed completion receipt>",
  "requestId": "<uuid>",
  "sourceUrl": "https://<assets>/videos/<owner>/<uuid>.mp4",
  "headers": { "Content-Type": "video/mp4" },
  "pipeline": true,
  "expiresIn": 900,
  "receiptExpiresAt": 1792904400000
}
```

- `putUrl` is opaque. Node with S3 signs a URL on the bucket's S3 endpoint; local disk returns
  `/api/local-upload?receipt=…` and Cloudflare `/api/uploads/put?ticket=…`, both on `PUBLIC_ORIGIN`.
- `sourceUrl` is where the video will be readable: `<ASSET_BASE_URL>/videos/<owner>/<requestId>.<ext>` with S3,
  `<PUBLIC_ORIGIN>/api/local-media/videos/…` on local disk and `<PUBLIC_ORIGIN>/media/videos/…` on Cloudflare.
- `expiresIn` is the PUT URL's lifetime in seconds, and `receiptExpiresAt` the receipt's expiry in epoch milliseconds.
  Keep the receipt and `requestId` for retries.

### PUT the video

Send the raw file bytes to `putUrl`:

- No multipart form and no `Authorization` header.
- Exactly the returned `headers`. With S3 the URL signs `Content-Type`, so storage refuses any other type.
- The real `Content-Length`: upload from a file (`URLSession.upload(for:fromFile:)`, or a `File` body in a browser)
  rather than a stream.

The answer depends on the runtime:

- S3: the bucket's own response. A PUT from a browser also needs the bucket's CORS policy
  ([deployment.md](./deployment.md#object-storage)).
- Local disk: 200, or 400 for a size or type mismatch. A second PUT is accepted only with identical bytes.
- Cloudflare: `{"stored": true, "size": …}`; 401 for an invalid or expired URL, 411 without `Content-Length`, 400 for a
  size or type mismatch, and 409 when the object is already stored, in which case retry the completion with the original
  receipt.

### `POST /api/uploads/complete`

Body: `{"receipt": "<receipt>"}`, plus `identity` with a token credential. The service checks the receipt's signature
and expiry, that it belongs to the caller (403 otherwise) and that the stored object has the declared size and type (400
otherwise, including "Upload not found; PUT the video first"). Then it calls `create_memory` with the caller's token and
reads the row back:

```json
{
  "requestId": "<uuid>",
  "status": "uploaded",
  "pipeline": true,
  "memory": {
    "id": "42",
    "title": "Kitchen, Saturday",
    "sourceUrl": "https://<assets>/videos/<owner>/<uuid>.mp4",
    "status": "uploaded",
    "durationUs": "15000000",
    "requestId": "<uuid>",
    "pipelineIdentity": "<64 hex characters>",
    "pipeline": true,
    "manifestUrl": "",
    "progress": 0,
    "error": ""
  }
}
```

Completion is idempotent: the request ID inside the receipt identifies the row, so a repeat returns the same memory,
even after the worker has marked it ready. A completion whose response was lost can be retried with the same receipt
until the receipt expires. After that, look for the `requestId` in `GET /api/memories` before uploading again, as the
iPhone app does.

The checks cover transport metadata (size and content type), not the video itself; the pipeline decodes it.

### `GET /api/memories`

With a credential: `{"memories": [...]}`, every row the caller owns, each shaped like `memory` above. With a token,
`?identity=` must be the token's own identity.

- `status` is `uploaded`, `processing`, `ready` or `failed`, and advances while the worker runs. A ready row has a
  `manifestUrl` and `progress` 1, a failed one an `error`.
- `pipeline` is `true` when the row is assigned to someone other than its owner, that is, queued for the worker. `false`
  marks a stored-only recording, which is not a pending GPU job.

### Test uploads

A presign with `"pipeline": false` assigns the row to the uploader instead of the worker (`pipelineIdentity` equals the
owner). The worker skips such rows, so the clip is stored and stays `uploaded`. The capture page's simulation,
`npm run test:video`, the iPhone demo app's simulated clips and uploads to a server without a worker all work this way.
The flag is inside the signed receipt, so a retried completion assigns the same identity. The worker's own identity
can't make test uploads. To reconstruct a stored-only clip, upload it again with `"pipeline": true`.

### Limits

- Types: MP4 (`video/mp4`), MOV (`video/quicktime`) and WebM (`video/webm`).
- Size: 1 byte to 2 GiB on Node, 1 byte to 90 MiB (94,371,840 bytes) on Cloudflare. Clients read the limit from
  `maxUploadBytes`.
- Duration: more than 0 and at most 3600 seconds. Title: 1–120 characters.
- The PUT URL lasts 15 minutes, the receipt 1 hour from the presign.
- The Node server times API requests out after 30 seconds with S3, and after 15 minutes on local disk, where the video
  itself streams through it.

## Storage routes

### Local disk

- `PUT /api/local-upload?receipt=<ticket>`: the `putUrl` on local disk. `Content-Type` and `Content-Length` must match
  the presign. The file lands at `<LOCAL_UPLOAD_DIR>/videos/<owner>/<requestId>.<ext>`, with its size, type and SHA-256
  in a sidecar file. `OPTIONS` answers the CORS preflight of a page on an origin other than `PUBLIC_ORIGIN`.
- `GET` and `HEAD /api/local-media/videos/<owner>/<requestId>.<ext>`: the stored videos, with byte ranges (`bytes=N-`
  and `bytes=N-M`) and an `X-Content-SHA256` header that pages can read; the capture page compares it with the
  recording.
- `GET` and `HEAD /api/local-scenes/<memoryId>-<requestId>/<path>`: scenes the worker wrote to `LOCAL_SCENE_DIR`, as
  `.json`, `.ply`, `.spz`, `.glb`, `.bin` or `.m4a` files, with byte ranges. Read-only (405 for other methods). Hidden
  files, other extensions, path traversal and symlinks out of the folder answer 404.

### Cloudflare

- `PUT /api/uploads/put?ticket=<ticket>`: the `putUrl` on Cloudflare. The body streams into R2 at
  `videos/<owner>/<requestId>.<ext>` without being buffered, and an existing object is never overwritten.
- `GET` and `HEAD /media/<key>`: public reads of three key families: videos (`videos/…`), worker scenes
  (`scenes/<memoryId>-<requestId>/…`) and library scenes (`imports/<owner>/<requestId>/…`). Nothing else in the bucket,
  such as the password registry, is reachable. Responses allow any origin and support byte ranges, including suffix
  ranges (416 when a range can't be satisfied). Videos and library scenes are cached for an hour as immutable; worker
  scenes are sent with `no-cache`.

## Scene publishing

Two route families on the Cloudflare runtime let scene files reach R2 without storage credentials.

### Worker scene files: `/api/pipeline/*`

The GPU worker publishes a finished scene file by file, as multipart uploads. Every call takes
`Authorization: Bearer <PIPELINE_TOKEN>`, which must verify as `PIPELINE_IDENTITY` (401 otherwise, 503 when
`PIPELINE_IDENTITY` is not set). A call about a memory also needs that memory to be assigned to this worker and not
owned by it (403), to be `processing` (409) and to have a UUID request ID. User credentials can't publish.

- `GET /api/pipeline/config`:
  `{version: 1, server, database, workerIdentity, partBytes: 16777216, maxAssetBytes: 2147483648}`. The worker's
  preflight compares `server`, `database` and `workerIdentity` with its own `STDB_HTTP_URL`, `STDB_DATABASE` and
  `PIPELINE_IDENTITY`.
- `POST /api/pipeline/assets/start` with `{"memoryId": "6", "path": "world/bg.spz", "size": 123456}`:
  `{ticket, partBytes, partCount, partUrl, assetUrl}`. The file is stored at `scenes/<memoryId>-<requestId>/<path>` and
  served at `assetUrl`, under `<PUBLIC_ORIGIN>/media/`. The ticket lasts 24 hours.
- `PUT /api/pipeline/assets/part?ticket=<ticket>&part=<n>`: raw bytes with an exact `Content-Length`. Parts are numbered
  from 1, and all but the last are exactly `partBytes` (16 MiB). Returns `{partNumber, etag}`; retrying a part replaces
  it.
- `POST /api/pipeline/assets/complete` with `{"ticket": "…", "parts": [{"partNumber": 1, "etag": "…"}]}`, listing every
  part in order: `{stored: true, size, assetUrl}`. A repeat after a lost response returns the stored file.
- `POST /api/pipeline/assets/abort` with `{"ticket": "…"}`: `{aborted: true}`.

A path is relative and at most 500 characters; its segments start with a letter or digit and contain only letters,
digits, `_`, `.` and `-`; its extension is `json`, `spz`, `ply`, `glb`, `bin`, `m4a` or `mp4`. Files can be up to 2 GiB.
Publishing never changes the memory's status: the worker sets `ready` itself afterwards. Its client,
[`hosted_publish.py`](../pipeline/memreplay/hosted_publish.py), uploads `memory.json` last, after every file it
references, makes up to three attempts per request on transient failures, never follows a redirect (so the token can't
leak to another host) and aborts a failed transfer.

### Library scenes: `/api/scenes/*`

The web library's scene publishing turns an existing reconstruction, a folder with `memory.json` and its files, into a
`ready` memory that every device can open. The memory is registered only after every file it references is stored. The
POST routes take a session credential, or a token with `identity` in the body; the PUT needs only its ticket. The routes
send no CORS headers, so only pages on the same origin can call them: on the hosted site the library and the API share
one Worker.

- `POST /api/scenes/start` with `{"title": "Hotel room", "requestId": "<uuid>"}`: `{receipt, requestId}`. The request ID
  is optional (one is generated when it is missing); reusing it resumes an import. The receipt lasts 24 hours.
- `POST /api/scenes/presign` with `{"receipt": "…", "path": "world/bg.spz", "size": 123456}`: `{putUrl, headers}`, or
  `{stored: true, size}` when that file is already stored with that size (409 for a different size: start a new import).
  A file is at most 64 MiB.
- `PUT /api/scenes/put?ticket=<ticket>`: raw bytes with an exact `Content-Length`. Returns `{stored: true, size}`, or
  409 when the file is already stored.
- `POST /api/scenes/complete` with `{"receipt": "…", "manifest": "memory.json"}` (or `"memory.static.json"`): reads the
  manifest (at most 8 MiB) and checks that it has a background and a `timeline.durationSec` of more than 0 and at most
  3600, that it references at most 256 files, all by safe relative paths (a splat sequence has at most 256 frames), and
  that each of them is stored and not empty. Then it calls `create_memory` with an empty `sourceUrl` and the manifest's
  `/media/` URL, owned by and assigned to the caller, so the row is `ready` at once and never queued. Returns
  `{memory, assets, manifestUrl}`.

The files are stored at `imports/<owner>/<requestId>/<path>` and served from `/media/`. Anyone with a scene's URL can
read its files.

## Six-digit passwords

A password is exactly six ASCII digits, sent as a JSON string so that leading zeros survive (`"000007"`). It is random
and unique within its registry, and it maps to the account's session credential, so restoring it returns the same
identity and registered name on any device.

### Storage

All passwords for one destination (server and database) live in one encrypted registry object. Its AES-256-GCM key and
its object name (`_private/accounts/<hex>`) are derived with HMAC-SHA-256 from `UPLOAD_SIGNING_SECRET` and the
destination. Every change is a conditional write (compare-and-swap), so replicas take turns, and no password or token
enters a public table.

- Node with local disk: `<LOCAL_UPLOAD_DIR>/.accounts.sqlite` (mode 0600), next to the generated `.signing-secret`. Keep
  the folder on persistent storage and back both files up together.
- Node with S3/R2: `ACCOUNT_PASSWORD_BUCKET`, or `S3_BUCKET` when it is unset. The store must support conditional PUTs
  (`If-Match` and `If-None-Match`). Use a separate private bucket: anyone can download the encrypted registry from a
  publicly readable one.
- Cloudflare: the R2 binding `ACCOUNT_PASSWORDS`, or `BUCKET` when it is unbound; `/media/` never serves it. R2 accepts
  one write per second to an object, so the adapter backs off and re-reads when throttled.

Storage fails closed: errors and persistent write conflicts answer 503, and no account ever lives in memory only. A
registry holds at most 10,000 accounts (503 after that). It is a single object, sized for small deployments rather than
high-throughput authentication.

### Rate limits

Logins (restoring by password) and new-password allocations are each limited to 5 per client address per 15 minutes and
30 per minute across all clients. Successful attempts count too. The counters live in the registry, so replicas share
them and they survive restarts. A refused attempt gets 429 with `Retry-After: 900`.

The client address is the TCP peer on Node, which ignores forwarding headers, so behind a reverse proxy all clients
share the proxy's address and its limit. On Cloudflare it is `CF-Connecting-IP`. Requests that only use a session
credential, such as uploads, don't count.

### Changing the secret, the database or the storage

- **`UPLOAD_SIGNING_SECRET`**: pending receipts and upload URLs stop working, and the registry can no longer be found or
  read, so every six-digit password stops working.
- **The database or the advertised server** (`STDB_DATABASE`, or `ACCOUNT_SERVER_URL`, which defaults to
  `STDB_HTTP_URL`): the API starts a new, empty registry and refuses existing `memos1.` credentials as belonging to
  another server or database. A new database also starts with no accounts.
- **The storage** (the bucket, the R2 binding or `LOCAL_UPLOAD_DIR`): the registry is gone.

After a change of secret or storage, a device that still holds its session credential can get a new password with
`POST /api/account/password`. A six-digit password alone can't be recovered. Keep all of these stable across deployments
and replicas.

### Security level

The six-digit password is low-entropy demo authentication. There is no recovery, rotation or revocation; anyone who has
the password signs in as that account; and the global limit means that sustained guessing can block sign-ins for
everyone for a while.

## The worker handoff

A queued upload reaches the GPU worker through the database alone (interfaces I3 and I4 in
[architecture.md](./architecture.md)):

1. Completion calls `create_memory` with the uploader's token. The row is owned by the uploader, has the status
   `uploaded` and is assigned (`pipelineIdentity`) to `PIPELINE_IDENTITY`, or to the uploader for a test upload.
2. `memreplay worker` ([`worker.py`](../pipeline/memreplay/worker.py)) polls every 15 seconds over HTTP SQL with its own
   token (`SELECT * FROM memory WHERE status = 'uploaded'`), keeps the rows assigned to it and skips the rows assigned
   to their owner.
3. Any client can call `create_memory` with any `sourceUrl`, so the worker downloads only what the upload API issued.
   `allowed_source(url, base, owner)` in [`source_check.py`](../pipeline/memreplay/source_check.py) accepts only
   `<base>/videos/<owner>/<uuid>.<mp4|mov|webm>`, where `base` is `ASSET_BASE_URL` (on local disk,
   `<PUBLIC_ORIGIN>/api/local-media`) and `owner` is the row's owner. The download is capped at 2 GiB and 5 minutes and
   follows no redirects. To test a URL: `python3 pipeline/memreplay/source_check.py URL BASE [OWNER]` (exit 0 when
   allowed, 1 when refused).
4. The worker reports with the `set_memory_status` reducer (`memoryId, status, progress, manifestUrl, error`):
   `processing` with rising progress after each stage, then `ready` with the public `memory.json` URL, or `failed` with
   the error. The reducer accepts only the assigned identity and these transitions: `uploaded` to `processing` or
   `failed`; `processing` to `processing`, `ready` or `failed`; `failed` to `processing`; `ready` to `ready`. Progress
   can't go down while processing, `ready` needs a manifest URL and progress 1, and an error is at most 2000 characters.
   When a memory becomes `ready`, every party waiting for it switches to it.
5. The scene is published before `ready` is set: through `/api/pipeline/*` when `MEMREPLAY_UPLOAD_API` is set (the
   Cloudflare runtime), to the bucket under `memories/<memoryId>-<requestId>/` when `S3_BUCKET` is set, and otherwise
   into `MEMREPLAY_PUBLISH_DIR`, served at `MEMREPLAY_PUBLIC_BASE_URL` (on local disk, `/api/local-scenes/`).

The worker takes only `uploaded` rows, so it never retries a `failed` memory: upload the clip again. Its settings and
stages are in the [pipeline runbook](../pipeline/README.md), and running it on a GPU pod is in
[deployment.md](./deployment.md#the-gpu-worker-on-runpod).

### The worker identity

- `npm run upload:local` mints one on first start and keeps it, token included, in
  `<LOCAL_UPLOAD_DIR>/.worker-identity.json`. `npm run worker:env:local` writes a sourceable environment for that worker
  (`data/worker.local.env`, mode 0600) and refuses to overwrite an existing file.
- Elsewhere, mint it once with `curl -sX POST https://maincloud.spacetimedb.com/v1/identity` (the response's `identity`,
  without `0x`, is `PIPELINE_IDENTITY`, and its `token` is the worker's `PIPELINE_TOKEN`), or with
  `scripts/deploy/configure-runpod-worker.mjs` ([deployment.md](./deployment.md#worker-credentials)).
- The upload API needs only the public identity. The token stays on the worker host.
- Rows are assigned at completion, so changing `PIPELINE_IDENTITY`, or deleting `.worker-identity.json`, orphans the
  rows already assigned to the old identity.
- Run one worker per identity. There are no job leases, and a worker stopped mid-job leaves its row `processing`.

### Reporting by hand

[`status.py`](../pipeline/memreplay/status.py) makes the same reducer call from any shell, with `STDB_HTTP_URL`,
`STDB_DATABASE` and `PIPELINE_TOKEN` in the environment:

```bash
python3 pipeline/memreplay/status.py 123 processing --progress 0.1
python3 pipeline/memreplay/status.py 123 ready --progress 1 --manifest-url https://assets.memos.example/memories/123/memory.json
python3 pipeline/memreplay/status.py 123 failed --progress 0.7 --error 'Pose estimation failed'
```

`STDB_HTTP_URL` may be the web app's URL plus `/stdb`, through the dev server's proxy. Exit codes: 0 accepted; 1
rejected (it prints `Status rejected (<code>): <reason>`) or SpacetimeDB unreachable; 2 bad arguments or missing
settings. Only the last 2000 characters of `--error` are sent.

## Connection report

`GET /api/connections?identity=<hex>` (Node only) reads nine tables with read-only SQL and the caller's token, and
describes the interfaces I3, I4, I5 and I7 ([architecture.md](./architecture.md)): the completion route and the
`create_memory` endpoint; the worker identity, its polling query and the status reducer; the storage URLs and how the
worker writes scenes; and the WebSocket URL for `DbConnection`. It answers 200 when every table is reachable and 503
otherwise. It doesn't prove storage transfers, a running worker, CORS or WebSocket reachability, and says so
(`transferVerified: false`, `workerRunning: "not_checked"`, `websocketVerified: false`). It exposes no token, secret or
local path. `/api/health`, by contrast, checks only that the process answers.

```bash
npm run connections:check -- http://127.0.0.1:8788
npm run connections:check -- https://api.memos.example
```

The check takes a throwaway identity from `POST /api/identity`, calls the report with it, prints the JSON and exits 0
when everything is reachable, 1 otherwise. It writes nothing besides that anonymous identity. Without an argument it
uses `UPLOAD_URL`, then `http://127.0.0.1:8788`. `npm run test:connections` exercises the same interfaces end to end,
with transfers and a real worker process, against isolated local services ([development.md](./development.md)).

## Configuration

These are server-side settings: never put any of them in a `VITE_*` variable. The templates are
[`server/upload/.env.example`](../server/upload/.env.example) (for `npm run upload:dev`) and
[`deploy/docker/.env.example`](../server/upload/deploy/docker/.env.example) (for Docker).

### Server

- `UPLOAD_STORAGE`: `s3` (the default) or `local`. Node only.
- `PORT` or `UPLOAD_PORT`: the listen port, default 8788. The web app's dev server proxies `/api` to `UPLOAD_PORT`.
- `UPLOAD_HOST`: the listen address. Default `127.0.0.1`, or `0.0.0.0` when `NODE_ENV=production`.
- `NODE_ENV`: `production` in deployments.

### Database

- `STDB_HTTP_URL`: the SpacetimeDB server the service calls for identities, SQL and reducers. Required, except on local
  disk, where it defaults to `http://127.0.0.1:<STDB_PORT>`.
- `STDB_DATABASE`: the database. Required, except on local disk (default `memory-replay`).
- `ACCOUNT_SERVER_URL` (or `STDB_PUBLIC_URL`): the server URL that clients use, returned as `server` and written into
  `memos1.` credentials. Defaults to `STDB_HTTP_URL`. Set it when browsers reach the database at another URL, such as
  `https://localhost:5173/stdb` through the dev server's proxy (`npm run party:dev` sets it). Tokens are always verified
  at `STDB_HTTP_URL`.
- `STDB_PORT`: local disk only, the port in the default `STDB_HTTP_URL` (3055).

### GPU worker

- `PIPELINE_IDENTITY`: the GPU worker's identity, 64 hex characters without `0x`. Queued uploads are assigned to it.
  Required with S3 (the server won't start without it); on local disk it defaults to the minted worker identity; on
  Cloudflare it is optional, and setting it turns `pipelineAvailable` on.

### Storage: S3 or R2

- `S3_BUCKET` (required): the bucket for videos, and for the password registry unless `ACCOUNT_PASSWORD_BUCKET` is set.
- `S3_ENDPOINT`: the S3 API endpoint, such as `https://<account-id>.r2.cloudflarestorage.com` for R2. Omit it for AWS
  S3.
- `S3_REGION`: default `auto`, which suits R2; the bucket's region on AWS.
- `S3_FORCE_PATH_STYLE`: `true` for stores that need path-style URLs.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and the optional `AWS_SESSION_TOKEN`: credentials that can presign PUTs,
  HEAD objects, and read and write the registry. Without them, the AWS SDK's default credential chain applies.
- `ASSET_BASE_URL` (required): the bucket's public base URL. Rows get
  `sourceUrl = <ASSET_BASE_URL>/videos/<owner>/<requestId>.<ext>`, and the worker accepts only URLs under it.
- `ACCOUNT_PASSWORD_BUCKET`: a separate private bucket for the password registry.

### Storage: local disk

- `LOCAL_UPLOAD_DIR`: default `data/uploads`. Holds the videos and three generated files to keep: `.signing-secret`,
  `.accounts.sqlite` and `.worker-identity.json`.
- `LOCAL_SCENE_DIR`: default `<LOCAL_UPLOAD_DIR>/memories`. The worker's published scenes, served at
  `/api/local-scenes/`.
- `PUBLIC_ORIGIN`: default `http://127.0.0.1:5173`, the origin at which clients reach the service, usually through the
  web app's `/api` proxy. PUT URLs and `sourceUrl`s are built from it, so it must be reachable from every client (a
  phone can't reach a laptop's `127.0.0.1`), and rows keep the origin they were created with. It is always an allowed
  origin.

### Cloudflare bindings

- `BUCKET` (R2 binding, required): videos, scenes and, unless `ACCOUNT_PASSWORDS` is bound, the password registry.
- `ACCOUNT_PASSWORDS` (R2 binding): a separate private bucket for the registry.
- `PUBLIC_ORIGIN` (required): the Worker's public origin, exactly (scheme, host and port, no path). Upload, media and
  scene URLs are built from it.
- `STDB_HTTP_URL`, `STDB_DATABASE`, `ACCOUNT_SERVER_URL`, `PIPELINE_IDENTITY`, `UPLOAD_SIGNING_SECRET` and
  `UPLOAD_ALLOWED_ORIGINS` work as on Node.

### Security

- `UPLOAD_SIGNING_SECRET`: at least 32 random characters. It signs receipts and upload URLs and keys the password
  registry. Required with S3 and on Cloudflare; on local disk the service generates `.signing-secret` on first start.
  Keep it stable across restarts, deployments and replicas. To generate one:
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

### CORS

- `UPLOAD_ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the API, such as the web app's HTTPS origin
  and any tunnel URL. The default is `https://localhost:5173` with S3 and `PUBLIC_ORIGIN` on Cloudflare. On local disk,
  `PUBLIC_ORIGIN` is always allowed and these origins are added to it.

## Testing

- **Unit tests** in [`server/upload/tests`](../server/upload/tests) (Vitest) cover receipts and tickets, the metadata
  checks, the real S3 presigner's signed headers, routing, test uploads, the local-disk transport, the password registry
  (format, collisions, concurrent replicas, rate limits, failing storage), the Cloudflare storage routes and byte
  ranges, worker multipart publishing, library scenes and the connection report.
  [`tests/upload-account.test.ts`](../tests/upload-account.test.ts) checks that the API and the web app agree on
  credentials and password flows. Run them with `npm test`, or only this package's with
  `npx vitest run --project upload`.
- **`npm run test:upload-api`** ([`tests/integration/upload-api.ts`](../tests/integration/upload-api.ts)) starts an
  isolated in-memory SpacetimeDB on a free port, publishes the module and starts the real Node entry point on local
  disk. It creates and restores accounts, uploads `tests/fixtures/plant.mp4` as a test upload, restarts the API between
  the PUT and the completion, and checks for one row, identical downloaded bytes, byte ranges, the row arriving over a
  WebSocket subscription, cross-account rejections and the promotion of a token identity. It cleans up after itself and
  never touches Maincloud or a GPU. It needs the `spacetime` CLI (`SPACETIME_BIN` sets its path). Options:
  - `UPLOAD_TEST_R2=1` runs the standalone Cloudflare Worker instead (`wrangler dev --local`, with local R2), and adds
    the worker bridge: worker authentication, the real Python multipart publisher with a 91 MiB file, and the `ready`
    status over WebSocket. It needs `python3`.
  - `UPLOAD_TEST_WORKER_DIR=<absolute path>` does the same with a hosting checkout's built Worker
    ([deployment.md](./deployment.md#the-hosted-sites-combined-worker)).
  - `UPLOAD_TEST_SCENE_BIN=<binary>` adds the iPhone app's upload queue on top of an R2 run; `npm run test:pipeline`
    sets it ([ios.md](./ios.md)).
- **`npx tsx tests/e2e/upload-public.ts https://<api-origin>`** ([`upload-public.ts`](../tests/e2e/upload-public.ts))
  makes a real upload to a deployed API. It first checks that the API's `server` and `database` match
  [`apps/web/.env.hosted`](../apps/web/.env.hosted) and that no worker is configured. Then it writes to the target
  service: a test account named "Memos upload verification" (a registered profile and a password), the fixture video in
  storage and one stored-only memory row titled "[API verification] Sample plant video". It downloads the bytes back,
  checks byte ranges and finds the same row over a WebSocket. Locally it keeps the test account's credentials and its
  progress in `data/public-upload-test.private.json` (mode 0600), so a rerun reuses the same account and upload instead
  of adding new ones, and it writes a summary without credentials to `data/public-upload-verification.json`.

Related suites: `npm run test:connections` (the I3, I4, I5 and I7 contract, [development.md](./development.md)),
`npm run test:video` (a stored-video check through the running local stack, [capture-testing.md](./capture-testing.md))
and `npm run test:pipeline:live` (a real GPU run, [deployment.md](./deployment.md#acceptance-test)).

## Known issues

- Every `memory` row, including its `sourceUrl` and `manifestUrl`, is public in SpacetimeDB, and anyone with a file's
  URL can read the file. The owner-scoped listing is a convenience, not access control.
- The Node runtime's S3/R2 mode is covered by unit tests with the real AWS presigner, but no test runs it against a real
  bucket (the hosted deployment uses the Cloudflare runtime). Before relying on it, check that a PUT with another
  `Content-Type` is refused and that the bucket's CORS policy admits the web app's origin.
- Behind a reverse proxy, such as the Caddy of the Docker Compose setup, the Node runtime sees a single client address,
  so all clients share the per-address password limits.
- `/api/pipeline/*` exists only on Cloudflare. With the Node runtime, the worker publishes to the bucket with its own
  credentials.
- `/api/scenes/*` sends no CORS headers, so library scene publishing works only where the library and the API share an
  origin.
- A PUT that is never completed leaves its object in storage, and nothing cleans these up.
- The worker never retries a `failed` memory, and a worker stopped mid-job leaves its row `processing`.
