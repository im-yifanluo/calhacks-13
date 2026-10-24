# Integration guide

The team built the app on four separate branches. The `integration` branch merges them into one app. This page covers:
- what was merged, and what was left out and why;
- which version of each shared contract won;
- how the viewer talks to the server (the network adapter);
- known issues found during the merge, with owners;
- what nobody has built yet.

*Updated Sat Oct 24, early morning, for the integration PR.*

---

## 1. What was merged

| Piece | From | Where it lives now | Checked |
|---|---|---|---|
| Viewer engine: physics, VR controls, timeline replay | `origin/nikko` (Nikko, P3) | `apps/web/src/` (`main.ts`, `viewer.ts`, `timeline.ts`, `tracks.ts`, `loader.ts`, `physics.ts`, `input-desktop.ts`, `input-xr.ts`) | 17 node tests; desktop browser |
| Multiplayer server | `origin/stdb/jerry-p4` (Jerry, P4) | `server/spacetime/src/index.ts`; bindings regenerated into `apps/web/src/module_bindings/` | 16 vitest tests (shared with upload); live test `npm run test:integration` |
| Multiplayer client | `origin/stdb/jerry-p4` | `apps/web/src/net/index.ts` (`Multiplayer`) | Through the live test |
| Upload service, upload panel, capture page | `origin/stdb/jerry-p4` | `server/upload/`, `apps/web/src/upload.ts`, `apps/web/capture.html` + `capture*.ts`, `scripts/test-video.ts` | vitest; capture page loads |
| Worker status reporter | `origin/stdb/jerry-p4` | `scripts/pipeline-status.py` | Through the live test |
| Network adapter, room panel, phone joystick | **new, written during the merge** | `apps/web/src/net/adapter.ts`, `apps/web/src/session.ts`, `apps/web/src/phone-joystick.ts` | Unit tests on an in-process room; live headless test with three players; 11-step live test in the browser with three tabs and a phone viewport (§3) |
| Vision pipeline design, runbook, Runpod scripts, scene format | local `main` | `pipeline/`, `packages/shared/` | Unchanged by the merge |

### Left out, and why

| Left out | Where it still is | Why |
|---|---|---|
| Andrew's local CPU pipeline, JSON schemas, `?debug=1` overlay | `origin/part1` | The vision pipeline owner is rewriting `pipeline/`. |
| Jerry's iOS capture app (`apps/ios/`, `scripts/generate_xcode_project.py`, `scripts/test-recorder.swift`) | `origin/stdb/jerry-p4` | Never compiled; needs Xcode 26.4+ / Swift 6.3+, which the team laptops don't have. Glasses clips come in through the Meta AI app instead. |
| Main's old SpacetimeDB module and its `/smoke.html` test | replaced | Jerry's module replaces it; his `tests/module.test.ts` and `scripts/test-multiplayer.ts` cover the same ground. |
| Jerry's app shell (`main.ts` render loop), `net/physics-bridge.ts`, `net/replay.ts`, touch drag in `input-touch.ts` | `origin/stdb/jerry-p4` | Nikko's viewer does rendering, physics, replay and touch drag. The room panel moved to `session.ts`, the joystick to `phone-joystick.ts`, and the bridge's timings into the adapter. |

**Commits on the branch:**
1. the merge of `origin/nikko`;
2. a fix so nikko's viewer compiles against main's scene format;
3. the merge of `origin/stdb/jerry-p4`, with regenerated bindings and lockfile, and a Vite build fix for paths with spaces;
4. one SpacetimeDB port for every script;
5. capture-page copy without the iOS app;
6. a lockfile with every platform's packages, so `npm ci` works;
7. the adapter, room panel and phone joystick (merge of `int/net`);
8. these docs.

Local `main`'s unpushed commits (vision pipeline design, runbook, Runpod scripts, file formats) come along too.

---

## 2. Which version of each contract won

### A. Scene format (`memory.json`): main's
The source of truth is `packages/shared/src/manifest.ts` plus its Python mirror `pipeline/memreplay/manifest.py`. Main's version adds keyframe velocity `v`, `source.audioUrl`, `primitive` visuals, `points-sequence` ghosts and `cylinder` colliders.

What the viewer does with the new fields today:

| Field | Viewer today |
|---|---|
| `primitive` visual | Drawn as a tinted sphere / box / cylinder |
| `cylinder` collider | Rapier cylinder; drawn as a cylinder proxy |
| `points-sequence` (people ghosts) | **Placeholder:** a faint collider proxy at the track origin, and it also gets a physics collider (follow-up, §4) |
| `Keyframe.v` | **Ignored:** the viewer uses finite-difference velocity on pause (follow-up) |
| `source.audioUrl` | **Not played yet** (follow-up) |
| `background.colliderUrl` | Loaded as the room trimesh |

Rules every producer and consumer must agree on:
- **URLs** inside `memory.json` are relative to the manifest file. Only SpacetimeDB's `memory.manifestUrl` must be absolute: http(s), at most 2048 characters.
- **`splat-sequence`** frame for time t is `floor((t − visibleFrom) × timeline.sampleHz)`.
- **`points-sequence`** frame k is at `t = k / sampleHz` from the start of the clip, positions already in world coordinates, and the object's track is identity. Binary layout in `pipeline/memreplay/handoff.py`.
- **Splat budget:** the viewer warns above 500k total and refuses above 1M.

The demo scene `apps/web/public/mock/memory.json` uses primitive objects (a ball and a can with a cylinder collider) over the public Spark butterfly splat, which loads from sparkjs.dev and needs internet. The default page `/` is a procedural demo with no downloads.

### B. SpacetimeDB module: jerry's
- **Errors:** `SenderError` with a readable reason.
- **Memory lifecycle:** `uploaded → processing → ready`; `uploaded` or `processing` can go to `failed`, and `failed → processing` is a retry. A memory created with a `manifestUrl` (Add to library) starts as `ready`. Only the memory's `pipelineIdentity` may set status. `ready` needs an http(s) `manifestUrl` and progress exactly 1; progress can't go backwards. `createRoom` requires `ready`.
- **Edits need a paused timeline.** Grabbing on Original forks a take named "First edit". Grabbing an object that already rests on the current take forks a new take "Edit <id>", so a recorded take never changes. Grabbing a different object on a take edits that take in place.
- **Catching** an object another player is still simulating is rejected ("owned by another player"). This is team decision 1; we kept the rejection.
- **Keyframe chunks:** 1–120 frames, `t` in absolute media seconds, `startMediaUs = round(frames[0].t × 1e6)`, start at or after the grab time, no overlaps. Saved by the simulation owner before `release(rest: true)`.
- **Simulation lock:** seek, fork and setBranch are rejected while any object on the take is still owned by a simulation. Disconnecting or leaving clears your ownership.
- **Clock:** the `sampleClock` reducer and `clockSample` table calibrate each client's offset; `net.time()` gives shared media time.
- **Child takes copy nothing.** The client resolves what a take inherits from its parent (§3).

`objectState` is keyed by the string `"<branch>:<object>"`, modes are `held` / `physics` / `rest`, and `simOwner` marks who simulates a thrown object.

**Never hand-edit** `apps/web/src/module_bindings/`. Regenerate with `npm run stdb:generate` (SpacetimeDB CLI 2.13.0). `spacetimedb` is pinned to exactly 2.13.0.

### C. Viewer: nikko's engine, plus jerry's networking through the adapter
`apps/web/src/` after the merge:

| File(s) | From | Role |
|---|---|---|
| `main.ts`, `index.html`, `style.css` | nikko (+ room panel, joystick) | App shell, `SparkRenderer`, camera rig, VR entry |
| `loader.ts`, `tracks.ts`, `timeline.ts`, `physics.ts`, `viewer.ts`, `input-desktop.ts`, `input-xr.ts` | nikko | Engine. `viewer.ts` exposes the `InteractionAuthority` hook the adapter implements |
| `net/index.ts` (`Multiplayer`) | jerry | Connection, subscriptions, clock calibration, reducer calls |
| `net/adapter.ts` | new | Viewer ↔ server sync (§3) |
| `session.ts` | from jerry's `main.ts` | Room panel: rooms, library, upload toggle, players, avatars |
| `phone-joystick.ts` | from jerry's `input-touch.ts` | The WALK pad on touch devices (touch drag and throw go through nikko's `input-desktop.ts`) |
| `upload.ts`, `recorded-upload.ts`, `capture.ts`, `capture-simulation.ts`, `capture.css`, `capture.html` | jerry | Upload panel and capture test page |
| `module_bindings/` | generated | Don't edit |

### D. Vision pipeline
`pipeline/` is exactly local `main`'s version. Its owner is rewriting it, so the merge didn't touch it. `memory.json` (§2 A) stays the contract between the pipeline and the viewer.

### E. Ports, settings and scripts

| | Value |
|---|---|
| SpacetimeDB | `127.0.0.1:3055` by default (Docker often holds 3000/3001). Override with `STDB_PORT` for the npm scripts, the Vite proxy, `upload:local` and `test:integration`. |
| Vite proxy | `/stdb` (HTTP + WebSocket) → SpacetimeDB (`STDB_URL` or `STDB_PORT`); `/api` → upload service (`UPLOAD_URL` or `UPLOAD_PORT`, default 8788). Dev port `VITE_PORT`, default 5173. |
| HTTPS in dev | On by default (self-signed, for LAN IPs). `LOCAL_HTTP=1` serves plain http on 127.0.0.1 only, for the Quest over `adb reverse` and for tunnels. |
| Browser env | `VITE_STDB_URL`, `VITE_STDB_DATABASE` (default `memory-replay`), `VITE_UPLOAD_API` |
| Node | ≥ 22.12 (`.nvmrc` pins 22.23.2) |
| Tests | `npm test` = vitest (`tests/*.test.ts`) + the viewer's node tests; `npm run test:integration` needs a running SpacetimeDB |

---

## 3. How the viewer talks to the server

`net/adapter.ts` implements the viewer's `InteractionAuthority` on top of `Multiplayer`. The room panel installs it only while you're in a room; outside a room the viewer works on its own.

| Viewer side | Server side |
|---|---|
| Grab (`acquire`) | Pause if playing; seek if the room's paused time differs at all (catching a mid-flight preview), so the take's first keyframe lands exactly on the grab time; then `grab`. The adapter waits for the server's rows and hands the viewer the take the server chose. If the room switched takes meanwhile, the grab is refused. |
| Pose while held | `moveObject`, at most 15 Hz |
| Throw | `release(rest: false)` |
| Recorded flight | Frames from the grab's `fromMediaUs` on, downsampled to 30 Hz, in disjoint chunks of at most 120 frames; each `saveBranchKeyframes` is awaited, then `release(rest: true)` |
| Play / pause / seek / pick a take | `setPaused` / `seek` / `setBranch` |
| Timeline row changed | `applyClock`, only when the row really changed. Rows are held while your own grab or clock change is in flight, so neither echoes back. A drift check once a second resyncs past 100 ms. |
| New take row | `upsertBranch`, parents first |
| Chunk inserted / updated / deleted | The take's track for that object is rebuilt from its chunks with `Timeline.setRecording` (each chunk is parsed once) |
| Someone else holds or simulates an object | `applyRemotePose` on the active take only |
| Your ownership cleared (disconnect, leave) | `revokeOwnership` |

Every server call goes through one queue, so a throw's chunks and its `release(rest: true)` always land before the next seek or grab. Two exceptions: giving back a grant the viewer couldn't use (or one that arrived after the 8 s grab timeout) jumps the queue, and moves are sent in order without waiting for each reply, to keep 15 Hz. Other calls time out after 5 s. Takes made locally before joining a room are never sent.

**Wiring** (`session.ts`): create one adapter per room, after the player is in the room and the connection is ready: `const adapter = new NetAdapter(net, viewer, report); viewer.setAuthority(adapter); adapter.start();`. Dispose it before the viewer. `?room=<code>` rejoins after a reload; a room whose memory differs from the loaded manifest reloads with `?memory=<url>&room=<code>` (at most once per target); joining drops solo takes; **Leave** returns to a solo session.

**Tests:**
- `tests/adapter.test.ts` (in `npm test`) runs on `tests/room-harness.ts`: an in-process room that runs the real module reducers through SpacetimeDB's test harness, with per-client latency. Reusable for other client tests.
- `scripts/test-adapter.ts` is a live check over real WebSockets. Two players share a room, throw, re-grab into a new take, and a late third player rebuilds every take; all three end on identical tracks. Run it against a local server: `STDB_WS_URL=ws://127.0.0.1:3055 STDB_DATABASE=memory-replay npx tsx scripts/test-adapter.ts`.

**What a take inherits:** `Timeline.track()` uses the take's own recording of an object from its first frame on. Before that it falls back to the parent take's recording, then the grandparent's, and finally to the original track. Known issue: a parent take edited *after* a child was forked also changes the child (§4).

---

## 4. Known issues found during the merge

A 16-agent survey checked every branch before the merge. Its findings below were **not** fixed in this PR, which only merges and adds the integration. Fixes for several already exist on local branches (`int/server` is committed; `int/viewer` and `int/upload` are uncommitted drafts in their worktrees). They are unverified, so review them before using them.

**Server (Jerry)**
- `saveBranchKeyframes` throws a TypeError instead of a clean error on a non-object frame such as `[null]`.
- Re-grabbing an object whose id is close to 100 characters fails: the auto take name "Edit <id>" is too long.
- A client that stalls mid-throw while staying connected keeps the simulation lock, so seek, fork and take switching stay blocked for the whole room until it disconnects.
- Join codes: the first random draw is biased, and about 11% of codes look like `0000000`.
- `setPaused` isn't blocked during a throw, so another player pressing play finishes your throw's simulation instantly. The adapter still saves it.
- A player who left a room shows up in it again after reconnecting.

**Viewer (Nikko)**
- Take inheritance leaks: edits made to a parent take after a child was forked also change the child.
- `points-sequence` ghosts render as a placeholder and add a phantom collider at the origin.
- Keyframe `v` is ignored on pause, and `source.audioUrl` isn't played.
- After a throw preview, the object snaps back to its release pose.
- An object can vanish past its `visibleTo` even while a take still moves it.
- Quest stick direction and snap turn use `renderer.xr.getCamera()`, which may be wrong after the rig turns. Never tested on a Quest.
- The mock scene's `background.splatCount` is 0 (the real count is 177132).
- The bundle is 7.7 MB (2.8 MB gzip); measure load time on the Quest.
- `revokeOwnership` cancels any pending grab, not just the revoked object's.
- In a room, a quick tap on a paused object leaves an empty take on the server: the server forks on grab, and the viewer gives back a grant that arrives after the pointer is released.
- If the memory row's duration differs from the manifest's, the clip ends at different times; keep `timeline.durationSec` equal to the source duration.

**Client (Jerry)**
- `Multiplayer.run()` clears `net.error` on any success, so one call can wipe another's error (the adapter tracks its own errors).
- `Multiplayer.connect()` only works in a browser (`import.meta.env`, `location`, `sessionStorage`); scripts attach a connection by hand.

**Upload (Jerry)**
- Presigned PUTs don't sign `Content-Type`, and routes match on `req.url`, so a query string breaks routing.
- Any client can register any `sourceUrl` for the worker. The worker must only download URLs under `ASSET_BASE_URL`.
- `upload:local` leaks absolute file paths in errors, accepts the completion receipt as a PUT ticket, and doesn't list PUT in CORS.
- Test uploads (capture simulation, `test-video`) are queued for the GPU worker; there is no "not for the pipeline" flag.
- `pipeline-status.py` crashes on HTTP errors instead of printing the server's reason, and errors over 2000 characters are rejected.

**Pipeline (for the rewrite)**
- `pip install -e pipeline` fails ("Multiple top-level packages discovered": `runpod/` sits next to `memreplay/`). Part1's `[tool.setuptools.packages.find] include=["memreplay*"]` fixes it.
- `memreplay merge` assumes the camera-to-world rotation is pure; a scale folded into it skews the head path.
- `manifest.py` accepts NaN poses and unknown fields; TypeScript rejects the NaN.

---

## 5. Not built yet

| Gap | What it needs | Owner (suggested) |
|---|---|---|
| **Pipeline worker** (upload → pipeline → ready) | Subscribe to `memory`, take rows with `status = 'uploaded'` and its own `pipelineIdentity`; report `processing` with `scripts/pipeline-status.py`; download `sourceUrl` (only under `ASSET_BASE_URL`); run the pipeline, reporting progress; upload the viewer files; finish with `ready --progress 1 --manifest-url https://…/memory.json`, or `failed`. The pod must reach SpacetimeDB at a public URL. | Vision |
| **Pipeline steps** | Being rewritten | Vision |
| **Viewer support for ghosts, `v`, audio** | §2 A | P3 |
| **Real hardware** | Nothing has run on a Quest 3S, a real phone over the tunnel, or real glasses footage | Everyone |

Until the worker exists, an uploaded clip stays `uploaded`. To show a memory in a room, add its `memory.json` URL to the library by hand.

---

## 6. Decisions

1. **Catching a thrown object:** rejected, as in jerry's module.
2. **Part1's DA3 reconstruction:** not merged (pipeline rewrite).
3. **SpacetimeDB port:** 3055, overridable with `STDB_PORT`.
4. **Privacy:** all memory rows and `sourceUrl`s are public (`docs/P4.md`). Fine for the demo.
5. **Phones and registered manifests:** "Add to library" resolves the URL against the page, so a manifest registered from `127.0.0.1` can't be opened on a phone. Register it from the tunnel URL, or type a full public `https://…/memory.json`.

---

## 7. Gotchas
- **Deterministic server code.** No `Math.random()` or `Date.now()` in the module; use `ctx.random` and `ctx.timestamp`.
- **Name casing.** snake_case on the wire and in SQL (`create_room`), camelCase in TypeScript (`conn.reducers.createRoom({...})`).
- **The `spacetime` CLI defaults to Maincloud.** Pass `-s http://127.0.0.1:<port>` for local work; the npm scripts do.
- **Spark needs a `SparkRenderer` in the scene,** or no splat draws.
- **Two copies of the scene format:** `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py`. Change both in the same commit.
- **Anonymous publishes** (`spacetime publish --anonymous`) can't be updated later; republish under a new name, and point `VITE_STDB_DATABASE` / `STDB_DATABASE` at it.
