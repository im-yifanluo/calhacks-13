# Capture, upload and return to a memory

Use `apps/ios/SceneCapture.xcodeproj` for the Meta SDK capture app. The standalone
`SceneCaptureDemo.xcodeproj` uses simulated frames. Both share `SceneLibrary.swift`
and the Capture / Memories / Party / Settings UI. The older CameraAccess sample
remains in the repo but is not the primary frontend for this flow.

1. Save the upload server origin in native Settings. Enter a display name and
   continue. The app obtains a SpacetimeDB identity and saves its token in Keychain.
2. Connect glasses through the native Meta SDK, start preview, and record. Off
   finalizes an MP4 and starts the existing durable upload queue. Keep the app open.
3. Upload uses authenticated presign → PUT video bytes → complete. Storage holds
   the bytes; the memory row holds the owner ID, source URL and worker assignment.
4. The pipeline owner runs the reconstruction worker. It sets `processing`, progress,
   then `ready` with `manifestUrl`, or `failed` with an error. No GPU work runs in
   this frontend. Uploaded alone is not evidence of reconstruction.
5. Native Memories polls the owner-scoped API; `/library.html` subscribes to the
   shared demo library through SpacetimeDB. Ready scenes open the existing web
   viewer with `/?memory=<encoded manifest URL>`. The same link works in Quest
   Browser when hosting/assets are reachable and HTTPS is correctly configured.

## Names and IDs

`profile.identity` is the unique account key. `displayName` is a label, not a login
secret or a lookup key. Two users named Nikko receive different IDs. Renaming
keeps uploads owned by the same ID. The authenticated `set_display_name` reducer
can only change its sender's row and preserves the name on reconnect.

`GET /api/profile?identity=<64 hex>` and `POST /api/profile` with
`{ identity, displayName }` both require a matching Bearer token. Names must be
1–40 UTF-16 units after trimming. No token belongs in a URL, screenshot or log.

The phone keeps its existing identity per upload origin in Keychain. The library
keeps a separate guest token per database in localStorage. Reloading/reopening
that browser profile restores it; clearing site data loses this guest access.
Viewer multiplayer tabs retain their existing per-tab identity behavior to avoid
sharing a physics player. The phone, web library and guest viewer are not yet one
cross-device account. Names never recover or link an account. Add authenticated
pairing or a common account provider if that becomes necessary.

This is a shared hackathon demo library. Memory/profile tables and scene URLs are
public as in the existing project; identifying owners does not make clips private.

## Configuration

- Web: `VITE_STDB_DATABASE` and optional `VITE_STDB_URL` select the DB.
- Upload API: `STDB_DATABASE`, `STDB_HTTP_URL`, existing storage/pipeline settings.
- Web → upload: same-origin `/api` in local Vite, or `VITE_UPLOAD_API` plus API CORS
  for separately hosted deployments.
- Phone: upload server origin; optional web viewer origin. These must point at the
  same DB/storage used by the processing worker. The deployed module must include
  the new `set_display_name` reducer and the API must include `/api/profile`.

The existing static hosted demo is not automatically updated by this work. It
still needs the library build, a reachable upload API and matching DB configuration.
No production deployment or RunPod job was performed.

## Checks on this Mac (2026-10-24)

- TypeScript checks, 114 server/client tests, 108 viewer tests and production build.
- Live local integration: WebSocket sync, transport recovery, authenticated upload
  and status transitions. Isolated database `memory-replay-frontend`; original
  `memory-replay` database and the user's real recording were left intact.
- Real profile API: duplicate names have distinct IDs; rename preserves ID;
  a different identity/token pair cannot change the profile.
- Browser: name entry, reload preserving ID, MP4 upload, stored-video loading,
  live processing progress and ready scene links. Ready fixtures use the existing
  synthetic manifest; they do not claim successful RunPod reconstruction.
- Swift syntax parsing only. Full Xcode, physical iPhone/Meta capture, Quest VR and
  live reconstruction integration remain to be tested.
