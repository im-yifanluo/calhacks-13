# Runpod worker integration

## Integrated team revisions and acceptance

Branch `codex/phone-runpod-integration` combines Nikko's `origin/nikko` at `cec6e48` (actual SceneCapture recording, portable accounts and upload queue) with Yifan's pipeline from PR #7 at `5da8a28` and the memos upload/SpacetimeDB components. Only the pipeline portion of PR #7 is imported; its separate viewer follow-mode changes are outside this integration. The experimental `pipeline/fourd/` scripts remain experiments; the automatic worker invokes the established `memreplay` stages, not the experimental 4DGS training scripts.

The input is a **recorded video**, as confirmed for acceptance. A single photo is not supported by this pipeline. The app requires at least 1280 px on the long edge, approximately 24 fps or higher (including 23.976), and an audio track. Request 30 fps for capture. The verified DAT recording averages 24.93 fps; the existing normalization stage converts it to a 30 fps timeline. This resampling does not recover dropped frames or make the source a native 30 fps recording.

Run the worker in the authenticated project owner's RunPod account. No teammate pod ID is required. Account authorization is separate from a running GPU: verify the pod's SSH access, installed models and real output before claiming GPU acceptance. See [RUNPOD_ACCOUNT.md](RUNPOD_ACCOUNT.md) for account setup and portable connection helpers.

From a fresh checkout on macOS with Xcode, Node 22.23.2 and SpacetimeDB 2.13.0 available on PATH:

```sh
npm ci
npm run test:pipeline
```

This compiles and runs the **actual SceneLibrary**, Recorder, AccountKey and CaptureRequirements code against isolated real SpacetimeDB and local Cloudflare R2. The phone's Keychain/preferences are isolated; pipeline stage computation and manifest assembly are substituted with a synthetic fixture. It verifies transport and orchestration, not reconstruction quality:

- A stale `pipelineAvailable:false` seen at sign-in is refreshed before the next upload.
- The app uploads a valid encoded MP4, registers its account as owner, downloads identical bytes and gets the assigned worker identity.
- A committed completion with a lost response, followed by an expired receipt and app restart, recovers one memory without a duplicate upload/job.
- The actual Python worker polls that memory, downloads the exact MP4, invokes each stage, publishes a synthetic manifest and updates the same database row to `ready`; the API and WebSocket client both observe it.
- A deliberately failed GPU stage reports `failed`, leaves no ready manifest and exits nonzero in `--once` mode.
- A separate 91 MiB multipart scene-asset test verifies transfer integrity beyond the phone's per-request limit.

After authenticated pod setup below, run the **real acceptance check** on the Mac:

```sh
npm run test:pipeline:live -- --clip /absolute/path/to/glasses-recording.mp4
```

It creates a dedicated test account, uses the real phone upload queue, waits up to two hours for the running GPU worker, checks `ready` in both the account API and website WebSocket subscription, validates `memory.json` with the website's validator, and requires nonempty reconstructed splats plus every referenced asset to be publicly readable. It never substitutes stages or falls back to storage-only mode. `--api https://your-api.example` and `--timeout-seconds 7200` override the target and wait. Evidence is written to ignored `data/pipeline-acceptance-*/result.json`; `account.json` alongside it is mode 0600 and contains the test account's password, so keep it private. A failed or timed-out check stays failed; it never counts an upload alone as completion. This executes the app's network/queue code on macOS; a final physical-phone capture still requires the rebuilt app on an iPhone.

The standalone Cloudflare entrypoint `server/upload/cloudflare.mjs` and `wrangler.jsonc` let the same API run without the Sites checkout. Set the documented runtime values and R2 binding before deployment. The existing memos website continues using the shared core through `sites-worker.ts`; do not create a second SpacetimeDB database for a separate phone API.

---

The phone sends a raw video to `https://memos.alightdell64.chatgpt.site` using the existing account/presign/PUT/complete contract in [UPLOAD_API.md](UPLOAD_API.md). Completion registers the authenticated uploader as `memory.owner` in `jerry-memory-replay-phone-20261024`. The website's personal library filters by that owner. Use the **same password** on the phone and website; matching names do not imply the same identity.

The confirmed phone recording is memory **#6, “Nikko end-to-end test 01”**, 17.185556 seconds, 13,499,271 bytes, SHA-256 `5c4953296a3d007c7799196187569322488e4288edd20f6d4cd8b2607b4a404e`. Its bytes were independently read from hosted R2 and matched the phone's screenshot. It is a stored video, not a reconstructed scene.

## Data flow

1. Phone → upload service (I2): password auth, presigned raw PUT, completion receipt.
2. Upload service → SpacetimeDB (I3): `create_memory` with owner, source URL and assigned pipeline identity.
3. Runpod → SpacetimeDB (I4): one `memreplay worker` polls its assigned `uploaded` rows and reports progress through `set_memory_status`.
4. Runpod downloads the allowed source video and runs the existing S1–S7 reconstruction pipeline.
5. Runpod → upload service → R2 (I5): worker-authenticated multipart scene uploads, 16 MiB per request, at most 2 GiB per asset. No R2 credentials are needed on the pod. Assets, external tracks, colliders and splat-sequence frames are published before `memory.json`.
6. After successful publication, the worker sets `ready` with the public manifest URL. The website/Quest loads those assets and party members receive the same scene through SpacetimeDB (I7).

The existing phone video upload remains limited to 90 MiB. Multipart here applies to **worker-generated scene assets**. GPU reconstruction remains disabled on the live site until a worker is configured. The repository's two iOS upload queues check `/api/account/config` and save recordings without requesting reconstruction when `pipelineAvailable` is false. The integrated SceneCapture app distinguishes those storage-only records from queued jobs and refreshes capabilities before a new upload. It retains the signed receipt's original worker assignment across retries. Both queues check `maxUploadBytes` before PUT. A rebuilt app is needed to receive source changes.

## One-time setup when a pod is available

Use the existing [pipeline runbook](../pipeline/README.md#5-runpod-setup-once) to prepare a CUDA 12.8-compatible GPU pod, its Python environments and model weights. Keep the repo, caches and work directory on a network volume at `/workspace`; Runpod documents that network volumes persist independently of pods: https://docs.runpod.io/pods/storage/types . Select current GPU capacity and pricing at provisioning time. A Runpod API key is used for provisioning; it is **not** the worker's SpacetimeDB token.

From this repo on your Mac, create a stable worker identity once:

```sh
node scripts/configure-runpod-worker.mjs https://memos.alightdell64.chatgpt.site data/runpod-worker.env
```

This explicit command creates a SpacetimeDB identity and writes credentials to an ignored file with mode 0600. It prints only the public identity and file path. Reuse that file on restarts; the script refuses to overwrite it. Copy it securely to `/root/memos-worker.env` on the pod with mode 0600, then symlink `/workspace/memos-worker.env` to it. The current RunPod network volume ignores chmod, so do not store the token directly on that volume. Do not paste the token into chat, a browser URL or Git. The example is `pipeline/runpod/worker.env.example`.

Set **only `PIPELINE_IDENTITY`** in the upload service's runtime environment to that public identity. The token stays on the worker. On the pod, from this repo:

```sh
bash pipeline/runpod/start-worker.sh --check
tmux new -s memos-worker 'bash /workspace/memory-replay/pipeline/runpod/start-worker.sh'
```

The startup preflight checks CUDA, the world-environment imports, ffmpeg/ffprobe and the ViPE checkout, then verifies the bearer credential and exact server/database/identity agreement. It imports this checkout through `PYTHONPATH` even if a shared environment has an older editable install. Run only one worker per identity: a filesystem lock prevents duplicate starts in the same work directory, but does not coordinate separate pods/directories. The setup requires the `world` and `vipe` environments from the existing pipeline runbook. Set `TORCH_CUDA_ARCH_LIST=9.0` before setup for an H100-only build; `env.sh` preserves overrides.

For a single assigned test memory, use `bash pipeline/runpod/start-worker.sh --once --memory-id 123`. Do not run this alongside the continuous worker. `--once` returns a nonzero exit code for a failed job, an unavailable database or a missing requested job. The continuous worker keeps polling and reports failures to the database. Status calls retry transient network failures; publication finishes before `ready` is written.

Upload a short new clip with `pipeline:true` once the worker is active. Previously stored `pipeline:false` recordings remain outside the queue; re-upload the clip with reconstruction enabled to process it. Confirm `uploaded → processing → ready`, open the returned manifest URL, then test the owner's library and a shared party on another device. If the worker fails, its status becomes `failed`; inspect the pod logs before retrying. A worker killed during a job can leave a `processing` row: this preparation does not introduce distributed claims or crash recovery; use one worker and inspect/recover stuck jobs explicitly.

## Worker storage protocol

All `/api/pipeline/*` calls require `Authorization: Bearer <PIPELINE_TOKEN>`. The API verifies the token with SpacetimeDB and checks that the memory is assigned to this worker and currently `processing`. User account passwords cannot publish pipeline assets.

| Method/path | Request | Response |
| --- | --- | --- |
| GET `/api/pipeline/config` | Worker bearer | Version, server, database, worker identity, part/asset limits |
| POST `/api/pipeline/assets/start` | `{memoryId:"6",path:"background/room.spz",size:123456}` | `{ticket,partBytes,partCount,partUrl,assetUrl}` |
| PUT `/api/pipeline/assets/part?ticket=…&part=1` | Raw bytes, exact Content-Length, worker bearer | `{partNumber,etag}` |
| POST `/api/pipeline/assets/complete` | `{ticket,parts:[{partNumber:1,etag:"…"}]}` | `{stored:true,size,assetUrl}` |
| POST `/api/pipeline/assets/abort` | `{ticket}` | `{aborted:true}` |

Part numbers start at 1; all but the last part are exactly `partBytes`. Tickets expire after 24 hours. Same-part retries replace that part, and completion is idempotent for the same upload. The Python client retries transient failures up to three times, never forwards credentials across redirects, and attempts to abort an unsuccessful transfer. R2's multipart behavior is documented at https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ . Public media supports HEAD and byte ranges for the viewer.

## Validation

```sh
npm test
npm run typecheck
PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -p test_hosted_worker.py
xcrun swiftc -parse-as-library apps/ios/CameraAccess/UploadQueue.swift scripts/test-ios-upload.swift -o /tmp/memos-native-upload-test
UPLOAD_TEST_NATIVE_BIN=/tmp/memos-native-upload-test UPLOAD_TEST_WORKER_DIR="$PWD/data/hosted-phone-site" npm run test:upload-api
```

The Worker integration test uses a real isolated SpacetimeDB and local R2, synthetic scene data, and the actual Python multipart publisher. It tests transport/status/ownership, not GPU reconstruction. The generated assets remain in temporary storage. No live user's clip is processed by this test.

Account libraries separate owned records, including browser imports keyed by server/database/identity. Existing unowned browser imports are retained on disk but must be re-imported after sign-in; they are not silently assigned to whichever person signs in first. Browser imports are still device-local. Shared scene links and party records remain public as in the existing demo; these library changes are not an asset privacy or encryption system.

Verified during this change: 160 Vitest tests plus 112 viewer tests passed (3 existing skips); the additional IndexedDB ownership test passed; TypeScript checks and hosting builds passed; the actual Swift upload queue passed no-worker fallback, lost-confirmation recovery and byte equality; the standalone SceneCaptureDemo iOS Simulator build passed. The actual Python publisher transferred a synthetic 91 MiB asset through local R2, and the assigned worker updated the live local database/subscription to ready. GPU reconstruction and physical-device retesting are still separate checks.
