# Memory Replay phone app and demo

## Physical iPhone acceptance · October 24

Verified on Nikko's iPhone with real Meta glasses: registration, developer-software update handoff, camera preview, local MP4 recording/playback, website password sign-in, hosted upload and independent download integrity. Database row #6 matched the phone's MP4 by SHA-256; the backend teammate confirmed it belongs to the intended NikkoTest user. Picture and duration were confirmed by playback. **Audio remains unresolved:** the user heard no sound; this does not establish whether audio is absent, silent or muted. Audio debugging is deferred. Hosted tests use `pipeline:false`; GPU reconstruction was not tested. New signed-out clips remain local until explicitly uploaded after sign-in.

The native buttons are **Record** and **Stop & save**. Starting a glasses session or preview alone does not record. Record starts saving frames; Stop & save finalizes the MP4 (the glasses target also records SDK audio). Without sign-in, the clip stays on the phone and appears in **Memories → On this phone**, where it can be played or exported. These clips do not enter the upload queue or block later account/server setup. After signing in, choose **Upload as [name]** on a local clip to associate it with that account and queue it explicitly.

When already signed in, new recordings upload automatically after saving. Upload verifies the database record and downloaded bytes; a successful result says **PASS · Database row #… · Download matches recording**. Video bytes live in local disk/S3/R2 storage; the database holds their record and URL. Local recording does not require meeting pipeline quality thresholds, but real-video uploads still validate resolution, frame rate and audio.

There are two native iPhone projects, with shared recording, upload, library and settings code:

| Open in Xcode | Feed | Requirements |
| --- | --- | --- |
| `apps/ios/SceneCaptureDemo.xcodeproj` | Clearly labeled animated demo scene; real H.264 MP4 and database writes | Xcode 15.4+, iOS 17.2+. Runs on iPhone or Simulator, no Meta SDK, no camera permission |
| `apps/ios/SceneCapture.xcodeproj` | Live Ray-Ban Meta camera stream | Compatible paired glasses, iPhone, Meta AI app, Meta DAT 1.0.1 and its supported Xcode toolchain |

The demo's `[SIMULATION]` clips presign with `pipeline: false` and verify that the returned database row belongs to the uploader's test queue. They never request reconstruction. An imported real MP4 is a normal upload, even from the demo app. Neither app implements reconstruction; uploads remain `uploaded` until a separate worker processes them.

The **Party** tab opens the shared viewer using the saved server address. Create a party or enter a seven-character invite code; name-and-password sign-in and leader-controlled playback run in the system browser. See [PARTIES.md](PARTIES.md) for setup and testing. Finish recording/upload before switching to the browser.

## Hosted iPhone upload test

In Settings choose **Use memos upload server** (`https://memos.alightdell64.chatgpt.site`, no `/api` suffix). In Capture paste the password from your existing memos website account. In Memories choose **Upload as [name]** on a saved local clip. Never paste a password into chat or logs.

The hosted service advertises `pipelineAvailable: false` and a 90 MiB limit through `/api/account/config`. The app uses its portable-credential API: `POST /api/account` with `displayName` or `personalKey`, `GET /api/account` for the profile, and the full `memos1.` password as the bearer credential. Passwords remain in Keychain. The older local service retains its JWT/profile flow. The hosted upload ticket's `expiresIn` is converted into a persisted expiry; raw PUT requests include file length and never carry account authorization. Upload-only tests skip reconstruction quality thresholds and send `pipeline:false`; source bytes are not transcoded by the uploader. Real processing uploads retain the quality checks.

An opt-in live check creates a separate test account and tiny generated clip, restores the account, uploads with processing disabled, lists the memory and compares downloaded bytes:

```bash
xcrun swiftc -parse-as-library apps/ios/SceneCapture/AccountKey.swift \
  apps/ios/SceneCapture/Recorder.swift apps/ios/Tests/HostedUploadChecks.swift \
  -o /tmp/memos-hosted-checks
/tmp/memos-hosted-checks --live
```

On October 24 this check passed against the public API. It leaves a clearly labeled synthetic test memory and account on the service; it does not use a person's footage or sign-in password. Physical iPhone upload remains a separate acceptance step.

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

After saving the server address, **Create password** registers your name with
`register_account`, preserving any existing phone identity and its recordings. Or
paste the `memos1.…` password from web sign-in into **Sign in with saved password**. The app
checks the password's server/database, then asks the backend to authenticate it before
replacing the Keychain credential. Names registered to passwords cannot be renamed.
**Copy password** makes an expiring local clipboard copy; save it privately and
paste it into the browser on iPhone or Quest to access the same account. No passwords are
included in viewer links, logs, or video metadata. A party code is a separate thing.
Pending clips bind to their original account/server; finish uploads before switching.
Account/server changes are disabled while recording. **Keep on phone only** stops
an unwanted upload retry while retaining the clip for playback/export.

The upload service adds `GET /api/account/config` → `{server,database}` and
`POST /api/account` → `{identity,displayName,provider}` (body `{identity,name}`,
Bearer token required). Existing `/api/profile` and guest naming remain compatible.
Set **ACCOUNT_SERVER_URL** to the exact public SpacetimeDB base used by web passwords:
`https://YOUR-WEB-HOST/stdb` for the same-origin proxy, or the HTTP(S) equivalent
of `VITE_STDB_URL` without its trailing slash. Local upload defaults to
`PUBLIC_ORIGIN/stdb`; use the same public hostname on desktop and phone when making
passwords. Production falls back to `STDB_HTTP_URL` if neither public setting is given,
so explicitly configure it when that address is internal. Both app and web need the
same `STDB_DATABASE`. Restart the upload service after updating it.

**Memories** shows reconstruction status and offers **Open in 3D** and a share link
when the worker supplies a valid manifest. It refreshes every five seconds while
the app is active. **Web viewer URL** in Settings is optional when upload and web
hosting share an origin. For separate hosting, both services must use the same DB.
The web library is `/library.html`. See [FRONTEND_FLOW.md](FRONTEND_FLOW.md).

The updated native sources compile against the physical iPhone SDK with Xcode 27.1
and Meta DAT 1.0.1. Compile checks use `CODE_SIGNING_ALLOWED=NO` and do not establish
an installable build. Signing/provisioning and a real glasses recording remain
separate device checks. The earlier simulator evidence below predates this update.

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

Meta's [CameraAccess sample requirements](https://github.com/facebook/meta-wearables-dat-ios/blob/main/samples/CameraAccess/README.md) currently list **Xcode 26.4+, Swift 6.3+, iOS 17.2+**. The glasses project is separate so its binary SDK does not prevent building the demo with Xcode 15.4. The glasses target compiles with Xcode 27.1; physical-device testing is still required.

1. Open **SceneCapture.xcodeproj** with the supported Xcode. Set your signing team/unique bundle ID, select your paired physical iPhone, and let Swift Package Manager resolve Meta DAT **1.0.1**.
2. In Meta AI, enable glasses Developer Mode following Meta's current instructions. That mode does not need app credentials; release channels need your `META_APP_ID` and `CLIENT_TOKEN` in build settings. The callback scheme is `scenecapture://`.
3. Run the app, configure its server, tap **Connect with Meta AI**, finish registration/permissions and return. Tap **Start Session**, then **Preview glasses camera**.
4. Leave the phone stationary and turn your head. The preview must follow the glasses. Tap **On**, wait 10–15 seconds, tap **Off**. Off stops recording and preview, retains the MP4 and uploads automatically. It does not power off the glasses or operate their built-in 3K recorder.
5. Expect PASS and play the stored clip. The SDK stream requests `.high`, 30 fps and 44.1 kHz mono PCM audio; MP4 encoding uses H.264 + AAC on the SDK timestamps. Meta labels DAT camera audio streaming **experimental**, so support must be verified on the real glasses. This does not claim built-in 3K capture. The app inspects the actual file before presigning: ≥1280 px on its long edge, approximately 24 fps or higher (including 23.976), a nonempty audio track, and a readable duration. The verified glasses test clip averages 24.93 fps despite requesting 30; the pipeline converts its timing to 30 fps without recovering dropped frames. An unsuitable live clip stays local/pending with its measured properties in the error; use **Keep on phone only** and import a suitable Meta AI export if needed. 90-second recording limit. Backgrounding ends the session and attempts to finish the recording; start a new session on return.

For a real glasses clip without the newer Xcode: record using the glasses' physical capture button, export through Meta AI, then upload the MP4/MOV from the browser's import panel. The native importer accepts MP4 and MOV, preserves the container extension/MIME type, and applies the same media checks.

## Source layout and regeneration

`SceneCaptureApp.swift` is the shared UI. `DemoCapture.swift` supplies synthetic frames; `GlassesCapture.swift` supplies SDK frames. `Recorder.swift` writes H.264 MP4s. `SceneLibrary.swift` persists the queue/catalog, obtains a database identity, transfers clips and verifies stored bytes. The two projects compile different capture sources; the demo has no Meta package reference.

Run `npm run ios:generate` after changing source layout. Generated projects and plists are committed; regeneration preserves existing signing team, bundle identifier and Meta registration build settings. Do not put videos, credentials, DerivedData or `xcuserdata` in git.

## Verification on this branch

Checked on 24 October 2026 with Xcode 15.4 and iPhone 15 Simulator (iOS 17.5): the standalone demo builds with ad-hoc signing, records playable MP4s, retains a failed upload through app relaunch/update, automatically retries, and plays the stored URL. A 12.68-second phone clip produced database row #1 with SHA-256 `a1e586447bc8d9720e00cb3bc00e7c5200d5f210d72eed2a3cf649ec78b49921`; its database owner and pipeline identity match, confirming a test upload. A later 30-second recording also passed verification and the time limit. IDs/hashes are evidence from this local database, not hardcoded expectations for another installation.

The shared recorder smoke test, 88 Vitest tests (2 existing skipped), 75 viewer tests, TypeScript checks, production web build and live SpacetimeDB integration test passed. Physical iPhone installation, live Wayfarer capture, R2/S3 and reconstruction remain unverified. The full Meta SDK target cannot compile with the installed Xcode 15.4; only the independent demo target was built and run here.

## Repeatable checks for the new contract

```bash
xcrun swiftc -parse-as-library apps/ios/SceneCapture/AccountKey.swift \
  apps/ios/SceneCapture/Recorder.swift apps/ios/SceneCapture/CaptureRequirements.swift \
  apps/ios/Tests/ContractChecks.swift -o /tmp/memos-native-checks
/tmp/memos-native-checks
# Against a separately published LOCAL test database on port 3055:
STDB_DATABASE=YOUR-LOCAL-TEST-DATABASE node scripts/test-phone-account.mjs
```

The native checks encode real files, accept 24/25/30 fps video with audio, reject silent/15 fps/
low-resolution files, and exercise browser-compatible password encoding/decoding. The
live API check verifies registration, password reuse, immutable names, and identity/token
mismatch rejection. Neither test proves SDK hardware delivery or successful RunPod
reconstruction; test those with an actual paired phone and glasses.
