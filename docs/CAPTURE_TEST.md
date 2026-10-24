# Wayfarer → iPhone → stored video test

This test proves three things separately: a camera produces a clip, SpacetimeDB contains its record, and the stored clip can be retrieved and played. Video bytes live in local disk storage (or configured S3/R2); the `memory` table contains the ID, title, source URL, duration and processing status. `uploaded` is the expected final status for this test without a GPU worker.

The native iPhone app and standalone **Replay Demo** now use **On** and **Off** buttons. See [PHONE_APP.md](PHONE_APP.md) for installation, Simulator testing, offline recovery and actual glasses setup. The browser page at `/capture.html` provides the same demo flow plus exported-video upload; it does not control the glasses directly.

## Quick On/Off demo — no glasses needed

Use this first to test the recording and automatic-upload experience. Keep the local database, upload service and web app running as described in section 1 below. If they are already running, reuse them.

1. On your **Mac**, open or refresh **http://127.0.0.1:5173/capture.html**. Wait for **Connected**. The **On / Off demo** panel shows an animated sample scene labeled **SIMULATED CAMERA · NO GLASSES**.
2. Leave the test title or enter your own. Click **On**. The badge should change to **RECORDING**, the ball should move, and the timer should advance. You can also press `o` on the keyboard after clicking outside the title field.
3. Wait 3–5 seconds and click **Off**, or press `f`. Recording stops and upload/verification starts automatically. Do not select a file or click the manual upload button.
4. Expect **PASS · OFF** and **database row #…; … bytes downloaded and identical to your recording**. The test queries SpacetimeDB independently and compares the downloaded video's SHA-256 with the recording. A timer stopping alone is not a pass.
5. In **Stored recordings**, the new `[SIMULATION]` row is automatically selected. Press **Play**. You should see the animated scene and its recorded timer. Reload to confirm the row and playback persist; the in-memory PASS badge resets on reload.
6. Press O/F again for another recording. Each completed recording should get its own database ID. Pressing F while off does nothing; repeated O while recording does not create extra clips.

The scene is simulated, but the browser encodes a real MP4 (or WebM where needed), uploads real bytes, and creates a real database row. This tests the O/F → recording → upload → database → playback path. It does **not** verify Meta pairing, camera permissions, glasses streaming, or 3D reconstruction. The row is a **test upload**: it is assigned to your own identity instead of the pipeline worker, so the worker never processes it (section 4). Stored recordings marks it `test`.

Keep the tab visible. Recording stops after 30 seconds or when the page is hidden. Keyboard shortcuts are ignored while editing text. This simulator needs localhost or trusted HTTPS; plain HTTP to a Mac hostname from an iPhone does not provide the browser security features used for hashing.

**Failure/retry test:** stop only the upload-service terminal with Ctrl-C, record another clip and press F. Expect an error plus **Retry upload / verify**, with **Download this test clip** available. Keep the tab open, restart `npm run upload:local` using the same settings, then click Retry. The clip should pass without recording again. If confirmation fails after transfer, the retry reuses its receipt and database request ID while the receipt remains valid. A new signed upload may be needed after expiry or a failed transfer. The browser retains a failed clip only in the current tab; download it before leaving. The native app persists its queue and local MP4s across relaunches.

## 1. Start the local services

Run these commands from the repository root with Node 22.12+ and SpacetimeDB CLI 2.13.0. Run `npm ci` once after pulling the branch.

If SpacetimeDB already says `Starting SpacetimeDB listening on 127.0.0.1:3055`, leave that terminal running. That message is success; `PostgreSQL wire protocol server disabled` is normal for this app. Otherwise, in terminal A:

```bash
npm run stdb:start          # 127.0.0.1:3055; STDB_PORT=<port> changes it for every script and the Vite proxy
```

Publish the module once if `memory-replay` has not already been published:

```bash
npm run stdb:publish:local
```

See [P4 setup](P4.md#run-without-cloud-credentials) if the CLI has no login or reports database ownership errors. Keep an existing database; do not delete it to troubleshoot publication.

For a Mac-only upload test, terminal B:

```bash
npm run upload:local
```

Terminal C (reuse an already running HTTP app on port 5173):

```bash
LOCAL_HTTP=1 npm run dev
```

Open **http://127.0.0.1:5173/capture.html**. Expect a connected database indicator. Files are saved under ignored `data/uploads/`; no cloud credentials are needed. Keep that directory and the database's data directory between runs.

### Make the same app reachable from your iPhone

Put the Mac and iPhone on the same trusted Wi-Fi. Get the Mac hostname:

```bash
scutil --get LocalHostName
```

For example, if it prints `Jerrys-MacBook`, use `http://Jerrys-MacBook.local:5173`. Stop only your running upload/Vite commands with Ctrl-C and restart terminals B and C with the same origin (replace `YOUR-MAC`):

```bash
# Terminal B
PUBLIC_ORIGIN=http://YOUR-MAC.local:5173 npm run upload:local
```

```bash
# Terminal C
PUBLIC_ORIGIN=http://YOUR-MAC.local:5173 LOCAL_HTTP=1 npm run dev -w apps/web -- --host 0.0.0.0
```

Open `http://YOUR-MAC.local:5173/capture.html` in iPhone Safari first. Allow local-network access if requested. `localhost` or `127.0.0.1` on the iPhone refers to the phone, not your Mac. Upload new clips after changing `PUBLIC_ORIGIN`: old database URLs retain their original hostname. This HTTP setup is for the local capture test; immersive WebXR requires trusted HTTPS.

## 2. Test a real glasses recording

1. Pair the Wayfarers in Meta AI and set video to 1080p at 30 fps with stabilization off (the pipeline's capture rules, [PLAN.md](PLAN.md) §5). Wear them, point at a distinct object or a card saying `Wayfarer test 01`, and record 10–15 seconds. For the glasses' built-in recorder, press and hold the capture button to start, then press it again to stop. Import through Meta AI, save/export the clip and confirm it plays on the iPhone. These controls and import/export are documented in [Ray-Ban's FAQ](https://www.ray-ban.com/usa/c/frequently-asked-questions-ray-ban-meta-smart-glasses).
2. In Safari at `/capture.html`, expand **Test a real Wayfarer video instead**, enter a unique title such as `Wayfarer desk 01` and choose that exported MP4/MOV. Alternatively AirDrop it to the Mac and use the Mac page. The selected-video preview should show your test object.
3. Press **Upload video**. Wait for 100% and the **Uploaded. Database row #… verified.** message. A progress bar alone is not a pass.
4. In **Stored recordings**, select the same title. Check its database ID and `uploaded` status. Press **Verify stored file**; local storage should report a nonzero byte count and SHA-256 hash.
5. Press **Play** in the stored video player. Confirm the test object and movement match your recording. This player loads the database's source URL, not the file picker preview.
6. Reload the page, select the same title again and play it. The row and video should survive a page reload. To check persistence across service restarts, restart the upload service and the same database data directory, then repeat.

You can independently inspect database records from a terminal:

```bash
spacetime sql -s http://127.0.0.1:3055 memory-replay \
  'SELECT id, title, source_url, status, duration_us FROM memory'
```

**Pass:** your unique title appears in SQL and the web list, and the stored video plays the scene you recorded. A row with a broken file URL is a failure even if its status is `uploaded`.

## 3. Repeatable database + exact-file test

With all three services running, use a real exported clip and its duration in seconds:

```bash
npm run test:video -- /absolute/path/to/wayfarer.mp4 15
# If using the LAN origin instead:
APP_ORIGIN=http://YOUR-MAC.local:5173 npm run test:video -- /absolute/path/to/wayfarer.mp4 15
```

The command uploads bytes, confirms the row using an independent authenticated database query, downloads the row's source URL and compares size/SHA-256 with the original, then repeats completion and checks that the ID is unchanged. It prints four PASS lines and a playback link. It creates a separate test identity/title, and its row is a test upload that the pipeline worker never takes. Use the browser to verify visual content/decoding too.

## 4. Next: the pipeline worker

No worker exists yet, so every row stays `uploaded`. When it runs, it takes `uploaded` rows assigned to its identity:

- **Which uploads it gets.** Clips from the upload panel (**Upload video**) are queued for it. Test uploads are not: the O/F simulation and `npm run test:video` presign with `"pipeline": false`, which assigns the row to the uploader. Check with `spacetime sql -s http://127.0.0.1:3055 memory-replay 'SELECT id, title, owner, pipeline_identity, status FROM memory'`: a test row has `pipeline_identity` equal to `owner`.
- **Its identity and token.** With `upload:local`, the worker identity is minted on the service's first start and kept in `data/uploads/.worker-identity.json`; its `token` is the worker's `PIPELINE_TOKEN` for `scripts/pipeline-status.py`. Keep that file: deleting it orphans the rows already assigned to the old identity. With `service.mjs` (S3/R2), mint one with `curl -X POST $STDB_HTTP_URL/v1/identity`, set its `identity` (without `0x`) as `PIPELINE_IDENTITY`, and keep the `token` on the worker only.
- **What it may download.** Any client can register a memory with any `sourceUrl`. The worker downloads only URLs under `ASSET_BASE_URL` (with `upload:local`: under `PUBLIC_ORIGIN/api/local-media/`) whose key names the row's owner, at most 2 GiB and a few minutes, without following redirects. `scripts/source_check.py` has the check: `allowed_source(url, base, owner)`.
- **Reaching it from Runpod.** With `upload:local`, `PUBLIC_ORIGIN` must be the public tunnel URL, or the worker can't fetch the clips; `STDB_HTTP_URL` can be the tunnel URL plus `/stdb`. Cloudflare may cap request bodies at 100 MB, so try an upload over 100 MB through the tunnel before the demo (unverified), or use R2.

## Evidence and troubleshooting

Verified on Jerry's branch: 16 automated tests, TypeScript checks, production web build, real local SpacetimeDB multiplayer/HTTP integration, real upload/SQL/SHA-256/idempotency checks, and browser upload plus stored-video playback. The tested MP4 was 27,967 bytes, SHA-256 `6e1e5488ae4d538cb816a8c6ece63fbfbb427944d097fb5987d3c08aece30ebe`.

| Symptom                       | Check                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Port already in use           | Reuse the existing server or stop its terminal before restarting; don't start a duplicate.                                               |
| Upload API unavailable / 502  | Start `npm run upload:local`; Vite proxies `/api` to port 8788.                                                                          |
| Database connection fails     | Check the server on 3055 (or your `STDB_PORT`) and that `memory-replay` was published.                                                   |
| iPhone cannot reach Mac       | Same Wi-Fi, correct `.local` hostname, Vite `--host 0.0.0.0`, local-network permission and firewall.                                     |
| Origin not allowed            | Use the exact `PUBLIC_ORIGIN` in both commands and the phone URL.                                                                        |
| Row exists but playback fails | Check its source URL hostname, upload service and stored file; export H.264 MP4 if the browser cannot decode the original codec.         |
| Status stays `uploaded`       | Expected: no pipeline worker exists yet to move it to `processing`/`ready`. Test uploads stay `uploaded` even with a worker (section 4). |

These local test videos and database rows are readable by clients of this demo server. The capture test needs no GPU or cloud account. It does not verify S3/R2 deployment, 3D reconstruction, or Quest rendering.
