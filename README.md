# memos

Record a moment on Ray-Ban Meta glasses. We rebuild it as a 3D scene that moves over time, and you walk back into it with friends on a Quest 3S or a phone. Pause time, grab things, throw them, and branch off an alternate timeline.

- **How the pieces fit, and known issues:** [docs/INTEGRATION.md](docs/INTEGRATION.md). Agents should read [CLAUDE.md](CLAUDE.md) first.
- **Full plan** (tracks, design, timeline, risks): [docs/PLAN.md](docs/PLAN.md)
- **Viewer:** [docs/P3_VIEWER.md](docs/P3_VIEWER.md) · **Multiplayer and upload:** [docs/P4.md](docs/P4.md) · **Upload test:** [docs/CAPTURE_TEST.md](docs/CAPTURE_TEST.md)
- **Vision pipeline runbook:** [pipeline/README.md](pipeline/README.md); results on the 5 sample clips: [docs/VISION_PIPELINE_REPORT.md](docs/VISION_PIPELINE_REPORT.md)

**Phone app:** open `apps/ios/SceneCaptureDemo.xcodeproj` for a native iPhone/Simulator demo with **On** and **Off**, automatic upload, database + SHA-256 verification, offline playback and retry. [Installation and test instructions](docs/PHONE_APP.md). The separate glasses SDK project requires Meta's supported Xcode toolchain. Web library: `/library.html` (name-based guest profile, upload, processing status and ready scene links). Diagnostics: `/capture.html`. [Frontend flow and identity details](docs/FRONTEND_FLOW.md).

**Parties and Google sign-in:** [Setup and test guide](docs/PARTIES.md). Create a party with a synthetic scene, share its invite link, and let the leader control time. The native phone app has a Party tab. Google requires your own web client ID; guest parties work immediately. `npm run party:dev` starts the web/upload pair for the dedicated local party database.

## Status (Sat Oct 24)

| Part | State |
|---|---|
| Viewer: splats, physics, VR controls, timeline replay, people ghosts, audio (Nikko) | Merged. Checked in a desktop browser; never run on a Quest. |
| Multiplayer: parties, leader clock, invite links, avatars, shared takes | Local database and multi-client tests pass. Google sign-in is implemented; configuring a web client ID and testing real Google consent remains required. |
| Upload service and capture test page (Jerry) | Merged. Uploads to local disk or S3/R2 and registers the clip in SpacetimeDB. |
| Vision pipeline (`pipeline/`) | Built and run on all 5 sample clips (iPhone): video → ViPE → world frame → room splat, collider, people ghosts, grabbable props → `memory.json`, plus a static walk-through file (`memory.static.json`) per clip. `memreplay worker` picks up uploads; not yet run against a live SpacetimeDB. |
| Native iPhone app | Standalone On/Off demo builds for Simulator. Full Meta SDK target and physical glasses remain unverified. See [docs/PHONE_APP.md](docs/PHONE_APP.md). |
| Left out | Andrew's `origin/part1` (pipeline rewrite). See [docs/INTEGRATION.md](docs/INTEGRATION.md) §1. |

What's fixed and what's still open: [docs/INTEGRATION.md](docs/INTEGRATION.md) §4.

---

## Who does what

| Person | Owns | Folders |
|---|---|---|
| **Vision (one person)** | The whole pipeline: one glasses clip in, `memory.json` out, plus the worker that picks up uploads. Owns the GPU pod. | `pipeline/` |
| **P3 · XR client** | Quest rendering, grab + physics, timeline in VR, people ghosts, audio. Next: test on the Quest (controls, frame rate, load time). | `apps/web/` |
| **P4 · Multiplayer & phone** | SpacetimeDB module, network adapter, room panel, phone controls, upload, demo | `server/`, `apps/web/src/net/`, `apps/web/src/session.ts` |

---

## Part 1 · Everyone (5 minutes)

You need **Node 22.12 or newer** (`.nvmrc` pins 22.23.2) and **git**.

```bash
node -v            # should print v22.12 or higher. If not: brew install node (or nvm install)
git clone https://github.com/im-yifanluo/calhacks-13.git memory-replay && cd memory-replay
npm install
LOCAL_HTTP=1 npm run dev
```

Open http://127.0.0.1:5173. The local demo uses a procedural splat floor, a moving ball and a can, with no downloads. Pause, drag an object, release to throw, then play the new take. Select **Original** to return to the untouched recording. Load another scene with `?memory=<manifest-url>`; `?memory=/mock/memory.json` loads a demo scene whose splat comes from sparkjs.dev (needs internet).

**Exploring a reconstructed memory.** The recorded camera path is drawn on the floor. `?mode=free` (default) lets you go anywhere; `?mode=guided`, or the **Guided path** toggle, keeps you within 0.75 m of the path and fogs the view as you look where the camera never looked, because a scene from one hand-held camera is only reliable there. Stretches where tracking was lost fade to black in guided and wearer's view. **Wearer's view** replays the recording's own camera. On a laptop, walk with **W/A/S/D** (or the up/down arrows), **Q/E** to go down/up, **Shift** to run; drag to look around. `?lod=0` draws every Gaussian (for comparisons; slower). `/status/index.html` shows pipeline progress and links to every scene (reads `/memories/status.json`).

Plain `npm run dev` serves **HTTPS** with a self-signed certificate on every network interface, for opening the laptop's LAN IP from a headset or phone. `LOCAL_HTTP=1` serves plain http on 127.0.0.1 only.

> If `npm install` times out on venue Wi-Fi, switch to a phone hotspot and run it again.

---

## Part 2 · Multiplayer (local SpacetimeDB)

**Install the CLI** (macOS / Linux; on Windows use WSL):

```bash
curl -sSf https://install.spacetimedb.com | sh
spacetime --version          # expect 2.13.x
```

**Run it locally.** Use three terminals:

```bash
npm run stdb:start           # terminal 1: SpacetimeDB on 127.0.0.1:3055
npm run stdb:publish:local   # terminal 2: build + publish the module as memory-replay
npm run upload:local         # terminal 2: upload service on 127.0.0.1:8788 (local disk storage)
LOCAL_HTTP=1 npm run dev     # terminal 3: the app on http://127.0.0.1:5173
```

Port 3055 avoids Docker, which often holds 3000/3001. Set `STDB_PORT=<port>` to use another one; the npm scripts, the Vite proxy, `upload:local` and `test:integration` all follow it. `stdb:publish:local` uses your `spacetime login`; for a throwaway test without a login, see [docs/P4.md](docs/P4.md).

**Share a party** (guest tabs are separate players):
1. In **PARTY**, enter a name, keep **Synthetic demo · ready to play** selected and press **Create party**.
2. Use **Copy invite link** and open it in another tab/device, or enter the seven-character code and press **Join**.
3. The leader controls playback, seeking, speed and take selection. Other members follow the clock and can explore/grab objects while paused.
4. Use **Make leader** to transfer control. A leader's last disconnect elects another connected member. See [the complete party/Google test](docs/PARTIES.md).

The server root `/` is a solo session. Joining or creating a party uses `/ROOMCODE`; opening or refreshing that address rejoins it. Existing `?room=<code>` invitations remain supported. If SpacetimeDB restarts, pages reconnect within about 5 s. Joining a room drops takes you made solo; **Leave** returns to `/`. The database selects the room's scene; asset URLs stay out of the shared room address. Production hosting needs SPA fallback for direct room paths. See [the hosted demo guide](docs/ONLINE_DEMO.md). In dev builds, `window.__memreplay` exposes the viewer state for debugging.

**Check it works:**

```bash
npm test                     # vitest (module harness, upload, storage, adapter) + the viewer's node tests
npm run typecheck
STDB_DATABASE=memory-replay npm run test:integration   # live: real WebSockets against the local server
npx tsx scripts/test-adapter.ts                       # live: two players + a late joiner through the viewer adapter
```

**After changing `server/spacetime/src/index.ts`:**

```bash
npm run stdb:publish:local   # preserve data; inspect migration requirements before changing existing tables
npm run stdb:generate        # refresh apps/web/src/module_bindings (never edit by hand)
```

**For the demo** (optional): `spacetime login`, then publish to Maincloud with `spacetime publish -s maincloud --module-path server/spacetime memory-replay`. The free tier lasts about 2 hours of live use, so run locally on our own router if you can.

---

## Part 3 · Quest 3S and phones

**One-time Quest setup**

1. Turn on Developer Mode for the headset in the Meta Horizon phone app. This needs a free Meta developer account (developers.meta.com) with an organization.
2. Install adb: `brew install android-platform-tools` (or install Meta Quest Developer Hub).
3. Plug the Quest into the laptop with USB-C and allow USB debugging inside the headset.

**Every session**

```bash
LOCAL_HTTP=1 npm run dev
adb reverse tcp:5173 tcp:5173
```

In the Quest Browser, open **http://localhost:5173** and press **Enter VR**. Over USB this counts as a secure page, so VR works without HTTPS.

- **A or X button:** play / pause
- **Squeeze or hand pinch:** grab a paused object; move and release to throw
- **Trigger on the floating panel:** play/pause, seek ±1 second, cycle takes, or return to Original
- **Left thumbstick:** move; **right thumbstick:** snap-turn
- **B or Y button:** cycle takes
- **Debug the headset page:** open `chrome://inspect` in desktop Chrome

**Phones and judges** need a public HTTPS link:

```bash
brew install cloudflared
npm run tunnel               # with plain `npm run dev` (HTTPS); prints https://<random>.trycloudflare.com
# or, with LOCAL_HTTP=1 npm run dev:
cloudflared tunnel --url http://127.0.0.1:5173
```

The app, SpacetimeDB (`/stdb`) and the upload service (`/api`) share that one link through the dev server's proxy, so nothing else needs exposing. On phones, a joystick walks you around, and touch-drag grabs and throws. Register library manifests from the tunnel URL, not `127.0.0.1`, or phones can't open them.

---

## Part 4 · Vision pipeline (GPU)

> **Full runbook: [pipeline/README.md](pipeline/README.md).** Every step, the tool it uses, the exact commands, and how to set up and run everything on Runpod. **Results and limitations:** [docs/VISION_PIPELINE_REPORT.md](docs/VISION_PIPELINE_REPORT.md).

**What it does.** One clip in, one `memory.json` out: `memreplay run work/<id> --title "..." --eye-height 1.35` on the GPU pod. NVIDIA ViPE gives the camera path, lens, metric depth for every pixel and object masks; our code puts everything in a level, metric world frame, builds the room (points, then a trained Gaussian splat), a room collider, people as point ghosts and the small props as grabbable shapes (Claude picks shape and mass). **Walk through a room on the Quest:** `memory.static.json` is the room alone (Part 3 for the headset; open `/?memory=/memories/<id>/memory.static.json`).

**Recording rules:**
- **1080p at 30 fps, stabilization OFF.**
- **Scripted take, under 30 s:** look at the floor for 3 s, then walk 2–3 m sideways while slowly panning, then the action. Shoot 3 takes. (Turning your head in place gives ViPE no parallax to triangulate from.)
- **Props:** 2–3 symmetric, brightly coloured things (ball, can, bottle). Someone else moves or throws them.
- **One person in frame.** The wearer turns their head slowly.
- **Measure the wearer's eye height.** It checks ViPE's scale.
- Export the clip through the Meta AI app (`.mov` on iPhone, `.mp4` on Android), then upload it from the app's upload panel or `/capture.html`.

---

## Daily commands

| Command | What it does |
|---|---|
| `LOCAL_HTTP=1 npm run dev` | App at http://127.0.0.1:5173 (plain http, loopback only). Without `LOCAL_HTTP`: HTTPS on all interfaces. Capture test page at `/capture.html`. |
| `npm run build` | Production build into `apps/web/dist` |
| `npm test` | vitest (`tests/`) + the viewer's node tests (`apps/web/tests/`) |
| `npm run typecheck` | Type-check the module and the web app |
| `npm run party:dev` | Start web + upload with matching party database/origin settings; publish first |
| `npm run test:party` | Live party authority, presence, clock, handoff and worker-contract test |
| `npm run auth:configure -- CLIENT_ID` | Configure the public Google web client ID for both web and database builds |
| `npm run test:integration` | Live multiplayer test against a running SpacetimeDB (`STDB_DATABASE`, `STDB_WS_URL` or `STDB_PORT`) |
| `npm run tunnel` | Public HTTPS link for phones and judges |
| `npm run stdb:start` | Local SpacetimeDB on port 3055 (`STDB_PORT` overrides) |
| `npm run stdb:publish:local` | Publish the server module to it |
| `npm run stdb:generate` | Regenerate the client bindings |
| `npm run upload:local` | Upload service with local-disk storage on port 8788 |

---

## Repo layout

```
apps/web/            One web app for Quest, phones and laptops (three.js, Spark, Rapier)
  src/main.ts        app shell: scene, camera rig, VR entry, controls
  src/viewer.ts      engine: grab, throw, record and replay takes (+ timeline.ts, tracks.ts, physics.ts, loader.ts)
  src/net/           SpacetimeDB client (index.ts) and viewer↔server adapter (adapter.ts)
  src/session.ts     room panel: rooms, library, upload, players, avatars
  src/module_bindings/  generated from the server module; don't edit by hand
  capture.html       upload and stored-video test page
server/spacetime/    SpacetimeDB module: memories, rooms, players, clock, takes, grabbing
server/upload/       upload signing (S3/R2) and local-disk upload service
packages/shared/     memory.json format (TypeScript). Python copy: pipeline/memreplay/manifest.py
pipeline/            Python vision pipeline (being rewritten)
tests/               vitest: module harness, upload, storage
scripts/             live tests, splat test setup, worker status reporter
docs/                plan, integration guide, per-area guides
```

---

## Team rules

- **`memory.json` is the contract.** The pipeline and viewer only talk through it. If you change it, change `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py` in the same PR and tell the team.
- **The viewer never waits on the pipeline.** Build against `apps/web/public/mock/memory.json`.
- **Branches:** `pipe/*`, `web/*`, `stdb/*`, `demo/*`. Small PRs into `main`, and `main` must always run.
- **No big files in git:** `.ply`, `.spz`, `.glb` and `.mp4` go to storage.

---

## Gotchas

- **SpacetimeDB is on port 3055**, because Docker often holds 3000/3001. `STDB_PORT` changes it everywhere.
- **The `spacetime` CLI defaults to Maincloud.** For local work always pass `-s http://127.0.0.1:3055`; the npm scripts already do.
- **Server module code must be deterministic.** No `Math.random()` or `Date.now()`; use `ctx.random` and `ctx.timestamp`.
- **Names differ by side:** snake_case on the wire and in SQL (`create_room`), camelCase in TypeScript (`conn.reducers.createRoom({...})`).
- **Object modes** in `objectState`: `held` (in a hand), `physics` (thrown; the thrower's device simulates it, and nobody else can grab it until it rests), `rest`.
- **Takes:** grabbing on the original recording starts a new take; re-grabbing an object that already rests on a take starts another. The original is never edited.
