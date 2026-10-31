# Capture testing

`/capture.html` is a diagnostics page of the web app ([apps/web/capture.html](../apps/web/capture.html), code in [apps/web/src/capture](../apps/web/src/capture/) and [apps/web/src/upload](../apps/web/src/upload/)). It checks the path from a recording to stored bytes, apart from any 3D reconstruction, and proves three things separately:

1. a clip is produced: a simulated camera recording, or a real video exported from the glasses;
2. SpacetimeDB holds its memory row, found by an independent query;
3. the stored file downloads byte for byte identical to the recording (same size and SHA-256).

Video bytes live in storage: local disk with `npm run upload:local`, S3 or R2 in a deployment. The memory row holds the ID, title, source URL, duration, owner, assigned worker and processing status. "Uploaded" means stored, not yet a 3D scene: without a running pipeline worker every row stays `uploaded`. The page doesn't control the glasses (the [iPhone app](./ios.md) does), reconstruct anything or render scenes. The library links to it as "Capture diagnostics ↗".

## Local services

The page needs SpacetimeDB with the module published, the upload API and the web dev server; [development](./development.md) explains each. For a test on one computer, from the repository root:

```bash
npm run stdb:start           # SpacetimeDB on 127.0.0.1:3055 (to move it, set STDB_PORT for every command)
npm run stdb:publish:local   # once: creates or updates the memory-replay database
npm run upload:local         # upload API on 127.0.0.1:8788, videos under data/uploads/
LOCAL_HTTP=1 npm run dev     # web app on http://127.0.0.1:5173, proxying /stdb and /api
```

Open http://127.0.0.1:5173/capture.html and wait for "Connected" in the header. No cloud account or GPU is needed. Keep `data/uploads/` and the SpacetimeDB data directory between runs, since the rows point at the files. `data/uploads/.worker-identity.json` holds the local pipeline worker's identity and token, minted on the upload service's first start: deleting it orphans the rows already assigned to that worker.

The upload service builds upload URLs and video URLs from `PUBLIC_ORIGIN` (default `http://127.0.0.1:5173`), and it accepts browser requests only from that origin plus those listed in `UPLOAD_ALLOWED_ORIGINS`. Whenever the page is opened from another origin (the HTTPS dev server, a LAN address, a tunnel), restart the upload service with `PUBLIC_ORIGIN` set to exactly that origin. Rows uploaded before keep their old URLs.

## On/Off demo with a simulated camera

1. Open `/capture.html` and wait for "Connected". The "On / Off demo" card shows an animated scene marked "SIMULATED CAMERA · NO GLASSES", and its badge reads OFF.
2. Keep the "Test title" or enter your own, then click **On** (or press O). The badge changes to "● RECORDING", the ball moves and the timer counts up to 30 s.
3. After 3–5 seconds click **Off** (or press F). The badge goes through SAVING and UPLOADING while the clip is uploaded and checked; don't pick a file or press any upload button.
4. A pass shows the badge "PASS · OFF", the status "PASS — database row #N; B bytes downloaded and identical to your recording…" and the clip's SHA-256. The page queried the API for the row independently and compared the downloaded video with the recording; a stopped timer alone is not a pass.
5. "Stored recordings" selects the new `[SIMULATION] …` row (marked "test") and the address gains `?request=<request ID>`. Press **Verify stored file** for the stored size and, with local storage, the SHA-256 the storage recorded, then play the video: it shows the animated scene with its recorded timer.
6. Reload the page: the row and playback persist (the PASS badge is page state and resets). Each further recording gets its own row.

The scene is simulated, but the browser encodes a real MP4 (WebM where the browser can't record MP4) from the canvas at 24 fps, uploads real bytes and creates a real row. That covers On/Off → recording → upload → database → playback. It doesn't cover glasses pairing, camera permissions, glasses streaming or reconstruction.

Each simulated clip is a test upload: it is requested with `"pipeline": false`, so the row is assigned to its uploader instead of the pipeline worker and is never reconstructed. The page fails the run if the upload service doesn't confirm that ("The upload service does not support test uploads…") or if the row comes back assigned to the worker.

Details:

- The keys are ignored while you type in a field, with modifier keys, and while held down. F while off does nothing, and O while recording doesn't start a second clip.
- Recording stops at 30 seconds or when the tab is hidden, so keep it visible. A clip under a quarter of a second is rejected ("Clip too short…"); press **New test** to try again.
- The demo needs MediaRecorder, canvas capture and Web Crypto, so it runs only on `localhost` or HTTPS ("This browser cannot record the test scene…" otherwise).
- While a clip is recording, saving, uploading or waiting for a retry, the page asks before you leave it.

## Upload a real glasses video

1. Record on the glasses at 1080p, 30 fps with stabilization off ([recording guide](./recording-guide.md)), export the clip from the Meta AI app (MP4 or MOV), and check that it plays on the phone.
2. On `/capture.html` open "Test a real glasses video". In "Upload a video" enter a unique "Title" and choose the clip under "Video"; the preview should show your scene.
3. Press **Upload video**. Progress reads "Uploading N%", then "Verifying upload and registering memory…", and ends with "Uploaded. Database row #N verified. Open Capture test to play the stored video." A full progress bar alone is not a pass.
4. In "Stored recordings" select that title. Check the row ID and its `uploaded` status, press **Verify stored file**, then play it. The player loads the row's source URL from storage, not the file you picked.
5. Reload and play it again. To check persistence across restarts, restart the upload service and SpacetimeDB with the same data directories and repeat.

How it differs from the simulation:

- The panel reads `GET /api/account/config` first, refuses a clip over the server's `maxUploadBytes` ("Choose a shorter clip (up to N MiB).") and requests reconstruction unless the server reports `pipelineAvailable: false`. `npm run upload:local` always advertises its local worker, so the row is assigned to that worker and stays `uploaded` until a [pipeline worker](./deployment.md) processes it.
- It doesn't download and hash the stored file in the browser. Use **Verify stored file** and playback, or `npm run test:video` for the byte comparison.
- The browser reads the clip's duration. If it can't ("This browser cannot read the video. Export an MP4/H.264 copy and retry."), export an H.264 MP4 copy.
- **Cancel** aborts the transfer. If the confirmation fails after the transfer finished, press **Upload video** again with the same file and title in the same tab: while the receipt is valid (one hour) it only repeats the confirmation.

The library (`/library.html`) has the same "Upload a video" panel, enabled once you sign in ("Sign in first." until then); a finished upload there reads "Video saved. Use Watch original to play the stored recording…". With a local upload service, password sign-in on the site needs `ACCOUNT_SERVER_URL` set to the site's origin plus `/stdb` ([iPhone app](./ios.md#server-and-account)).

## Which recordings the page shows

"Stored recordings" lists the rows owned by this browser's identity, newest first: the account signed in on this site (in the library or the viewer), otherwise this tab's guest identity. Each entry reads `#ID · title · status`, plus `· test` for test uploads. To see the iPhone app's recordings here, sign in on the site with the same six-digit password first. `/capture.html?request=<request ID>` selects a recording.

## Check rows from a terminal

Query the local database independently with the SpacetimeDB CLI (it defaults to Maincloud, hence `-s`):

```bash
spacetime sql -s http://127.0.0.1:3055 memory-replay \
  'SELECT id, title, source_url, status, duration_us FROM memory'
spacetime sql -s http://127.0.0.1:3055 memory-replay \
  'SELECT id, title, owner, pipeline_identity, status FROM memory'
```

A test upload has `pipeline_identity` equal to `owner`; a real upload carries the worker's identity. The test passes when your unique title appears in SQL and on the page and the stored video plays what you recorded. A row whose file URL is broken is a failure, even with status `uploaded`.

## Repeatable exact-file test

With the services running, check any clip from the command line, giving its duration in seconds:

```bash
npm run test:video -- /path/to/video.mp4 DURATION_SECONDS
npm run test:video -- tests/fixtures/plant.mp4 9     # the repository's small test clip
```

[tests/integration/video.ts](../tests/integration/video.ts) mints a fresh test identity, uploads the bytes as a test upload (`"pipeline": false`), confirms the row through an independent authenticated query (status `uploaded`, assigned to the test identity, so the worker never takes it), downloads the row's source URL and compares size and SHA-256 with the original, then repeats the confirmation and checks that it returns the same row. It prints four PASS lines.

`APP_ORIGIN` (default `http://127.0.0.1:5173`) is where it reaches the API; the upload and video URLs come from the upload service's `PUBLIC_ORIGIN`, which must be reachable from this machine over plain HTTP or trusted HTTPS. It checks bytes, not decoding: watch the video in a browser too.

## Test from an iPhone

`127.0.0.1` on the phone means the phone itself, so the phone needs an address that reaches the computer. Three ways:

- **Tunnel (trusted HTTPS)**: with the default HTTPS dev server running (`npm run dev`), `npm run tunnel` (needs `cloudflared`) publishes it at a temporary `https://….trycloudflare.com` address. Restart the upload service with `PUBLIC_ORIGIN` set to that address and open `/capture.html` there on the phone. Everything works, the On/Off demo included. Each tunnel run gets a new address, so restart the upload service each time; Cloudflare may reject request bodies over about 100 MB.
- **Self-signed HTTPS on the LAN** (phone and computer on the same Wi-Fi): the default `npm run dev` serves HTTPS with a self-signed certificate on all interfaces. Run `PUBLIC_ORIGIN=https://LAN-IP:5173 npm run upload:local`, open `https://LAN-IP:5173/capture.html` on the phone and accept the certificate warning. If the page then can't connect to the database, trust the certificate on the phone or use the tunnel.
- **Plain HTTP on the LAN** (same Wi-Fi): real-video uploads work, but the On/Off demo doesn't (no Web Crypto outside a secure context). Give both services the same origin; Vite needs `PUBLIC_ORIGIN` too when you use a hostname rather than an IP address:

  ```bash
  PUBLIC_ORIGIN=http://LAN-HOST:5173 npm run upload:local
  PUBLIC_ORIGIN=http://LAN-HOST:5173 LOCAL_HTTP=1 VITE_HOST=0.0.0.0 npm run dev
  ```

`LAN-IP` is the computer's local network address and `LAN-HOST` that address or the computer's local hostname (`scutil --get LocalHostName` prints it on a Mac, to use as `NAME.local`).

## Failure and retry

1. Stop only the upload service (Ctrl-C in its terminal), record another clip and press **Off**.
2. Expect an error ("Upload service unavailable. Start npm run upload:local." and "Your clip is retained in this tab…"), the badge "NEEDS RETRY", and **Retry upload / verify**, **New test** and **Download this test clip**.
3. Keep the tab open, start `npm run upload:local` again with the same settings and click **Retry upload / verify**. The clip passes without recording again.

A retry after a failed confirmation reuses the same receipt, and with it the same request ID and database row, while the receipt is valid (one hour). A failed transfer or an expired receipt gets a new signed upload; upload URLs last 15 minutes. The failed clip exists only in that tab, so download it before leaving. The iPhone app keeps its queue and clips across restarts instead ([iPhone app](./ios.md#the-upload-queue)).

## Troubleshooting

- **Port already in use**: reuse the running server or stop it first; don't start a second copy. When 5173 is taken, Vite moves to the next free port, which no longer matches `PUBLIC_ORIGIN`.
- **"Upload service unavailable…" or HTTP 502**: start `npm run upload:local`. Vite proxies `/api` to 127.0.0.1:8788 (`UPLOAD_PORT`).
- **The header never says "Connected"**: check that SpacetimeDB runs on 3055 (or the same `STDB_PORT` for every command) and that `memory-replay` is published.
- **"Origin not allowed"**: the page's origin isn't `PUBLIC_ORIGIN` or in `UPLOAD_ALLOWED_ORIGINS`. Use exactly the same origin for the upload service, the dev server and the browser.
- **"The upload service does not support test uploads…"**: the running upload service ignores `"pipeline": false`; restart it from the current checkout.
- **"This browser cannot record the test scene…"**: open the page on `localhost` or HTTPS in a current Chrome or Safari.
- **The iPhone can't open the page**: check the network (guest and venue Wi-Fi often isolate devices), the address, that the dev server listens on all interfaces (the default HTTPS mode, or `VITE_HOST=0.0.0.0`), and the computer's firewall.
- **The row exists but playback fails**: check the host in its source URL (the `PUBLIC_ORIGIN` at upload time), that the upload service runs and that the file is in `data/uploads/`. If the browser can't decode the codec, export an H.264 MP4.
- **The status stays `uploaded`**: expected without a running pipeline worker. Test uploads always stay `uploaded`.

## Limitations

- Recordings aren't private: memory rows are public to every client of the database, and anyone with a video URL can fetch it.
- The page doesn't check an S3/R2 deployment, reconstruction or Quest rendering. "Verify stored file" shows a SHA-256 only for local storage; other storage shows the size when its CORS settings expose it.
- The `/capture.html?request=…` link that `npm run test:video` prints doesn't find its row, because the page lists only the browser's own recordings and the row belongs to the script's identity; use the SQL query or the printed hash instead.
