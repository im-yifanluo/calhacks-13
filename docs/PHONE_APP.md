# Memory Replay phone app and demo

The buttons are **On** and **Off**. On starts a recording; Off finalizes a video-only MP4, saves it on the phone, queues upload automatically, queries SpacetimeDB independently, then downloads the stored video and compares SHA-256 hashes. A successful result says **PASS · Database row #… · Download matches recording**. Video bytes are in local disk/S3/R2 storage; the database holds their record and URL.

There are two native iPhone projects, with shared recording, upload, library and settings code:

| Open in Xcode | Feed | Requirements |
| --- | --- | --- |
| `apps/ios/SceneCaptureDemo.xcodeproj` | Clearly labeled animated demo scene; real H.264 MP4 and database writes | Xcode 15.4+, iOS 17.2+. Runs on iPhone or Simulator, no Meta SDK, no camera permission |
| `apps/ios/SceneCapture.xcodeproj` | Live Ray-Ban Meta camera stream | Compatible paired glasses, iPhone, Meta AI app, Meta DAT 1.0.1 and its supported Xcode toolchain |

The demo's `[SIMULATION]` clips presign with `pipeline: false` and verify that the returned database row belongs to the uploader's test queue. They never request reconstruction. An imported real MP4 is a normal upload, even from the demo app. Neither app implements reconstruction; uploads remain `uploaded` until a separate worker processes them.

The **Party** tab opens the shared viewer using the saved server address. Create a party or enter a seven-character invite code; name-and-key sign-in and leader-controlled playback run in the system browser. See [PARTIES.md](PARTIES.md) for setup and testing. Finish recording/upload before switching to the browser.

## Fast demo on your Mac

1. Start the three services using [CAPTURE_TEST.md §1](CAPTURE_TEST.md#1-start-the-local-services): SpacetimeDB on **3055**, upload service on **8788**, and the HTTP web app on **5173**. Publish `memory-replay` once. Keep an existing database and reuse existing services. If using port 3000 instead, set `STDB_PORT=3000` for **all** service commands, publication and Vite.
2. Open **SceneCaptureDemo.xcodeproj**, select **SceneCaptureDemo** and an installed **iPhone Simulator**, then Cmd-R. No Apple development team is needed for Simulator. Do not disable code signing: Simulator's Keychain needs the generated app identity.
3. The simulator defaults to `http://127.0.0.1:5173`. In **Settings**, tap **Test connection**. Expect **Database connected**.
4. Open **Capture**, tap **On**, wait 3–5 seconds, tap **Off**. The preview's timer advances only while recording. On is disabled while recording; Off is disabled while idle. The demo stops automatically at 30 seconds or when backgrounded.
5. Scroll to **Your recording**. Expect **PASS**, a database ID and a hash. Tap **Play stored video**. This plays the URL returned by the database. **Play latest local clip** plays the phone's copy and also works offline.
6. Open `http://127.0.0.1:5173/capture.html` on the Mac, select the `[SIMULATION] Phone demo` row and play it independently. The row is marked `test`. Keyboard O/F remain available in the browser; the buttons are called On/Off.

Command-line alternative to Cmd-R (from the repository root):

```bash
npm run ios:demo:build
xcrun simctl list devices available
# Boot a listed iPhone UUID if necessary, then:
xcrun simctl boot YOUR_SIMULATOR_UUID
xcrun simctl bootstatus YOUR_SIMULATOR_UUID -b
xcrun simctl install YOUR_SIMULATOR_UUID /tmp/memreplay-ios-demo/Build/Products/Debug-iphonesimulator/SceneCaptureDemo.app
xcrun simctl launch YOUR_SIMULATOR_UUID com.memreplay.SceneCaptureDemo
```

The command-line build uses `/tmp` because cloud-synced folders can attach Finder metadata that breaks ad-hoc signing. If Xcode reports **resource fork / Finder information** during signing, set its Derived Data location outside iCloud/Dropbox, or use the command above. Do not work around it by disabling signing.

## Names, scene status and the web library

The current UI adds a name-based guest profile. After saving the server address,
enter your name and tap **Continue with this name** before recording. Returning
users retain the same Keychain identity. Settings lets you change the name without
changing your ID. First-time setup requires the upload service; once configured,
recordings can still queue locally during an outage.

**Memories** shows reconstruction status and offers **Open in 3D** and a share link
when the worker supplies a valid manifest. It refreshes every five seconds while
the app is active. **Web viewer URL** in Settings is optional when upload and web
hosting share an origin. For separate hosting, both services must use the same DB.
The web library is `/library.html`. See [FRONTEND_FLOW.md](FRONTEND_FLOW.md).

The earlier simulator verification below predates these UI additions. This Mac
currently has Command Line Tools only; the new Swift sources were syntax-checked,
not rebuilt for iPhone/Simulator.

## Install on your iPhone

1. Connect your iPhone to the Mac, open **SceneCaptureDemo.xcodeproj**, and select the phone as the run destination. In **Signing & Capabilities**, select your Apple development team and a unique bundle identifier. Follow Xcode's pairing and Developer Mode prompts, then Cmd-R.
2. Put both devices on the same Wi-Fi. Follow [the LAN setup](CAPTURE_TEST.md#make-the-same-app-reachable-from-your-iphone), using `http://YOUR-MAC.local:5173` as `PUBLIC_ORIGIN` for both upload and Vite. Vite must use `--host 0.0.0.0`. Allow local-network access on iPhone.
3. In app **Settings**, enter that exact `.local` origin, tap **Save server**, then **Test connection**. `127.0.0.1` on a physical phone means the phone, not the Mac. A trusted HTTPS app origin works too; a self-signed HTTPS server is not trusted automatically.
4. Repeat On → wait → Off → PASS → Play stored video. Keep the app foreground through verification. New recordings use the current storage origin; old records retain their old URLs.

After initial name setup, no server? You can still demonstrate On/Off, save a real MP4, play it offline and export it from **Saved videos**. The UI reports **Upload pending**, not PASS. Configure the server later and tap **Retry uploads**.

## Prove recovery and persistence

- Stop only the upload service. Record and tap Off. Expect one pending upload and a playable local MP4.
- Close/relaunch the app. The clip remains under **Saved videos → On this phone** and in the pending queue. Do not uninstall the app, which removes its local files.
- Restart the same service, foreground the app or tap **Retry uploads**. Expect PASS without recording again. Completion retries retain the same receipt/request ID while valid. Failed transfer or receipt expiry obtains a fresh ticket; a timeout after successful transfer can leave an unreferenced file in storage.
- Refresh **Saved videos** or reopen the browser to confirm the database row and stored playback survive relaunch. Tokens stay in Keychain, keyed by server origin. Local MP4 copies remain in Files → On My iPhone → Replay Demo/Memory Replay → Captures; **Export** shares a copy.
- Changing servers does not silently move an in-progress upload: restore its original origin to finish it.

## Use the actual Wayfarer camera

Meta's [CameraAccess sample requirements](https://github.com/facebook/meta-wearables-dat-ios/blob/main/samples/CameraAccess/README.md) currently list **Xcode 26.4+, Swift 6.3+, iOS 17.2+**. The glasses project is separate so its binary SDK does not prevent building the demo with Xcode 15.4. The glasses target still requires full compilation and physical-device testing with the supported toolchain.

1. Open **SceneCapture.xcodeproj** with the supported Xcode. Set your signing team/unique bundle ID, select your paired physical iPhone, and let Swift Package Manager resolve Meta DAT **1.0.1**.
2. In Meta AI, enable glasses Developer Mode following Meta's current instructions. That mode does not need app credentials; release channels need your `META_APP_ID` and `CLIENT_TOKEN` in build settings. The callback scheme is `scenecapture://`.
3. Run the app, configure its server, tap **Connect with Meta AI**, finish registration/permissions and return. Tap **Start Session**, then **Preview glasses camera**.
4. Leave the phone stationary and turn your head. The preview must follow the glasses. Tap **On**, wait 10–15 seconds, tap **Off**. Off stops recording and preview, retains the MP4 and uploads automatically. It does not power off the glasses or operate their built-in 3K recorder.
5. Expect PASS and play the stored clip. The SDK stream is requested at high resolution/24 fps; this is not a claim of built-in 3K/30 capture. Video only, 90-second limit. Backgrounding ends the session and attempts to finish the recording; start a new session on return.

For a real glasses clip without the newer Xcode: record using the glasses' physical capture button, export through Meta AI, then upload the MP4/MOV from the browser's import panel. The native file importer currently accepts MP4 only.

## Source layout and regeneration

`SceneCaptureApp.swift` is the shared UI. `DemoCapture.swift` supplies synthetic frames; `GlassesCapture.swift` supplies SDK frames. `Recorder.swift` writes H.264 MP4s. `SceneLibrary.swift` persists the queue/catalog, obtains a database identity, transfers clips and verifies stored bytes. The two projects compile different capture sources; the demo has no Meta package reference.

Run `npm run ios:generate` after changing source layout. Generated projects and plists are committed; regeneration resets personal signing customizations. Do not put videos, credentials, DerivedData or `xcuserdata` in git.

## Verification on this branch

Checked on 24 October 2026 with Xcode 15.4 and iPhone 15 Simulator (iOS 17.5): the standalone demo builds with ad-hoc signing, records playable MP4s, retains a failed upload through app relaunch/update, automatically retries, and plays the stored URL. A 12.68-second phone clip produced database row #1 with SHA-256 `a1e586447bc8d9720e00cb3bc00e7c5200d5f210d72eed2a3cf649ec78b49921`; its database owner and pipeline identity match, confirming a test upload. A later 30-second recording also passed verification and the time limit. IDs/hashes are evidence from this local database, not hardcoded expectations for another installation.

The shared recorder smoke test, 88 Vitest tests (2 existing skipped), 75 viewer tests, TypeScript checks, production web build and live SpacetimeDB integration test passed. Physical iPhone installation, live Wayfarer capture, R2/S3 and reconstruction remain unverified. The full Meta SDK target cannot compile with the installed Xcode 15.4; only the independent demo target was built and run here.
