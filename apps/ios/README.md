# Memory Replay iPhone capture (draft)

This is an adaptation of Meta's CameraAccess sample with automatic upload after a recording finishes. It is **not yet an iPhone-tested app**. The Foundation upload queue has compiled and passed real local HTTP/database tests on macOS; the full Meta/iOS target requires Xcode and physical-device acceptance.

## Integration choice before merging

`stdb/jerry-p4` now contains `SceneCapture.xcodeproj` and `SceneCaptureDemo.xcodeproj`, with overlapping automatic-upload functionality. Prefer selecting one phone app. `CameraAccess/UploadQueue.swift` and the confirmation-loss test can be reviewed or ported independently. This draft does not replace Jerry's apps, server module, upload routes, or viewer. No team branch was pulled while preparing it.

## Behavior

- Connect/register through Meta AI, start a device session, preview the glasses camera, then record.
- Stop recording: finalize the MOV, copy it into persistent app storage, then automatically presign, PUT the file and complete the database registration.
- The UI reports success only after an independent `/api/memories` lookup finds the same request ID.
- Failed requests retry with backoff while foregrounded. A saved queue resumes when the app reopens. A completed PUT retains its receipt so retries do not send another clip. An expired receipt first checks for an existing database row to avoid duplicating an already-confirmed upload.
- Each recording retains its original backend address. Changing Settings affects future recordings only.
- Clips and queue credentials stay in the app sandbox, protected until first unlock on iOS. Local clips are retained even after upload; this prototype does not implement automatic cleanup.
- Debug MockDeviceKit captures use `pipeline:false` and a simulation title. Real captures use the existing pipeline-worker assignment.

This records through the DAT camera session. It does not watch Meta AI's media gallery or intercept ordinary recordings from the glasses' built-in recorder. Keep the app open during recording/upload; iOS background suspension is not a guaranteed upload mechanism. Camera-stream resolution, audio, signing entitlements and real device behavior still need measurement.

## Build and configure

1. Install full **Xcode 26.4+ / Swift 6.3+** and iOS support. The deployment target is iOS 17.2. This project pins Meta DAT **1.0.1**.
2. Open `CameraAccess.xcodeproj`, select scheme **CameraAccess**, set your development team and a unique bundle identifier, and select the paired iPhone. Keep the SDK-required capabilities; resolve any signing errors with the team's Apple developer setup.
3. Enable Developer Mode on the iPhone and separately in Meta AI for DAT testing. Follow the current [Meta sample instructions](https://github.com/facebook/meta-wearables-dat-ios/blob/main/samples/CameraAccess/README.md). Review Meta's developer terms before using the SDK.
4. Start SpacetimeDB and publish the existing module as described in `../../docs/P4.md`. Use the same database as the upload service.
5. For a same-Wi-Fi test, start/restart only upload and web services with your Mac's hostname (`scutil --get LocalHostName`):

   ```sh
   PUBLIC_ORIGIN=http://YOUR-MAC.local:5173 UPLOAD_ALLOWED_ORIGINS=http://127.0.0.1:5173 npm run upload:local
   PUBLIC_ORIGIN=http://YOUR-MAC.local:5173 LOCAL_HTTP=1 npm run dev -w apps/web -- --host 0.0.0.0
   ```

6. In the iPhone app's **Settings**, save `http://YOUR-MAC.local:5173`. `127.0.0.1` on a real iPhone points to the phone. A trusted HTTPS server origin also works. The app permits local HTTP via a narrow local-network ATS exception; it does not disable certificate checks.
7. Connect glasses, start session/preview, record 10 seconds, stop. Expect a saved local recording followed by **Uploaded · memory #…**. Open its stored video and check the capture page on the Mac. Status remains `uploaded` until a separate GPU worker processes it.

Optional per-machine default: create ignored `Backend.local.xcconfig`:

```xcconfig
MEMREPLAY_BACKEND_URL = http:/$()/YOUR-MAC.local:5173
```

The `$()` prevents Xcode from treating `//` as a comment. No account credentials or signing team are committed.

## Verified upload recovery test (macOS, no iOS SDK required)

Start the local database, upload service and web app first. From the repository root:

```sh
mkdir -p data/ios-tests/module-cache
swiftc -swift-version 6 -module-cache-path data/ios-tests/module-cache \
  apps/ios/CameraAccess/UploadQueue.swift scripts/test-ios-upload.swift \
  -o data/ios-tests/test-ios-upload
# Separate terminal; restart this proxy before every test run:
node scripts/test-ios-upload-proxy.mjs
# Use a fresh queue directory each time:
data/ios-tests/test-ios-upload apps/ios/CameraAccess/TestResources/plant.mp4 \
  http://127.0.0.1:8789 data/ios-tests/run-1
```

The test sends Meta's synthetic fixture with `pipeline:false`. Its purpose is transport integrity, not media-format validation or reconstruction. The proxy lets completion succeed on the server but returns an error to the client. The test recreates the queue from disk, recovers the same request/record, compares downloaded SHA-256 with the source, then simulates receipt expiry and confirms no replacement request is created.

Passed on October 24: Swift 6 compilation; all four recovery/integrity assertions; project/plist syntax validation; Swift parsing of the changed app files. **Not run:** Xcode build, imported/updated XCTest and UI suites, simulator UI, physical iPhone, live glasses, S3/R2, or automatic RunPod reconstruction. The UI tests now expect a durable queue instead of a share sheet; their test-only backend is deliberately unreachable so they check local retention without sending simulated footage to a worker.

## Attribution

The capture implementation, media writer, UI assets and original tests come from [Meta's official CameraAccess sample](https://github.com/facebook/meta-wearables-dat-ios/tree/main/samples/CameraAccess), downloaded October 24, 2026. Its copyright notices and `LICENSE` are retained. Source archive SHA-256: `5973f2aa484831790fab40ceaace88286b0afaa6467620ca13a8a190fca494c1`.

Memory Replay additions are `UploadQueue.swift`, `UploadStatusView.swift`, backend configuration, stop-recording integration and native upload recovery tests. The `plant` media is an upstream test fixture, never team capture footage.
