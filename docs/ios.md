# iPhone capture app

The native app in [apps/ios](../apps/ios/README.md) records a clip from Ray-Ban Meta glasses (or a simulated camera), keeps it on the phone, uploads it to the [upload API](./upload-api.md) through a durable queue that checks every upload end to end, shows each recording's processing status, and opens finished scenes and parties in the web viewer. It never reconstructs anything and never talks to SpacetimeDB directly: the upload API registers the memory row, and the pipeline worker turns the video into a scene ([architecture](./architecture.md)).

## Two Xcode projects

Both projects build the same app from the shared sources in `apps/ios/SceneCapture/`. They differ only in the camera feed.

- **`apps/ios/SceneCaptureDemo.xcodeproj`** (scheme SceneCaptureDemo, home-screen name "Replay Demo"): a simulated camera. An animated scene labelled "SIMULATED CAMERA · NO GLASSES" (640×360, about 24 fps, no audio) is encoded to a real H.264 MP4, then uploaded and verified like any other clip. No Meta SDK and no camera, Bluetooth or microphone permission. Runs in the iOS Simulator or on an iPhone, with Xcode 15.4 or later and iOS 17.2 or later.
- **`apps/ios/SceneCapture.xcodeproj`** (scheme SceneCapture, home-screen name "Memory Replay"): the live camera stream of Ray-Ban Meta glasses through Meta's Wearables Device Access Toolkit (DAT) SDK, pinned to exactly 1.0.1 through Swift Package Manager (products MWDATCore and MWDATCamera from [meta-wearables-dat-ios](https://github.com/facebook/meta-wearables-dat-ios); the pin is in `SceneCapture.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`). Needs a physical iPhone with iOS 17.2 or later, paired glasses, the Meta AI app with developer mode on, and the Xcode release the SDK supports, which is newer than the demo's minimum.

Use the demo for everything that doesn't need real footage: the UI, accounts, the upload queue, Simulator demos, and any Mac whose Xcode is too old for the SDK. Use the glasses project to capture real scenes.

The shared sources:

- [SceneCaptureApp.swift](../apps/ios/SceneCapture/SceneCaptureApp.swift): app entry and the four tabs. The `DEMO_APP` compilation condition, set only in the demo project, selects the demo feed and its texts.
- [SceneLibrary.swift](../apps/ios/SceneCapture/SceneLibrary.swift): server settings, account, local library, upload queue and verification.
- [Recorder.swift](../apps/ios/SceneCapture/Recorder.swift): the MP4 writer (H.264 video, plus AAC audio when the feed has audio).
- [CaptureRequirements.swift](../apps/ios/SceneCapture/CaptureRequirements.swift): the media check before an upload that requests reconstruction.
- [AccountKey.swift](../apps/ios/SceneCapture/AccountKey.swift): six-digit passwords and the `memos1.` session credential, in the same wire format as [apps/web/src/account/key.ts](../apps/web/src/account/key.ts).
- [GlassesCapture.swift](../apps/ios/SceneCapture/GlassesCapture.swift) (glasses project only) and [DemoCapture.swift](../apps/ios/SceneCapture/DemoCapture.swift) (demo only): the camera feeds.
- `Info.plist` (glasses) and `Info-Demo.plist` (demo): generated together with the projects.

Both apps are iPhone-only and portrait-only, with the bundle identifiers `com.memreplay.SceneCapture` and `com.memreplay.SceneCaptureDemo`. The DAT SDK is subject to Meta's [Wearables Developer Terms](https://wearables.developer.meta.com/terms) and [Acceptable Use Policy](https://wearables.developer.meta.com/acceptable-use-policy).

## Using the app

### Tabs

- **Capture**: the account form until you sign in (then "Capturing as" and your name), the camera preview, the "RECORDING TITLE" field, **Record** and **Stop & save** (O and F on a hardware keyboard, including the Simulator's), and the "Your recording" card with the upload message, the pass proof, "Play stored video", "Play latest local clip" and "Retry uploads (N)". The glasses build adds the glasses controls ([Record with the glasses](#record-with-the-glasses)).
- **Memories**: "Open web memory library" (the site's `/library.html`); "Upload status · N pending" with "Retry uploads" and "Import glasses MP4 / MOV"; "On this phone · available offline", the local clips with "Upload as …" (naming your account), "Keep on phone only · stop upload retries", "Play local clip" and "Export"; and "Confirmed SpacetimeDB records", the account's rows with their status ("Ready to explore", "Building your scene · N%", "Processing failed", "Video received · waiting for processing" or "Video saved · reconstruction not requested"), a progress bar while processing, the error when failed, "Play stored video", and for ready scenes "Open in 3D" and "Share scene / open on Quest". Pull down or tap "Refresh" to reload; the app also reloads the list every five seconds while it is in the foreground.
- **Party**: "Open party lobby" opens the web viewer in the system browser; typing a seven-character code into "7-character party code" adds "Join party", which opens `<viewer>/?room=CODE`. Sign-in, the party panel and playback all happen in the browser ([multiplayer](./multiplayer.md)); paste the password from **Copy password** into the site's sign-in to use the same account there.
- **Settings**: "Your profile" (the account), "Memory Replay server" (the server and viewer addresses with "Save server", "Use memos upload server" and "Test connection"), "How to test" and "About this build". "Six-digit password sign-in enabled" under "About this build" confirms a current build.

### Recording and local clips

- **Record** starts writing frames; **Stop & save** finishes the MP4. A title is required (up to 100 characters in the demo, 120 in the glasses build). The demo prefixes it with `[SIMULATION]` and stops by itself at 30 seconds; the glasses build stops at 90 seconds. Sending the app to the background finishes the recording.
- Clips are saved in the app's `Documents/Captures` folder, visible in Files → On My iPhone → Memory Replay (or Replay Demo) → Captures. **Export** shares a copy.
- **Not signed in**: the clip stays on the phone under "On this phone" and nothing uploads. After you sign in, **Upload as …** (with your name) queues that one clip for the account.
- **Signed in**: every new recording joins the upload queue as soon as it is saved.
- **Playback**: "Play local clip" and "Play latest local clip" play the phone's copy and work offline. "Play stored video" streams the row's source URL from storage.
- "Import glasses MP4 / MOV" copies an exported video (for example a Meta AI export) into the library and queues it under the title in the Capture tab. It needs a signed-in account, keeps the MP4 or MOV container and type, and goes through the same requirements as a recording. An imported real video is a normal upload, even in the demo app.

### The upload queue

The queue lives in `queue.json` next to the clips (the local library index is `captures.json`), so it survives app restarts and updates. Each queued clip is bound to the server address and account it was queued under. The app works through the queue on launch, when it returns to the foreground, after each saved recording, on every refresh while it is open, and on **Retry uploads**. For each clip, in order:

1. Read `GET /api/account/config` again: the server's upload limit (`maxUploadBytes`) and whether a reconstruction worker is configured (`pipelineAvailable`) can change while the app is open.
2. Decide whether to request reconstruction: yes for a real clip when the server doesn't report `pipelineAvailable: false`, never for a `[SIMULATION]` clip. If yes, check the [capture requirements](#capture-requirements).
3. Ask for an upload ticket (`POST /api/uploads/presign` with the file name, type, size, title, duration and `pipeline` flag). The ticket must echo the same `pipeline` flag, and its assignment is kept for every retry of that clip.
4. `PUT` the file to the ticket's URL with its headers, the exact `Content-Length` and no `Authorization` header.
5. Confirm it (`POST /api/uploads/complete` with the receipt).
6. Verify independently: `GET /api/memories` must list a row with the ticket's request ID and the same row ID, and the stored video downloaded from the row's source URL must have the same SHA-256 as the local file. The card then shows `PASS · Database row #N · Download matches recording` and the hash.

When anything fails, the clip stays queued with "Upload pending: …" and the reason, and the local file is untouched. Retries are safe:

- **Lost confirmation**: before asking for a new ticket, a retry looks up the previous request ID. If the row exists (the confirmation was committed but its response never arrived), the app verifies it instead of uploading again ("Recovered database row #N").
- **Failed transfer or expired receipt**: the next try gets a fresh ticket. A `PUT` that succeeded but whose response was lost can leave an unreferenced copy in storage.
- **Order**: the queue stops at the first failure, so a clip that can't pass (for example one that fails the capture requirements) holds back the clips behind it until you choose **Keep on phone only · stop upload retries**, which removes it from the queue and keeps the file.
- **Server and account**: the server address and the signed-in account can't change while uploads are pending; restore the original address or password to finish them.
- **Size**: a clip over the server's `maxUploadBytes` is refused before upload.
- **Updates**: install a new build over the existing app with the same bundle identifier and team. Uninstalling deletes the local clips and the queue.

### Capture requirements

Uploads that request reconstruction are checked on the phone first ([CaptureRequirements.swift](../apps/ios/SceneCapture/CaptureRequirements.swift)), so the pipeline only gets clips it can use. The clip must have:

- a video track at least 1280 px on its long edge;
- a nominal frame rate of at least 23.5 fps, so 23.976, 24, 25 and 30 fps pass. The pipeline resamples clips under 30 fps to a 30 fps timeline without recovering dropped frames;
- an audio track with a nonzero duration;
- a readable, positive duration.

A failing clip stays queued with its measured size, frame rate and audio in the message. Keep it on the phone and import a matching Meta AI export instead. Storage-only uploads skip the check: `[SIMULATION]` clips, and every clip sent to a server that reports `pipelineAvailable: false`. Their rows read "Video saved · reconstruction not requested".

### Server and account

- **Server address**: the upload API's origin, scheme, host and port only, without `/api` or any other path (the app appends `/api/…`). Locally that is the web dev server's origin, which proxies `/api`; **Use memos upload server** fills both addresses with the hosted site's origin (the `VITE_UPLOAD_API` value in [apps/web/.env.hosted](../apps/web/.env.hosted), hard-coded in SceneCaptureApp.swift). In the Simulator the demo starts with `http://127.0.0.1:5173`.
- **Web viewer URL (optional)**: leave it blank when the web app and the upload API share an origin; otherwise enter the web app's origin. The Party tab, "Open web memory library" and "Open in 3D" use it. Both must use the same SpacetimeDB database.
- **Transport**: plain HTTP works only for local-network names such as `http://YOUR-MAC.local:5173` (the app allows local networking); anything else needs HTTPS with a certificate the phone trusts. A self-signed development certificate isn't trusted.
- **Save server** applies the addresses. Changing the address is refused while uploads are pending or a recording is running. The Keychain keeps one account per server address, so switching back to a server restores its account.
- **Create an account**: enter a name (1–40 characters) and tap **Create password**. The upload API registers the name and returns the account, including its six-digit password; the app keeps the session credential and the password in the Keychain (this device only). A name registered to a password can't be changed, and names aren't logins: two accounts can share one.
- **Sign in with an existing account**: paste the six digits from the website's **Copy password** into "6-digit password" and tap **Sign in with saved password**. Leading zeros count; surrounding spaces are ignored; no prefix. An older `memos1.` credential also works. The app re-reads the server's capabilities, sends only the password, checks that the returned credential names the same server and database, and loads the profile before replacing the saved account. A server without password support gets an explanation instead, and the current account stays. Sign-in is disabled while uploads are pending.
- **Copy password** puts the six digits on this phone's clipboard for two minutes, for signing in on the web or a Quest. Anyone with the password can sign in as you.
- **Test connection** reads the server's account settings, loads the signed-in account and lists its recordings: "Database connected. N recordings registered for this app." Before you have an account it asks you to create one or sign in.

A password belongs to one account server and database, the pair `GET /api/account/config` reports, and the credentials made from it name that pair. The website accepts it only when that server is the SpacetimeDB address the site itself uses. For a local upload service that means starting it with `ACCOUNT_SERVER_URL` set to the web app's origin plus `/stdb` (for example `http://127.0.0.1:5173/stdb`) before creating accounts; `npm run party:dev` sets it ([upload API](./upload-api.md)).

The app calls these upload API routes: `GET /api/account/config`; `POST /api/account` (a `displayName` creates an account, a `password` or `personalKey` signs in); `GET /api/account` (the profile, with the session credential as the bearer token); `POST /api/account/password` (gives an older account its six-digit password); `POST /api/uploads/presign`; the ticket's `PUT`; `POST /api/uploads/complete`; and `GET /api/memories`. Against an older upload service without the account API it falls back to `POST /api/identity` and `/api/profile` with a raw SpacetimeDB token.

## Run the demo in the Simulator

You need a Mac with Xcode 15.4 or later, an iOS 17.2+ Simulator runtime, and the local services ([development](./development.md)): SpacetimeDB on 3055 with `memory-replay` published, `npm run upload:local`, and the web app over plain HTTP (`LOCAL_HTTP=1 npm run dev`). The Simulator reaches them on `127.0.0.1`. To also sign in on the local website with the app's password, start the upload service as `ACCOUNT_SERVER_URL=http://127.0.0.1:5173/stdb npm run upload:local` ([Server and account](#server-and-account)).

From Xcode: open `apps/ios/SceneCaptureDemo.xcodeproj`, select the SceneCaptureDemo scheme and an iPhone Simulator, and run (Cmd-R). The Simulator needs no Apple development team; Xcode signs the build ad hoc. Don't turn code signing off: the app keeps its account in the Keychain, which needs a signed app.

From the command line, at the repository root:

```bash
npm run ios:demo:build                      # xcodebuild into /tmp/memreplay-ios-demo
xcrun simctl list devices available         # pick an iPhone and copy its UUID
xcrun simctl boot SIMULATOR_UUID            # if it isn't booted yet
xcrun simctl bootstatus SIMULATOR_UUID -b
open -a Simulator
xcrun simctl install SIMULATOR_UUID /tmp/memreplay-ios-demo/Build/Products/Debug-iphonesimulator/SceneCaptureDemo.app
xcrun simctl launch SIMULATOR_UUID com.memreplay.SceneCaptureDemo
```

The build keeps its derived data in `/tmp` because cloud-synced folders (iCloud Drive, Dropbox) add Finder metadata that breaks ad hoc signing. If Xcode's signing step fails with "resource fork, Finder information, or similar detritus not allowed", move Xcode's Derived Data location out of the synced folder or build from the command line.

Then, in the app:

1. In Capture, enter a name and tap **Create password**. Settings → **Test connection** now reports "Database connected. N recordings registered for this app."
2. Tap **Record**, wait a few seconds, then tap **Stop & save**. The preview's timer runs only while recording.
3. The upload starts by itself. "Your recording" shows `PASS · Database row #N · Download matches recording` with the SHA-256.
4. **Play stored video** plays the copy from storage; **Play latest local clip** plays the phone's copy, also offline. Memories lists the row as "Video saved · reconstruction not requested".
5. To see the recording in a browser, sign in on the site with the app's password (**Copy password**) and open `/library.html` (the "Tests" filter) or `/capture.html` ([capture testing](./capture-testing.md)).

## Run on an iPhone

1. Connect the iPhone, open either project and pick the phone as the run destination. Under Signing & Capabilities choose your own development team and, if Xcode reports a conflict, a unique bundle identifier (the generator keeps both). Turn on Developer Mode on the phone when Xcode or iOS asks (Settings → Privacy & Security → Developer Mode), then run.
2. Make the services reachable from the phone: same Wi-Fi, the web dev server listening on all interfaces, and the upload service's `PUBLIC_ORIGIN` set to the address the phone uses, because upload and video URLs are built from it. With plain HTTP and the Mac's local hostname (`scutil --get LocalHostName` prints it):

   ```bash
   PUBLIC_ORIGIN=http://YOUR-MAC.local:5173 npm run upload:local
   PUBLIC_ORIGIN=http://YOUR-MAC.local:5173 LOCAL_HTTP=1 VITE_HOST=0.0.0.0 npm run dev
   ```

   `127.0.0.1` on a phone means the phone itself. A trusted HTTPS deployment works too: **Use memos upload server** selects the hosted one.

3. In Settings enter the same origin, tap **Save server**, allow local-network access when iOS asks, and sign in.
4. Record, stop, wait for PASS, and play the stored video. Keep the app in the foreground until verification finishes. Clips uploaded before a `PUBLIC_ORIGIN` change keep their old URLs.

To check recovery and persistence:

- Stop only the upload service, then record and stop. Expect one pending upload and a playable local clip.
- Quit and relaunch the app. The clip is still under "On this phone" and still pending.
- Start the upload service again with the same settings, then bring the app to the foreground or tap **Retry uploads**. Expect PASS without recording again.

## Record with the glasses

1. Open `apps/ios/SceneCapture.xcodeproj` in the Xcode release the DAT SDK supports. Set your team and bundle identifier, select the iPhone paired with the glasses, and let Swift Package Manager resolve DAT 1.0.1.
2. Turn on developer mode for the glasses in the Meta AI app, following Meta's instructions in the [SDK repository](https://github.com/facebook/meta-wearables-dat-ios). The target's build settings `META_APP_ID = 0` and an empty `CLIENT_TOKEN` are the developer-mode defaults; an app registered with Meta puts its own values there (regeneration keeps them). Meta AI returns to the app through the `scenecapture://` URL scheme.
3. Run the app, set its server and sign in.
4. In Capture, tap **Connect with Meta AI**, finish registration and permissions in Meta AI, and return. The status line then shows "Registered", the number of glasses detected and the session state. When Meta reports that the glasses' developer software needs an update, **Update glasses developer software** opens Meta's update flow.
5. Tap **Start Session**; the first time, Meta AI asks for camera and microphone permission. **Preview glasses camera** starts the preview (Record starts it too). Keep the phone still and turn your head: the preview must follow the glasses.
6. Tap **Record**, wait 10–15 seconds, tap **Stop & save**. It stops the recording and the preview and, when signed in, starts the upload; it doesn't switch off the glasses or use their built-in recorder. **End Session** releases the glasses.

The app asks the SDK for its `.high` resolution at 30 fps with 44.1 kHz mono PCM audio, and writes H.264 and AAC on the SDK's timestamps. The stream can deliver fewer frames than requested (about 25 fps); the requirements allow that. If no frames arrive within 15 seconds of tapping Record, it gives up with "No live frames received…". A paused or stopped session finishes the recording, and sending the app to the background ends the session; start a new one on return.

Without an Xcode that can build the SDK: record with the glasses' own capture button, export the clip from Meta AI, and import it with "Import glasses MP4 / MOV" in either app, or upload it in the browser ([capture testing](./capture-testing.md)). The glasses' own recordings are also the fallback when a live clip fails the requirements.

## Checks

### Check programs in apps/ios/Tests

Each file in [apps/ios/Tests](../apps/ios/Tests) is a standalone macOS command-line program, compiled with `xcrun swiftc -parse-as-library` together with the app sources it exercises; neither Xcode project includes them. They run the real app code, with in-memory stand-ins for the Keychain and preferences where they need SceneLibrary.

- **ContractChecks.swift**: offline. Encodes real MP4s with Recorder and runs CaptureRequirements on them: 30, 25 and 24 fps at 1280 px with audio pass; 15 fps, 640 px and silent clips fail. Also checks six-digit sign-in input (leading zeros, surrounding whitespace, rejection of 5 or 7 digits, letters and full-width digits) and that `memos1.` credentials match the browser's encoding, round-trip, and are rejected when malformed or for another server or database.

  ```bash
  xcrun swiftc -parse-as-library \
    apps/ios/SceneCapture/AccountKey.swift apps/ios/SceneCapture/Recorder.swift \
    apps/ios/SceneCapture/CaptureRequirements.swift apps/ios/Tests/ContractChecks.swift \
    -o /tmp/memos-contract-checks
  /tmp/memos-contract-checks
  ```

- **HostedUploadChecks.swift**: without `--live` it only prints a hint. With `--live` it **writes to the hosted upload API** (the origin is hard-coded, the same as `VITE_UPLOAD_API` in apps/web/.env.hosted): it creates an "iOS upload check …" account, restores it from its credential, reads its profile, records a tiny synthetic clip, uploads it with `pipeline: false` (an unauthenticated `PUT`), completes it, finds it in the account's listing and compares the downloaded bytes' SHA-256. The account and a "[TEST] iOS hosted upload contract" memory stay on the service. It expects the hosted config to report `pipelineAvailable: false` and a 90 MiB limit, so it fails once the hosted API has a worker.

  ```bash
  xcrun swiftc -parse-as-library \
    apps/ios/SceneCapture/AccountKey.swift apps/ios/SceneCapture/Recorder.swift \
    apps/ios/Tests/HostedUploadChecks.swift -o /tmp/memos-hosted-checks
  /tmp/memos-hosted-checks --live
  ```

- **PasswordSignInChecks.swift**: drives the real SceneLibrary sign-in and **Copy password** against an upload API given by `--api ORIGIN --account-file FIXTURE_JSON` (a synthetic account), with `--unsupported` for a server without six-digit passwords. Only `localhost` or `127.0.0.1` are accepted unless `--live` is passed. It is built and run by `tests/integration/ios-password.mjs`.
- **PipelineUploadChecks.swift**: runs the whole phone path in the real SceneLibrary: creates an account, validates and imports a clip, uploads, verifies, and requires the row to be assigned to the reconstruction worker. Options: `--api ORIGIN --directory DIR --output JSON [--clip MP4] [--live] [--expect-lost-confirmation]`. Without `--clip` it records a synthetic 1280×720, 30 fps clip with a tone. `--expect-lost-confirmation` expects the first confirmation response to be lost, then expires the receipt in `queue.json`, restarts the library and requires the same row to be recovered. A non-loopback `--api` needs `--live`, and `--live` needs a real `--clip`. The output JSON (mode 0600) holds the test account's credential: never print or commit it. `npm run test:pipeline` and `npm run test:pipeline:live` build and run it.

The last two are compiled with `AccountKey.swift`, `CaptureRequirements.swift`, `Recorder.swift` and `SceneLibrary.swift` and `-target <arch>-apple-macosx14.0`.

### Test suites

- `npm run test:pipeline` ([tests/integration/ios-pipeline.mjs](../tests/integration/ios-pipeline.mjs), macOS with Xcode only): compiles PipelineUploadChecks, then runs the upload API suite ([tests/integration/upload-api.ts](../tests/integration/upload-api.ts)) against an isolated in-memory SpacetimeDB and the Cloudflare Worker entry under `wrangler dev --local` with local R2. Needs `npm ci`, the SpacetimeDB CLI 2.13.0 on `PATH` (or `SPACETIME_BIN`) and `python3`; nothing touches the cloud or a GPU. Besides the account and upload checks, it verifies that a stale `pipelineAvailable: false` seen at sign-in is re-read before the upload; that the app uploads a valid MP4 as its account, downloads identical bytes and gets the worker assignment; that a committed confirmation whose response is lost, followed by an expired receipt and an app restart, recovers one memory with no duplicate; that the Python worker loop ([tests/integration/pipeline_worker.py](../tests/integration/pipeline_worker.py), CPU stand-ins for the GPU stages) downloads the exact MP4, publishes a synthetic manifest and sets the row to `ready`, seen through the API and a WebSocket subscription; that a deliberately failed stage reports `failed` with no manifest; and that the Python publisher moves a 91 MiB multipart scene asset intact.
- `node tests/integration/ios-password.mjs` ([source](../tests/integration/ios-password.mjs), macOS with Xcode): compiles PasswordSignInChecks and runs it against a throwaway local HTTP API in three scenarios: a server that advertises passwords without a reconstruction flag, a server that gains password support after the app cached its settings, and a server without password support. It checks that only the six-digit password is sent, with leading zeros and without an `Authorization` header; that a copied password signs a fresh "second phone" into the same identity and name; that the account's memories are unchanged; and that an unsupported server gets an explanation while the existing account stays.
- `npm run test:pipeline:live -- --clip /absolute/path/to/clip.mp4` (macOS with Xcode): the real acceptance check against a deployed API with a running GPU worker ([deployment](./deployment.md)). It runs PipelineUploadChecks with `--live` and passes only after a reconstructed scene is published and visible through the API and the database subscription.
- `STDB_DATABASE=YOUR-LOCAL-TEST-DATABASE node tests/integration/phone-account.mjs` (any OS, local SpacetimeDB on 127.0.0.1:3055 with that database published): the API side of the older native registration flow, covering registration, immutable names and rejection of a mismatched identity and token.

## Regenerate the Xcode projects

`npm run ios:generate` runs [apps/ios/scripts/generate_xcode_project.py](../apps/ios/scripts/generate_xcode_project.py) with `python3`. It rewrites both `project.pbxproj` files, their shared schemes, `Info.plist` and `Info-Demo.plist`.

- Run it after adding, removing or renaming a Swift file. It picks up only `*.swift` files directly in `apps/ios/SceneCapture/` (no subfolders); `DemoCapture.swift` goes only into the demo and `GlassesCapture.swift` only into the glasses project.
- It keeps each configuration's `DEVELOPMENT_TEAM`, `PRODUCT_BUNDLE_IDENTIFIER`, `CODE_SIGN_IDENTITY`, `PROVISIONING_PROFILE_SPECIFIER`, `META_APP_ID` and `CLIENT_TOKEN` from the existing project. Any other build setting or plist key changed in Xcode is overwritten: change it in the generator instead.
- It reads the existing project with macOS `plutil`, so run it on a Mac.

The generated projects and plists are committed (Prettier skips `apps/ios/`). DerivedData, `xcuserdata` and videos are ignored by git; keep credentials out too.

## Limitations

- **Glasses audio is unresolved.** Live recordings made through the SDK may play without sound, and it isn't known whether the audio track is missing, silent or muted. A clip without an audio track fails the capture requirements, so a real reconstruction upload may need a Meta AI export instead.
- **The glasses project needs a newer Xcode** than the demo: the release the DAT SDK supports. The demo and the check programs build without the SDK.
- **The live stream isn't the glasses' camera recording.** The app records the SDK stream (requested at 30 fps, delivered at about 25), not the glasses' built-in recorder.
- **Foreground only.** Uploads run only while the app is open and resume when it returns; backgrounding ends a glasses session and finishes its recording.
- **Reconstruction happens elsewhere.** The app hands clips to the upload API; a scene appears only when a pipeline worker is configured and running, and storage-only servers record clips with "reconstruction not requested". A phone upload has not been taken through GPU reconstruction end to end; `npm run test:pipeline:live` is the check for that.
- **Not private.** Memory rows are public to every client of the database, and video and scene URLs open for anyone who has them. The six-digit password is a bearer credential with no recovery or rotation.
