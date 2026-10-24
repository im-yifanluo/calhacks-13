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
| Original iOS SDK target (at integration time) | Restored in `apps/ios/` by the phone-app follow-up | The SDK target still needs Xcode 26.4+/Swift 6.3+. The new standalone `SceneCaptureDemo` target builds on Xcode 15.4 and shares the upload/library path; see [PHONE_APP.md](PHONE_APP.md). |
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
| `points-sequence` (people ghosts) | Drawn as one `THREE.Points` from the MRPS file; frame k shows from t = k / sampleHz. No pick proxy, collider or physics body. If the file's header disagrees with the manifest, the file wins and a warning shows. |
| `Keyframe.v` | Used on pause and grab, interpolated between keyframes; finite differences when it's missing. A malformed `v` is rejected. |
| `source.audioUrl` | Played in sync with the timeline (resync past 100 ms, follows speed), starting on the first user gesture; a "Sound" toggle mutes it |
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
- **Simulation lock:** seek, fork and setBranch are rejected while any object on the take is still owned by a simulation. Disconnecting or leaving clears your ownership. A throw nobody has updated for 15 s is abandoned: the next seek, fork or take switch settles it, and grabbing it forks a new take that keeps its saved chunks. Moves, chunk saves and the release all keep a live throw fresh. A held object never expires (the page turns a hold into a throw when it's hidden).
- **Leaving mid-grab:** if a player leaves, switches rooms or loses their connection before any keyframe chunk of their grab was saved, the room goes back to the parent take, paused at the fork time, unless someone else is editing that take. Branch rows are never deleted.
- **Re-grabbing your own object** while you still hold or simulate it trims your own chunks from the new grab time on, so the next throw's chunks fit.
- **Leaving means no room:** `leaveRoom` sets `roomId` to 0, so a reconnect resumes players who dropped but not ones who left.
- **Input checks:** `saveBranchKeyframes` rejects non-object frames such as `[null]` with a clean error; auto take names "Edit <id>" are cut to 100 characters; join codes skip the SDK's biased first random draw.
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

**Connection:** after a SpacetimeDB restart, pages reconnect within about 5 s (`withAutomaticReconnect({ maxDelayMs: 5000 })`, and the same cap for first-connection retries). Each tab is one player: a tab that finds its stored token already locked by another live tab (Web Locks; a duplicated tab copies `sessionStorage`) connects as a new guest. Without Web Locks (plain-http LAN IPs) that check is off.

Every server call goes through one queue, so a throw's chunks and its `release(rest: true)` always land before the next seek or grab. Two exceptions: giving back a grant the viewer couldn't use (or one that arrived after the 8 s grab timeout) jumps the queue, and moves are sent in order without waiting for each reply, to keep 15 Hz. Other calls time out after 5 s. Takes made locally before joining a room are never sent.

**Wiring** (`session.ts`): create one adapter per room, after the player is in the room and the connection is ready: `const adapter = new NetAdapter(net, viewer, report, resolved); viewer.setAuthority(adapter); adapter.start();`. `report(message, { kind, error })` carries the kind of action (clock, grab, throw, release, hold, take, data, internal), and `resolved(kind)` is called when an action of that kind next succeeds, so the status line can clear a stale error. The adapter's messages appear only in the viewer's status line. Dispose it before the viewer; `dispose()` sends nothing, so on a reload the disconnect clears your holds and the server reverts a take you hadn't recorded anything on. `?room=<code>` rejoins after a reload; a room whose memory differs from the loaded manifest reloads with `?memory=<url>&room=<code>` (at most once per target); joining drops solo takes; **Leave** returns to a solo session.

**Tests:**
- `tests/adapter.test.ts` (in `npm test`) runs on `tests/room-harness.ts`: an in-process room that runs the real module reducers through SpacetimeDB's test harness, with per-client latency. Reusable for other client tests.
- `scripts/test-adapter.ts` is a live check over real WebSockets. Two players share a room, throw, re-grab into a new take, and a late third player rebuilds every take; all three end on identical tracks. Run it against a local server: `STDB_WS_URL=ws://127.0.0.1:3055 STDB_DATABASE=memory-replay npx tsx scripts/test-adapter.ts`.

**What a take inherits** (`Timeline.track()`): a take's own recording of an object applies from its first frame on, even before the take's fork time. Before that, walk up the parent takes with a limit, starting at this take's fork time and lowering it to each parent's fork time on the way. A parent's recording applies only if it starts at or before the limit, and then in full: a throw in flight at the fork carries on. Otherwise the original track applies. So edits a parent gains after a child was forked never leak into the child. An edit that starts before the fork time is shared history and does reach it. Times within 1 ms count as the same instant.

---

## 4. Known issues

A 16-agent survey checked every branch before the merge, and two independent checkers tested the merged app. PR #1 merged the branches and added the integration. PR #2 (branch `fixes`) fixed the issues they found:
- **Server:** clean errors for malformed keyframes, long object ids, abandoned throws no longer lock the room, unbiased join codes, leavers not revived on reconnect, and an empty take given up when its grabber leaves or reloads.
- **Viewer:** takes no longer inherit parent edits that start after their fork time, people ghosts, keyframe velocity, audio, no snap-back after a throw (for the thrower and everyone who watched it), objects stay visible while a take moves them, the Quest stick and snap turn, the mock scene, `revokeOwnership` scope, a tap never grabs, objects can't go under the floor, the status line after a throw, input stuck when pointer capture fails.
- **Room panel and client:** messages expire or clear, one call no longer wipes another's error, reconnect within 5 s, one player per tab, a plain message while the server is down.
- **Upload:** signed Content-Type, path routing, PUT tickets vs receipts, no file paths in errors, test uploads kept off the worker queue, worker status-script errors, a source-URL check for the worker.

**Still open**
- **By design:** another player pressing play while you throw finishes your throw's preview instantly (it is still saved). `Multiplayer.connect()` only works in a browser; scripts attach a connection by hand. When a take is given up because its grabber left, the room pauses at the take's fork time, even if someone had pressed play meanwhile. Takes made with `forkBranch` are never given up.
- **Right after a throw**, other players' copy of the new take has no frames until the throw comes to rest and its chunks are saved (the flight time plus a round trip per chunk). They see the throw live meanwhile, and the room's seek and take switch are refused until it settles.
- **A reload mid-throw after some chunks were saved** keeps that partial take. With nothing saved, the room goes back to the parent take.
- **Edits a parent take gains after a fork** still reach the child if they *start* at or before the child's fork time, for example seeking a take back to 0.5 s and throwing an object it never edited, after a child was forked at 1 s. The viewer can't tell when an edit was made: chunks carry media times, not creation times. Telling them apart needs a creation order on `branchKeyframes`, which is a schema change.
- **A take given up after its grabber left** stays in everyone's take list. Branch rows are never deleted, and selecting it shows the parent's history.
- **Late joiners** see a just-finished throw at the paused time's pose, not its landing pose. The players who watched it hold the landing pose until someone plays or seeks.
- **One player per tab** relies on Web Locks, which plain-http LAN IPs don't have.
- **Durations:** a memory row's `durationUs` must equal the manifest's `timeline.durationSec`, or the clip ends at different times. That's for whoever registers memories.
- **Bundle:** 7.7 MB (2.8 MB gzip), almost all Spark and Rapier, which are needed before anything renders. Measure load time on the Quest and venue Wi-Fi.
- **Upload, unverified on real R2:** a wrong-Content-Type PUT should get 403; bucket CORS for the tunnel origin; uploads over 100 MB through the tunnel. `create_memory` still accepts any `sourceUrl`, so the future worker must call `scripts/source_check.py`'s `allowed_source()`.
- **Never run on real hardware:** Quest 3S (stick and snap-turn feel, ghost performance, audio lag), a real phone, real glasses footage.

**Pipeline (for the rewrite, not touched here)**
- `pip install -e pipeline` fails ("Multiple top-level packages discovered": `runpod/` sits next to `memreplay/`). Part1's `[tool.setuptools.packages.find] include=["memreplay*"]` fixes it.
- `memreplay merge` assumes the camera-to-world rotation is pure; a scale folded into it skews the head path.
- `manifest.py` accepts NaN poses and unknown fields; TypeScript rejects the NaN.

---

## 5. Not built yet

| Gap | What it needs | Owner (suggested) |
|---|---|---|
| **Pipeline worker** (upload → pipeline → ready) | Subscribe to `memory`, take rows with `status = 'uploaded'` and its own `pipelineIdentity`; report `processing` with `scripts/pipeline-status.py`; download `sourceUrl` only if `scripts/source_check.py`'s `allowed_source(url, ASSET_BASE_URL or PUBLIC_ORIGIN/api/local-media, owner)` accepts it, with a size and time cap; skip rows whose `pipelineIdentity` is their own `owner` (test uploads); run the pipeline, reporting progress; upload the viewer files; finish with `ready --progress 1 --manifest-url https://…/memory.json`, or `failed`. The pod must reach SpacetimeDB at a public URL. | Vision |
| **Pipeline steps** | Being rewritten | Vision |
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
