# Deployment

A deployment has five parts. The database and the web app alone are enough to watch and share scenes; the upload API and
storage add recordings; the GPU worker turns recordings into scenes.

- **SpacetimeDB**, on Maincloud: accounts, memories, parties, the shared clock, takes and grabs. Browsers, the upload
  API and the worker all talk to it directly.
- **Object storage**, Cloudflare R2 or another S3-compatible store: videos and scene files.
- **The upload API**: signs and checks uploads and issues six-digit passwords ([upload-api.md](./upload-api.md)).
- **The web app**: static files for the viewer, the library and the capture test page.
- **The GPU worker**, on Runpod: `memreplay worker`, which reconstructs queued uploads.

The hosted deployment runs the web app and the upload API from one Cloudflare Worker with R2 storage, against a
Maincloud database. Its public build settings, including the database name and hostnames, are in
[`apps/web/.env.hosted`](../apps/web/.env.hosted).

## SpacetimeDB on Maincloud

Publish the module from the repository root, signed in as the CLI identity that owns the database:

```bash
spacetime login
spacetime publish -s https://maincloud.spacetimedb.com --module-path server/spacetime --delete-data=never <database>
```

- `--delete-data=never` never clears the database: a schema change that SpacetimeDB can't apply to the existing rows
  fails instead.
- Only the database's owner can publish to it. If a publish is refused for permissions, sign in as the owner, or publish
  under a new name and point every setting at that name. Never delete a database to get past the error.
- The CLI defaults to Maincloud, so a command meant for the local server needs `-s http://127.0.0.1:3055`.
- After a schema change, regenerate the client bindings with `npm run stdb:generate` (they are generated from the module
  source into `apps/web/src/module_bindings/`), rebuild the web app and deploy it after the module. The upload API and
  the worker call reducers over HTTP (`register_account`, `set_display_name`, `create_memory` and `set_memory_status`),
  so keep those signatures compatible or update their callers in the same release.

To check the deployed database, run the four-client party suite against it. It leaves its test memories and party in the
database:

```bash
STDB_DATABASE=<database> STDB_WS_URL=wss://maincloud.spacetimedb.com npm run test:party
```

## Object storage

What storage needs depends on the upload API's runtime.

**Cloudflare Worker** (standalone or the hosted site): one R2 bucket, bound as `BUCKET`. The Worker writes uploads and
published scenes into it and serves them at `/media/` to any origin, so the bucket needs neither public access nor a
CORS policy. A second private bucket, bound as `ACCOUNT_PASSWORDS`, can hold the password registry.

**Node** (Docker or any Node host): a bucket that is publicly readable at `ASSET_BASE_URL` (an R2 custom domain or
public bucket URL, or a CDN in front of the bucket). Browsers PUT videos straight to the bucket and the viewer reads
scenes from it, so its CORS policy must admit every web app origin:

```json
[
  {
    "AllowedOrigins": ["https://memos.example"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag", "Content-Length"]
  }
]
```

- The upload API's credentials must be able to presign PUTs and HEAD objects under `videos/`. The worker downloads
  videos from their public URLs and uses its own credentials to write scenes, with their content types, under
  `memories/`.
- Keep the password registry in a separate private bucket (`ACCOUNT_PASSWORD_BUCKET`): anyone can download the encrypted
  registry from a public one. Its store must support conditional PUTs (`If-Match` and `If-None-Match`).
- When a web app origin changes, such as a tunnel URL, update the CORS policy and the API's `UPLOAD_ALLOWED_ORIGINS`
  together. The iPhone app's uploads don't need CORS.

To put a finished scene in the bucket by hand, use `memreplay publish <work> --to s3`
([pipeline runbook](../pipeline/README.md)). It keeps the scene's folder structure, which matters because `memory.json`
refers to its files by relative path.

## The upload API

### Settings shared by every runtime

- `STDB_HTTP_URL=https://maincloud.spacetimedb.com` and `STDB_DATABASE=<database>`: the web app's database. The API's
  advertised `server` (`ACCOUNT_SERVER_URL`, default `STDB_HTTP_URL`) must equal the web app's `VITE_STDB_URL` with
  `https:` for `wss:`, or a password made on one doesn't work on the other.
- `UPLOAD_SIGNING_SECRET`: at least 32 random characters, never changed, because it also keys the password registry. To
  generate one: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
- `UPLOAD_ALLOWED_ORIGINS`: every web app origin that calls the API.
- `PIPELINE_IDENTITY`: the GPU worker's public identity ([worker credentials](#worker-credentials)). On Cloudflare it
  stays unset until a worker runs.

The API needs no administrator or database-owner token. Every setting is listed in
[upload-api.md](./upload-api.md#configuration).

### Docker Compose with HTTPS

[`server/upload/deploy/docker/`](../server/upload/deploy/docker/) runs the Node service with S3/R2 storage behind Caddy,
which obtains and renews the HTTPS certificate. It needs a host with Docker Compose, a DNS name you control pointing at
it, and ports 80 and 443 open:

```bash
cp server/upload/deploy/docker/.env.example server/upload/deploy/docker/.env
# Replace every placeholder, including UPLOAD_DOMAIN, the API's hostname.
docker compose -f server/upload/deploy/docker/compose.yaml up --build -d
```

- The image holds only the upload package's runtime dependencies and source: its ignore file keeps `.env` files, keys,
  videos and `data/` out of the build. It runs as the unprivileged `node` user, with a health check on `/api/health`.
  Caddy starts once the API is healthy and keeps its certificates in the `caddy_data` volume.
- Without Compose, build and run the image behind your own HTTPS proxy:

  ```bash
  docker build -f server/upload/deploy/docker/Dockerfile -t memos-upload .
  docker run --rm --env-file server/upload/deploy/docker/.env -p 8788:8788 memos-upload
  ```

- Without Docker, on any host with Node 22.13 or later: install the runtime dependencies with
  `npm ci --omit=dev --ignore-scripts --workspace server/upload`, then run `NODE_ENV=production npm run upload:start`
  with the settings in the environment. The process listens on `0.0.0.0:8788` (`PORT` changes the port) and stops
  cleanly on SIGTERM. TLS terminates at your proxy or platform.

Behind Caddy, or any reverse proxy, the API sees a single client address, so all clients share the password rate limits
([upload-api.md](./upload-api.md#rate-limits)).

### A standalone Cloudflare Worker

[`deploy/cloudflare/wrangler.jsonc`](../server/upload/deploy/cloudflare/wrangler.jsonc) deploys the API on its own as
the Worker `memos-upload`, with the R2 bucket `memos-scene-assets` bound as `BUCKET` (edit the name to use another
bucket). From the repository root:

```bash
npx wrangler login
npx wrangler r2 bucket create memos-scene-assets
npx wrangler deploy --config server/upload/deploy/cloudflare/wrangler.jsonc \
  --var STDB_HTTP_URL:https://maincloud.spacetimedb.com --var STDB_DATABASE:<database> \
  --var PUBLIC_ORIGIN:https://<worker-host> --var UPLOAD_ALLOWED_ORIGINS:https://<web-app-host>
npx wrangler secret put UPLOAD_SIGNING_SECRET --config server/upload/deploy/cloudflare/wrangler.jsonc
```

- `PUBLIC_ORIGIN` is the Worker's own origin; upload and media URLs are built from it. Until the secret is set, the
  Worker answers 503.
- Wrangler replaces a Worker's variables on each deploy: pass the same `--var` values every time, or set them in the
  Cloudflare dashboard and deploy with `--keep-vars`.
- Add `PIPELINE_IDENTITY` only while a GPU worker runs. Without it, the API reports `pipelineAvailable: false`, stores
  recordings without queuing them and refuses `"pipeline": true`.
- The Worker accepts clips up to 90 MiB, serves the stored files at `/media/` and takes the GPU worker's scene files. It
  has no `/api/connections`. Library scene publishing needs the web app on the same origin, which only the hosted site's
  combined Worker provides.
- `UPLOAD_TEST_R2=1 npm run test:upload-api` runs this Worker locally (`wrangler dev --local`) against an isolated
  database.

### The hosted site's combined Worker

The hosted site serves the web app and the upload API from one Cloudflare Worker, built from a separate Sites (Vinext
starter) checkout. [`deploy/sites/worker.ts`](../server/upload/deploy/sites/worker.ts) is that checkout's Worker entry.
It answers `/api/*` and `/media/*` with the upload API; `/`, `/index.html` and party paths (`/` and seven capital
letters or digits) with the viewer page; `/library`, `/library/` and `/library.html` with the library; and everything
else from the static assets. With the app and the API on one origin, browser uploads need no CORS and library scene
publishing works.

The steps are in [`deploy/sites/README.md`](../server/upload/deploy/sites/README.md): copy the Worker entry and
`server/upload/src/` into the checkout, build the web app into it with
`node scripts/deploy/build-hosted-web.mjs <checkout>/public`, keep the R2 binding `BUCKET` and the `ASSETS` binding as
described there, set the runtime settings in the Sites dashboard (never in Git) and deploy with the Sites workflow.
Rebuilding alone doesn't update the live site. To test a checkout's built Worker locally:
`UPLOAD_TEST_WORKER_DIR=<absolute checkout path> npm run test:upload-api`.

### Check the upload API

```bash
curl https://api.memos.example/api/health
curl https://api.memos.example/api/account/config
npm run connections:check -- https://api.memos.example
```

- `/api/health` answers `{"status":"ok"}` while the process runs, and on Cloudflare 503 when a setting or binding is
  missing. It says nothing about the bucket or the database.
- `/api/account/config` must show the web app's `server` and `database`. `maxUploadBytes` and `pipelineAvailable` show
  the runtime and whether uploads are queued for a worker.
- `connections:check` (Node runtime only) reads every table the clients use, with a throwaway identity
  ([upload-api.md](./upload-api.md#connection-report)).
- `npx tsx tests/e2e/upload-public.ts https://api.memos.example` makes a real stored-only upload of the repository's
  test clip and leaves a test account, a row and the file behind ([upload-api.md](./upload-api.md#testing)). It expects
  the database in `apps/web/.env.hosted` and no configured worker.

## The web app

### Build settings

Build-time settings are compiled into the page, so they hold public values only. Set them in the environment of the
build or in an `apps/web/.env.*` file that Vite loads; [`apps/web/.env.example`](../apps/web/.env.example) lists them.

- `VITE_STDB_URL`: the SpacetimeDB WebSocket URL, such as `wss://maincloud.spacetimedb.com`. When it is unset, the app
  uses `/stdb/` on its own origin. A URL with a path must end in `/`.
- `VITE_STDB_DATABASE`: the database, default `memory-replay`.
- `VITE_UPLOAD_API`: the upload API's origin. When it is unset, the app calls `/api` on its own origin. With another
  origin, add the web app's origin to the API's `UPLOAD_ALLOWED_ORIGINS`.
- `VITE_ASSET_ORIGIN_ALIASES`: comma-separated former origins of this app. After a hostname change, scene records still
  point at the old origin, and the viewer loads manifests on a listed origin from the current one. List only origins
  whose files now live at the current origin; other asset hosts are unchanged.

### Build and host

```bash
VITE_STDB_URL=wss://maincloud.spacetimedb.com VITE_STDB_DATABASE=<database> \
  VITE_UPLOAD_API=https://api.memos.example npm run build
```

`apps/web/dist/` then holds `index.html` (the viewer), `library.html`, `capture.html`, the bundles under `assets/` and a
copy of everything in `apps/web/public/`. Vite copies that folder whole, including the local scenes and test files Git
ignores in `public/memories/`, `public/local/` and `public/splat-test/`: remove them from `dist/` before publishing, or
use the [hosted build](#the-hosted-build), which copies only the demo scenes.

Serve `dist/` over HTTPS (WebXR, camera access and the capture page's hashing need a secure context) at the root of its
domain (the bundles use root-relative `/assets/` URLs). The host must also:

- answer unknown paths with `index.html`. Party addresses are `/<CODE>` (seven letters or digits) and `/upload` opens
  the upload panel, and people open and refresh these addresses directly;
- serve `/library` as `library.html`, because the viewer links to `/library#import-scene`;
- without `VITE_STDB_URL` and `VITE_UPLOAD_API`, proxy `/stdb/` to SpacetimeDB with the prefix removed, for both HTTP
  and WebSocket traffic (the SDK exchanges its token over HTTP before it opens the WebSocket), and `/api` to the upload
  API, as the dev server does.

### The hosted build

```bash
node scripts/deploy/build-hosted-web.mjs <checkout>/public
```

[`build-hosted-web.mjs`](../scripts/deploy/build-hosted-web.mjs) builds the web app in `hosted` mode, which reads
`apps/web/.env.hosted`, into the given folder (emptying it first). It copies only `public/demo/` and `public/mock/`,
never local scenes. The suites in `tests/e2e/` read the same file for their default target. Then deploy the checkout as
in [the hosted site's combined Worker](#the-hosted-sites-combined-worker).

## The GPU worker on Runpod

One GPU pod runs `memreplay worker` under its own SpacetimeDB identity: it polls for the uploads assigned to it,
reconstructs them and publishes the scenes ([upload-api.md](./upload-api.md#the-worker-handoff)). People using the app
never deal with Runpod.

### The pod

Set the pod up once as in the [pipeline runbook](../pipeline/README.md#5-runpod-setup-once): a CUDA 12.8 GPU pod with
SSH on TCP 22 and a network volume at `/workspace`, which holds the repository (`/workspace/memory-replay`), the Python
environments, the model weights and the work folders, and survives pod stops. Run `setup.sh base world vipe warmup` once
and `on_start.sh` after every start. For an H100-only pod, set `TORCH_CUDA_ARCH_LIST=9.0` before the setup. A running
pod bills even when idle, and a network volume bills until it is deleted.

### The Runpod account and SSH

- Install Runpod's CLI, `runpodctl`, and sign in. The account's API key is for provisioning only and is not the worker's
  SpacetimeDB token: never copy it into the worker's environment, the web app or the iPhone app.
- Register an SSH public key with the account (`runpodctl ssh add-key --key-file <key>.pub`) and keep the private key on
  the laptop.
- `runpodctl ssh info <pod-id>` shows the pod's direct SSH host and port. Both change when the pod restarts.

### Worker credentials

The worker needs its own SpacetimeDB identity. For a Cloudflare-runtime API without a worker yet:

```bash
node scripts/deploy/configure-runpod-worker.mjs https://memos.example data/runpod-worker.env
```

[`configure-runpod-worker.mjs`](../scripts/deploy/configure-runpod-worker.mjs) reads the API's `/api/account/config` and
refuses if a worker is already configured (reuse that worker's file instead). It mints an identity on that database's
server and writes the worker's settings as `export` lines, with mode 0600: `STDB_HTTP_URL`, `STDB_DATABASE`,
`MEMREPLAY_UPLOAD_API`, `ASSET_BASE_URL` (`<api>/media`), `MEMREPLAY_WORK` (`/workspace/work`), `PIPELINE_IDENTITY` and
`PIPELINE_TOKEN`. It never overwrites a file, creates no Runpod resource and prints only the public identity, which
becomes the API's `PIPELINE_IDENTITY` once the worker runs.
[`pipeline/runpod/worker.env.example`](../pipeline/runpod/worker.env.example) shows the same file.

For the Node runtime, mint the identity with `curl -sX POST https://maincloud.spacetimedb.com/v1/identity` and give the
worker the bucket settings instead of `MEMREPLAY_UPLOAD_API` (the runbook's
[worker section](../pipeline/README.md#6-worker-upload--pipeline--ready)).

Keep the file on the pod's container disk, not on the network volume, which may ignore `chmod`:

```bash
# On the pod, after copying the file over SSH to /root/memos-worker.env:
chmod 600 /root/memos-worker.env
ln -sf /root/memos-worker.env /workspace/memos-worker.env
```

The container disk is wiped when the pod stops, so copy the file again after each start. `start-worker.sh` follows the
link (`MEMREPLAY_WORKER_ENV` sets another path) and refuses a file that anyone but its owner can access. Never paste the
token into chat, a URL or Git.

### Start the worker

On the pod, from the repository:

```bash
bash pipeline/runpod/start-worker.sh --check
tmux new -s memos-worker 'bash /workspace/memory-replay/pipeline/runpod/start-worker.sh'
```

- `--check` runs the preflight and stops: the credential file's permissions; the `world` and `vipe` environments and
  their CUDA access; `ffmpeg`, `ffprobe` and `flock`; the ViPE checkout and `source_check.py`; and finally
  (`python -m memreplay.hosted_publish`) that the upload API accepts the worker's token and agrees on the server,
  database and identity.
- Then set `PIPELINE_IDENTITY` on the upload API and start the worker in tmux, where it survives SSH disconnects. It
  imports the pipeline from this checkout. A lock file in the work folder stops a second worker there, but nothing
  coordinates two pods: run one worker per identity.
- `bash pipeline/runpod/start-worker.sh --once --memory-id 123` processes one queued memory and exits nonzero when the
  job fails, the database is unreachable or the memory isn't queued for this worker. Don't run it next to the continuous
  worker.
- The preflight needs `MEMREPLAY_UPLOAD_API`, that is, a Cloudflare-runtime API. For a Node-runtime deployment, run
  `memreplay worker` in the `world` environment (`source pipeline/runpod/env.sh && use world`) with the bucket settings
  instead.

To try the worker, upload a short new clip with `"pipeline": true`, watch it go from `uploaded` through `processing` to
`ready`, then open it in a party from a second device. Clips stored earlier with `"pipeline": false` stay out of the
queue: upload them again. A failed job shows `failed` with its error; the worker's log is in its tmux session. When the
worker stops for good, remove `PIPELINE_IDENTITY` from a Cloudflare-runtime API, so that new recordings are stored
instead of waiting in the queue.

### Provisioning with a deadline

[`provision-runpod-worker.py`](../scripts/deploy/provision-runpod-worker.py) creates the worker pod with a hard runtime
limit, for a first paid session. It runs on the laptop (under `caffeinate` on macOS, so that the laptop stays awake)
and:

- reads its plan (`deployment-plan.json`: the image, GPU, data center and network volume) from `data/runpod-account/`,
  where it also records the pod and its deadline, and refuses to create a second pod while `pod-active.json` is there;
- creates one pod with `runpodctl`, with SSH, the network volume at `/workspace`, `TORCH_CUDA_ARCH_LIST=9.0` and a
  deadline three hours away;
- starts [`runpod-deadline.py`](../scripts/deploy/runpod-deadline.py) inside the pod, as
  `/workspace/memos-ops/deadline.py`, before the image's normal start command. It stops the pod at the deadline with the
  pod's own injected API key, so no account key enters the pod, and logs to `deadline.log` next to it.
  `python3 /workspace/memos-ops/deadline.py --check` reads the pod's state without stopping it;
- keeps a second watchdog running on the laptop, which stops the pod at the deadline or when the script is interrupted,
  and confirms that it stopped.

Both guards stop the pod; neither terminates it or deletes the network volume, which keeps billing. The in-pod guard
refuses a deadline more than three hours ahead. The script checks its plan against the values it was written for (one
H100 PCIe GPU, a 50 GB container disk and a 100 GB network volume in one data center) and runs `runpodctl` from the path
in its `CLI` constant; edit both for another setup.

### Laptop helpers

Copy [`pipeline/runpod/ssh.env.example`](../pipeline/runpod/ssh.env.example) to `data/runpod-account/ssh.env` (ignored
by Git) and fill in the pod's direct SSH host and port and the absolute path of the private key; `MEMREPLAY_SSH_CONFIG`
points the helpers at another file. Refresh the host and port after each pod restart.

- `remote.sh`: the shared SSH settings, sourced by the other helpers. Host keys are remembered in
  `data/runpod-account/known_hosts`, and a changed key is refused.
- `bash pipeline/runpod/pod.sh '<command>'`: runs a command on the pod, for example
  `bash pipeline/runpod/pod.sh 'nvidia-smi -L'`.
- `bash pipeline/runpod/sync.sh`: copies the source to the pod's repository folder, leaving out `data/`, credentials,
  `.env` files and media.
- `bash pipeline/runpod/pull.sh <clip-id> [...]`: copies a finished scene's viewer files from the pod's work folder into
  `apps/web/public/memories/<clip-id>/` for local viewing.

### Acceptance test

```bash
npm run test:pipeline:live -- --clip /absolute/clip.mp4
```

[`pipeline-live.ts`](../tests/e2e/pipeline-live.ts) runs on macOS with Xcode. It refuses an API without a configured
worker, builds the iPhone app's upload code, creates a test account and uploads the clip through that code, then waits
for the real worker: two hours by default (`--timeout-seconds` changes it). The clip must pass the app's capture checks:
at least 1280 px on the long edge, about 24 fps or more and an audio track. The test passes only when the row is `ready`
in both the API and a WebSocket subscription, the manifest passes the app's validator, the background splat is not empty
and every referenced file is readable on the scene's origin. `--api` sets the target; the default is `VITE_UPLOAD_API`
in `apps/web/.env.hosted`. The results go to `data/pipeline-acceptance-<time>/result.json`, next to `account.json`,
which holds the test account's credentials: keep it private. `npm run test:pipeline` rehearses the same path without a
GPU, against isolated local services ([ios.md](./ios.md)).

## Deployment checklist

- One database everywhere: the web app's `VITE_STDB_DATABASE` and the `STDB_DATABASE` of the API and the worker. The
  `server` in the API's `/api/account/config` equals the web app's `VITE_STDB_URL` with `https:`.
- Stable across deployments and replicas: `UPLOAD_SIGNING_SECRET`, the password storage (the bucket, the
  `ACCOUNT_PASSWORDS` or `BUCKET` binding, or `LOCAL_UPLOAD_DIR`), `STDB_DATABASE`, `ACCOUNT_SERVER_URL` and the
  worker's identity. Changing any of them loses passwords, pending uploads or queued jobs
  ([upload-api.md](./upload-api.md#changing-the-secret-the-database-or-the-storage)).
- CORS: `UPLOAD_ALLOWED_ORIGINS` lists every web app origin exactly (scheme, host and port). With the Node runtime, the
  bucket's CORS policy lists the same origins. Update both when an origin changes.
- Static hosting answers `/<CODE>` and `/upload` with `index.html`, and `/library` with `library.html`.
- After a hostname change, the old origin goes into `VITE_ASSET_ORIGIN_ALIASES`.
- No local scenes in a public build (`public/memories/`, `public/local/`, `public/splat-test/`).
- The module is published before the clients built against it, with regenerated bindings after a schema change.
- `PIPELINE_IDENTITY` is set on a Cloudflare-runtime API only while a worker runs, and the worker's token exists only on
  the worker host.
- Then check: `/api/health`, `/api/account/config`, `connections:check` (Node runtime), a stored-only test upload and,
  with a worker, `npm run test:pipeline:live`.

## Security and privacy

- **Public by design.** The module's tables are public, except its internal connection list: any client can subscribe to
  every memory row (title, owner, status, `sourceUrl`, `manifestUrl`), every profile name and every party. Anyone with a
  file's URL can read the file, from the bucket, from `/media/` or from a published scene. The owner-scoped
  `/api/memories` listing and the library are conveniences, not access control, and party codes are invitations, not
  passwords. Host only recordings meant to be shared.
- **No secrets in Git or in the page.** Never commit `.env` files: Git ignores `.env` and `.env.*`, except the
  `.env.example` templates and `apps/web/.env.hosted`, which holds public values only. `VITE_*` values are compiled into
  the page, so no storage credential or token belongs in them.
- **The worker token stays on the worker host**, on its container disk rather than the network volume. The upload API
  needs only the public identity. The Runpod API key stays on the machine that provisions pods.
- **The upload API** holds the storage credentials (Node runtime) and the signing secret, and no database-owner token.
  Keep the password registry in a private bucket.
- **Six-digit passwords** are demo-grade authentication ([upload-api.md](./upload-api.md#security-level)).
- **Test data is public too.** Suites that target deployed services (`npm run test:party`, `tests/e2e/upload-public.ts`
  and `npm run test:pipeline:live`) leave test rows that every client can see.

## Known issues

- The Node runtime's S3/R2 mode has no test against a real bucket, and the hosted deployment uses the Cloudflare
  runtime. Check the signed `Content-Type` and the bucket's CORS policy before relying on it.
- `start-worker.sh` and `configure-runpod-worker.mjs` assume a Cloudflare-runtime API: the preflight calls
  `/api/pipeline/config`, and the configure script refuses an API that reports `pipelineAvailable: true`, as the Node
  runtime always does. A Node deployment's worker is set up by hand.
- `provision-runpod-worker.py` is written for one plan and a three-hour first session, and must be edited for anything
  else.
- Behind a reverse proxy, the password rate limits apply to all clients together.
- There are no job leases: run one worker per identity. A worker stopped mid-job leaves its row `processing`, and a
  failed job isn't retried.
- The automated suites cover the worker path only with substituted reconstruction stages; `npm run test:pipeline:live`
  is the only end-to-end check with a real GPU.
