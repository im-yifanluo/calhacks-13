# Wayfarer → iPhone → stored video test

This test proves three things separately: a camera produces a clip, SpacetimeDB contains its record, and the stored clip can be retrieved and played. Video bytes live in local disk storage (or configured S3/R2); the `memory` table contains the ID, title, source URL, duration and processing status. `uploaded` is the expected final status for this test without a GPU worker.

The branch includes an iPhone app with a live glasses preview and **O · ON / F · OFF** recording buttons. The browser page at `/capture.html` includes an O/F simulation and an exported-video upload flow. It does not control the glasses directly.

## Quick O/F simulation — no glasses or Xcode needed

Use this first to test the recording and automatic-upload experience. Keep the local database, upload service and web app running as described in section 1 below. If they are already running, reuse them.

1. On your **Mac**, open or refresh **http://127.0.0.1:5173/capture.html**. Wait for **Connected**. The **O / F simulation** panel shows an animated sample scene labeled **SIMULATED CAMERA · NO GLASSES**.
2. Leave the test title or enter your own. Click **O · ON**. The badge should change to **RECORDING**, the ball should move, and the timer should advance. You can also press `o` on the keyboard after clicking outside the title field.
3. Wait 3–5 seconds and click **F · OFF**, or press `f`. Recording stops and upload/verification starts automatically. Do not select a file or click the manual upload button.
4. Expect **PASS · OFF** and **database row #…; … bytes downloaded and identical to your recording**. The test queries SpacetimeDB independently and compares the downloaded video's SHA-256 with the recording. A timer stopping alone is not a pass.
5. In **Stored recordings**, the new `[SIMULATION]` row is automatically selected. Press **Play**. You should see the animated scene and its recorded timer. Reload to confirm the row and playback persist; the in-memory PASS badge resets on reload.
6. Press O/F again for another recording. Each completed recording should get its own database ID. Pressing F while off does nothing; repeated O while recording does not create extra clips.

The scene is simulated, but the browser encodes a real MP4 (or WebM where needed), uploads real bytes, and creates a real database row. This tests the O/F → recording → upload → database → playback path. It does **not** verify Meta pairing, camera permissions, glasses streaming, the native app, or 3D reconstruction.

Keep the tab visible. Recording stops after 30 seconds or when the page is hidden. Keyboard shortcuts are ignored while editing text. This simulator needs localhost or trusted HTTPS; plain HTTP to a Mac hostname from an iPhone does not provide the browser security features used for hashing.

**Failure/retry test:** stop only the upload-service terminal with Ctrl-C, record another clip and press F. Expect an error plus **Retry upload / verify**, with **Download this test clip** available. Keep the tab open, restart `npm run upload:local` using the same settings, then click Retry. The clip should pass without recording again. If confirmation fails after transfer, the retry reuses its receipt and database request ID while the receipt remains valid. A new signed upload may be needed after expiry or a failed transfer. The browser retains a failed clip only in the current tab; download it before leaving. The native iPhone app has a separate persistent queue.

## 1. Start the local services

Run these commands from the repository root with Node 22.12+ and SpacetimeDB CLI 2.13.0. Run `npm ci` once after pulling the branch.

If SpacetimeDB already says `Starting SpacetimeDB listening on 127.0.0.1:3000`, leave that terminal running. That message is success; `PostgreSQL wire protocol server disabled` is normal for this app. Otherwise, in terminal A:

```bash
spacetime start --listen-addr 127.0.0.1:3000
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

Open `http://YOUR-MAC.local:5173/capture.html` in iPhone Safari first. Allow local-network access if requested. `localhost` or `127.0.0.1` on the iPhone refers to the phone, not your Mac. Use the same `.local` address in the native app. Upload new clips after changing `PUBLIC_ORIGIN`: old database URLs retain their original hostname. This HTTP setup is for the local capture test; immersive WebXR requires trusted HTTPS.

## 2. Test a real glasses recording now, without building iOS

1. Pair the Wayfarers in Meta AI. Wear them, point at a distinct object or a card saying `Wayfarer test 01`, and record 10–15 seconds. For the glasses' built-in recorder, press and hold the capture button to start, then press it again to stop. Import through Meta AI, save/export the clip and confirm it plays on the iPhone. These controls and import/export are documented in [Ray-Ban's FAQ](https://www.ray-ban.com/usa/c/frequently-asked-questions-ray-ban-meta-smart-glasses).
2. In Safari at `/capture.html`, expand **Test a real Wayfarer video instead**, enter a unique title such as `Wayfarer desk 01` and choose that exported MP4/MOV. Alternatively AirDrop it to the Mac and use the Mac page. The selected-video preview should show your test object.
3. Press **Upload video**. Wait for 100% and the **Uploaded. Database row #… verified.** message. A progress bar alone is not a pass.
4. In **Stored recordings**, select the same title. Check its database ID and `uploaded` status. Press **Verify stored file**; local storage should report a nonzero byte count and SHA-256 hash.
5. Press **Play** in the stored video player. Confirm the test object and movement match your recording. This player loads the database's source URL, not the file picker preview.
6. Reload the page, select the same title again and play it. The row and video should survive a page reload. To check persistence across service restarts, restart the upload service and the same database data directory, then repeat.

You can independently inspect database records from a terminal:

```bash
spacetime sql --server local memory-replay \
  'SELECT id, title, source_url, status, duration_us FROM memory'
```

**Pass:** your unique title appears in SQL and the web list, and the stored video plays the scene you recorded. A row with a broken file URL is a failure even if its status is `uploaded`.

## 3. Install the custom iPhone camera app

**Build prerequisite:** Meta's current [CameraAccess sample](https://github.com/facebook/meta-wearables-dat-ios/blob/main/samples/CameraAccess/README.md) lists **Xcode 26.4+, Swift 6.3+, and iOS 17.2+**. The Mac used for this implementation has Xcode 15.4, so a full native build, signing and physical-glasses session could not be verified here. The import test above works independently of this prerequisite.

1. With a supported Xcode installed, open `apps/ios/SceneCapture.xcodeproj`. The generated project is committed; `npm run ios:generate` is only needed to regenerate it after source layout changes and resets project signing customizations.
2. Select the **SceneCapture** target. Under **Signing & Capabilities**, choose your Apple development team and your own unique bundle identifier. Select your physical iPhone as the run destination and follow Xcode's pairing/developer-mode prompts.
3. Let Xcode resolve **Meta Wearables DAT 1.0.1**. The project uses `MWDATCore` and `MWDATCamera`; it does not use the iPhone camera as a substitute for the glasses camera.
4. Turn on the glasses Developer Mode in the Meta AI app, following Meta's current UI. Meta documents that Developer Mode requires no app credentials. Other release channels require your Wearables Developer Center `META_APP_ID` and `CLIENT_TOKEN` in the target's build settings. The project supplies the callback scheme `scenecapture://`.
5. Build and run with **Cmd-R**. Allow the requested Bluetooth/local-network access and Meta glasses-camera permission. Keep the glasses paired to this iPhone and follow any required firmware update prompts in Meta AI.
6. In **Memory Replay → Settings**, enter `http://YOUR-MAC.local:5173`, tap **Save server**, then **Test connection**. Expect **Database connected**. The app obtains its own database identity and saves the token in Keychain.

## 4. Verify the live camera and O/F controls

1. In **Camera**, tap **Connect with Meta AI** and complete registration. Return to Memory Replay, tap **Start Session**, then **Preview glasses camera**.
2. Put the iPhone on the desk. Slowly turn your head while wearing the glasses. The preview must follow the glasses' viewpoint while the phone stays still. This distinguishes a real glasses feed from the phone camera or a saved clip.
3. Enter a unique recording title. Tap **O · ON**. It starts the stream if needed and waits for live frames before displaying **RECORDING**. With a hardware keyboard attached to the iPhone, `o` also invokes this button; leave text fields before using shortcuts.
4. After 10–15 seconds tap **F · OFF** (or press `f`). It finalizes an MP4, stops the live camera preview and queues upload automatically. The preview should return to **Camera off**. The glasses remain powered on; these buttons control this app's stream/recording, not the glasses' built-in 3K recorder.
5. Wait for **Verified database row #…**. Open **Saved videos → Play stored video**. Compare it with the scene just captured. Open the browser capture page and select the same title to check the database row, storage and playback independently.
6. Tap O again for a second clip. A new title/clip should get a new database ID. Use **End Session** when finished.

This app records video only, limits a clip to 90 seconds, and ends the session when backgrounded. Keep it foreground during the first test. It requests the SDK's high-resolution 24 fps stream; that is not a promise of built-in 3K/30 recording quality. Local MP4 copies remain in **Files → On My iPhone → Memory Replay → Captures** after upload.

### Failure checks on the device

- Tap F while O is waiting for frames: recording must cancel without a successful empty-video upload.
- Stop the upload service, record a short clip and press F: the clip should appear under **Pending uploads** and remain in Files. Restart the service, then use **Retry uploads**. Keep the same saved server address.
- Interrupt an upload after file transfer: retry completion while its receipt is valid; it should return the same database row. Receipt expiry may require a fresh upload.
- Background during recording: on return, start a new session. Check that the preceding clip was finalized or an explicit error was shown; inspect the local file if finalization failed.

## 5. Repeatable database + exact-file test

With all three services running, use a real exported clip and its duration in seconds:

```bash
npm run test:video -- /absolute/path/to/wayfarer.mp4 15
# If using the LAN origin instead:
APP_ORIGIN=http://YOUR-MAC.local:5173 npm run test:video -- /absolute/path/to/wayfarer.mp4 15
```

The command uploads bytes, confirms the row using an independent authenticated database query, downloads the row's source URL and compares size/SHA-256 with the original, then repeats completion and checks that the ID is unchanged. It prints four PASS lines and a playback link. It creates a separate test identity/title; it does not access the iPhone app's token. Use the browser to verify visual content/decoding too.

For a synthetic recorder smoke test on macOS:

```bash
swiftc -parse-as-library -module-cache-path /tmp/scene-swift-cache \
  apps/ios/SceneCapture/Recorder.swift scripts/test-recorder.swift \
  -o /tmp/memreplay-recorder-test
/tmp/memreplay-recorder-test /tmp/unique-capture-test.mp4
npm run test:video -- /tmp/unique-capture-test.mp4 2
```

Choose a fresh output filename. This creates a two-second animated test pattern using the app's MP4 writer, not footage from glasses.

## Evidence and troubleshooting

Verified during implementation: 16 automated tests, TypeScript checks, production web build, real local SpacetimeDB multiplayer/HTTP integration, the recorder's playable two-second MP4, real upload/SQL/SHA-256/idempotency checks, and browser upload plus stored-video playback. The tested MP4 was 27,967 bytes, SHA-256 `6e1e5488ae4d538cb816a8c6ece63fbfbb427944d097fb5987d3c08aece30ebe`. Native transport/recorder Swift typechecking and UI syntax parsing passed; full Meta SDK/iOS compilation and physical-device acceptance remain unverified.

| Symptom                       | Check                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Port already in use           | Reuse the existing server or stop its terminal before restarting; don't start a duplicate.                                               |
| Upload API unavailable / 502  | Start `npm run upload:local`; Vite proxies `/api` to port 8788.                                                                          |
| Database connection fails     | Check the server on 3000 and that `memory-replay` was published.                                                                         |
| iPhone cannot reach Mac       | Same Wi-Fi, correct `.local` hostname, Vite `--host 0.0.0.0`, local-network permission and firewall.                                     |
| Origin not allowed            | Use the exact `PUBLIC_ORIGIN` in both commands and the phone URL.                                                                        |
| Row exists but playback fails | Check its source URL hostname, upload service and stored file; export H.264 MP4 if the browser cannot decode the original codec.         |
| Status stays `uploaded`       | Expected here. P1/P2 must run reconstruction before it becomes `processing`/`ready`.                                                     |
| Native preview stays off      | Check Meta registration, Developer Mode, camera permission, available glasses, firmware, then restart the session. Read the shown error. |

These local test videos and database rows are readable by clients of this demo server. The capture test needs no GPU or cloud account. It does not verify S3/R2 deployment, 3D reconstruction, or Quest rendering.
