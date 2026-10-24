# Parties, Google sign-in, and the future scene worker

The phone-friendly viewer now has an account bar, **Create party**, **Join**, an invite link, a member list, and a leader. The leader controls play/pause, seeking, playback speed and take selection. Other members can explore and grab objects at the leader's paused time. The native iPhone app has a **Party** tab that opens this viewer in the system browser, where Google sign-in works without an embedded webview.

The default scene is explicitly synthetic. Creating a party needs no glasses, model, GPU, cloud storage or Google account. Video bytes remain in storage; SpacetimeDB holds the source URL, status, party, participants and shared clock. No reconstruction model or worker is supplied by this change.

## Start the local demo

Use Node 22.12+ and SpacetimeDB CLI **2.13.x**. From the repository root:

```bash
npm ci
npm run stdb:start
```

Leave that terminal running. In another terminal, authenticate the CLI if needed, publish once, then start the web and upload services together:

```bash
spacetime login
spacetime publish -s http://127.0.0.1:3055 --module-path server/spacetime --delete-data=never memory-replay-party
npm run party:dev
```

Open **http://127.0.0.1:5173/**. The launcher uses database `memory-replay-party`, SpacetimeDB port `3055`, web port `5173`, upload port `8788`, and disk storage under `data/uploads`. It runs both web-facing services with matching database/origin settings and exits if either fails. Do not run it over an existing web/upload pair on those ports. Stop that pair first, or choose unused ports:

```bash
VITE_PORT=5180 UPLOAD_PORT=8790 npm run party:dev
```

`STDB_DATABASE`, `STDB_PORT` and `PUBLIC_ORIGIN` override the defaults. Publication and the launcher must use the **same database and port**. Publishing this additive schema does not require clearing existing rows. If publication returns 403, use the CLI identity that owns that database or publish a new database name; do not delete the old database.

**Current machine:** the verified demo uses `memory-replay-party` on the existing server at port 3055, with web 5173 and upload 8788. `apps/web/.env.local` selects that database locally; it is intentionally untracked. The earlier `memory-replay` database was preserved because its original publisher identity was unavailable. Its rows were not copied into the new database; the original video files remain on disk.

## Two-minute party test

1. Enter your name. Leave **Synthetic demo · ready to play** selected and press **Create party**. Expect a seven-character code, **You are the leader**, and an invite link.
2. Copy that link into another browser/tab or device. Alternatively enter the code and press **Join**. Use a different name. Both members must appear in both lists. A guest joins immediately without an account.
3. In the leader tab, press **Return to the start**, scrub to a time, and choose **0.5×**. The other tab must show the same time, take and speed. Its playback controls are disabled. Space/controller playback attempts also restore the authoritative clock; direct reducer attempts are rejected by the database.
4. Play, then pause. While paused, either member can drag an object and release it to throw. Everyone sees the resulting shared take. The leader chooses when to replay it.
5. Open the invite in a third tab. It must start at the current shared time, not at zero.
6. Click **Make [name] leader**. Controls switch immediately. Leave/close the leader's last connection: a connected member becomes leader. Returning does not steal leadership back. An empty party pauses and its next visitor becomes leader. A page reload can therefore hand leadership to another connected member.

Guest tabs have separate identities. Multiple tabs signed into the **same Google account share one participant**, so use different Google accounts or guest tabs for the multi-person test. Sign-in/sign-out preserves the invite URL and rejoins with the new identity; it does not merge a guest's uploads or the native capture identity into a Google account.

## Enable real Google sign-in

Without a configured client ID, the account bar explicitly says **Google sign-in · setup required**. It never pretends a guest is Google-authenticated.

1. Follow [Google's web client setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid): create an OAuth **Web application** client, configure app branding/consent, and add your exact web origins. For local Google testing use `http://localhost` and `http://localhost:5173`; open the app on that hostname. Add your actual HTTPS demo origin for phones. Origins do not include paths. This implementation uses the JavaScript callback, so it needs no redirect endpoint or client secret.
2. Configure the **public client ID** in both builds with one command:

   ```bash
   npm run auth:configure -- YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
   spacetime publish -s http://127.0.0.1:3055 --module-path server/spacetime --delete-data=never memory-replay-party
   npm run build
   ```

3. Reload the app. The official Google button replaces the setup placeholder. Complete sign-in and expect your name with **signed in** and a **Google** member badge. Test another account and sign-out. If Google rejects the origin, correct the client configuration; if the database rejects the audience, republish the module with the same ID.

The browser checks the callback nonce and expiry and passes the original ID token to SpacetimeDB. [SpacetimeDB validates OIDC tokens](https://spacetimedb.com/docs/core-concepts/authentication/); the module additionally checks Google's issuer, this app's audience, authorized party and expiry for Google writes. Identity is based on issuer/subject, not an editable display name. The public profile table stores identity, provider and display name, **not email or tokens**. Credentials stay in tab session storage and never enter invite URLs; an expired session requires sign-in again. No Google consent flow was tested here because no real web client ID was supplied. Claim/nonce rejection paths are covered by automated tests.

## Record on the phone and attach the video

1. Use the native app's **On → Off** flow and wait for upload/database verification. See [PHONE_APP.md](PHONE_APP.md) for glasses and simulator setup. Finish the upload before opening **Party → Open party lobby**. Use the same server origin for capture and parties.
2. In the lobby's **Scene or video** dropdown, select that uploaded clip and press **Create party**. An existing leader can use **Use selected scene / video** instead.
3. The party stays in the synthetic/current scene and displays the pending video's status. Without a worker, it remains `uploaded`. **Cancel pending scene** detaches it without deleting the video.
4. A future worker processes the video, stores assets plus a valid `memory.json`, and calls `setMemoryStatus` as the row's assigned `pipelineIdentity`: `uploaded → processing → ready`, or `failed` with an error. `ready` requires progress 1 and an absolute manifest URL. Use immutable, device-reachable asset URLs with CORS configured. See [scripts/pipeline-status.py](../scripts/pipeline-status.py) and [INTEGRATION.md](INTEGRATION.md) for the existing manifest contract.
5. On `ready`, the database atomically installs the scene in every waiting party, clears pending state, resets the shared clock to paused at zero and increments the scene revision. Browsers reload the scene while retaining the party link. Old takes stay associated with their original memory and cannot be selected in a different memory. A failed job keeps the current scene available; retrying the assigned job or selecting another video is supported.

The worker identity must match the uploader's configured worker. Local normal uploads use the identity in `data/uploads/.worker-identity.json`; keep its token on the worker. `[SIMULATION]`/`pipeline:false` recordings deliberately belong to the test uploader and never enter the worker queue. They are useful for storage tests, but do not start reconstruction.

## Repeatable automated proof

With the current module published and server running:

```bash
npm test
npm run typecheck
npm run build
STDB_DATABASE=memory-replay-party npm run test:party
STDB_DATABASE=memory-replay-party npm run test:integration
# Optional: test your own exported MP4; this stores another test recording.
npm run test:video -- /absolute/path/to/clip.mp4 DURATION_SECONDS
```

`test:party` opens four real database connections (leader, member, late visitor, worker), verifies permission failures, shared clock/presence, pipeline status authorization, ready handoff, explicit transfer and disconnect election. Its worker uses a synthetic manifest; it does **not** train or reconstruct anything. Test metadata is retained under a unique `party-test-*` request ID. `test:video` independently queries the new row and compares the retrieved video's SHA-256 hash with the input.

## Verification on this branch (24 October 2026)

98 Vitest tests passed (2 existing skips), along with 75 viewer tests, TypeScript checks, the production web build, the native iPhone demo build and both live database suites. Browser checks verified three participants, a shared paused time of 2.4 seconds at 0.5× speed, leader transfer, pending-video state and a scene switch. A saved demo MP4 was uploaded to the party database, independently queried, retrieved and verified byte-for-byte. The combined launcher also passed its web-to-upload health check. Google consent and real reconstruction were not run.

## Phone/Quest access and boundaries

### Mac leader + iPhone Safari, without Xcode

For the synthetic party simulation, connect both devices to the same trusted Wi-Fi. Keep the existing SpacetimeDB server running, then start a separate LAN-facing web/upload pair from the repository root:

```bash
VITE_PORT=5180 UPLOAD_PORT=8790 npm run party:lan
```

The launcher prints this Mac's private network address, such as `http://10.0.25.4:5180`. Open **that exact address on both devices**. It selects `memory-replay-party` by default and proxies the database through the web port. If the Mac has multiple network interfaces, set `PUBLIC_ORIGIN=http://YOUR-WIFI-IP:5180` explicitly. The address can change when you change Wi-Fi networks.

1. On the Mac, enter `Mac leader`, select **Synthetic demo · ready to play**, and press **Create party**. Keep this tab open.
2. Send the displayed invite link to the iPhone, or open the same base address in Safari and enter the seven-character party code. Enter a different name such as `iPhone guest`. Do not create a separate party on the phone.
3. Both participant names must appear in both party lists. Collapse the **PARTY** panel on the phone to see the scene. Drag to look around; the **WALK** pad moves through it.
4. On the Mac, return to the start, play, pause and scrub to another time. The iPhone follows the shared time and take, while its playback controls stay disabled. While paused, either participant can drag and throw an object.

Leave the launcher running and the Mac awake during the test. This local HTTP mode supports guest parties and 3D viewing; Google sign-in, browser camera access, stored-file hash verification and immersive WebXR require trusted HTTPS. The **WEBXR NEEDS HTTPS** label concerns headset VR, not the phone's 3D viewer. HTTP party registration uses cryptographic random request IDs even when the browser does not provide `crypto.randomUUID`.

If Safari cannot open the address, first confirm both devices are on the same Wi-Fi and the Mac firewall allows Node's incoming connection. Some venue/guest networks isolate devices. A personal hotspot or a trusted HTTPS deployment can provide a shared route instead. Existing recordings whose URLs use `127.0.0.1` remain Mac-only; create the synthetic party from the LAN address for this test.

### HTTPS for capture, Google, and headsets

`127.0.0.1` on a physical phone points to that phone. Use a reachable HTTPS app origin and set `PUBLIC_ORIGIN` to that same origin before uploading or creating scenes. For a trusted LAN setup, `PARTY_HTTPS=1 PUBLIC_ORIGIN=https://YOUR-MAC.local:5173 npm run party:dev` exposes Vite with its existing development certificate; devices must trust that certificate. A trusted HTTPS reverse proxy is preferable for a shared demo. See [CAPTURE_TEST.md](CAPTURE_TEST.md) for native phone networking and [P3_VIEWER.md](P3_VIEWER.md) for headset controls. Google also needs that origin registered. This change was checked with two desktop browser tabs plus iPhone Simulator Safari in the same party. The native Party tab was built, installed and used to open the viewer. Physical iPhone/Quest/Wayfarer testing remains separate.

Parties are public demo spaces. Codes/links help people join; they are **not private access controls**. The existing public memory/presence tables remain public to database subscribers. There is no private library, room password, moderation or retention policy in this implementation. Legacy `createRoom` callers retain collaborative controls; the new app uses `createParty`, whose leader policy is enforced server-side.
