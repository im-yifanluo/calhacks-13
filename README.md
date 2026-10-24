# Memory Replay

Record a moment on Ray-Ban Meta glasses. We rebuild it as a 3D scene that moves over time, and you walk back into it with friends on a Quest 3S or a phone. Pause time, grab things, throw them, and branch off an alternate timeline.

- **Full plan** (tracks, design, timeline, risks): [docs/PLAN.md](docs/PLAN.md)
- **Vision pipeline runbook:** [pipeline/README.md](pipeline/README.md)
- **Status:** the multiplayer server works (18/18 smoke checks pass). The viewer runs in a browser with a mock scene. In the pipeline, the file formats are done (including ghosts, primitive objects, velocity and audio) and `memreplay merge` is done and tested. The pipeline steps themselves (S1–S6) are not written yet, and nothing has run on a real pod or real glasses footage.

---

## Who does what

| Person | Owns | Folders | First goal tonight |
|---|---|---|---|
| **Vision (one person)** | The whole pipeline: one glasses clip in, `memory.json` out. ViPE cameras + depth + masks, world frame, room points + collider, people ghosts, grabbable objects, background splat, merge. Owns the GPU pod. | `pipeline/` (S0–S7) | Pod up and ViPE go/no-go (about 3 hours in), then L0 `memory.json` in the Quest (Checkpoint 1) |
| **P3 · XR client** | Quest rendering, grab + physics, timeline in VR. New formats to support: `points-sequence` ghosts (three.js Points, Float16 positions), `primitive` objects (tinted sphere / box / cylinder), Rapier with sphere / box / cylinder colliders and the room collider (`background.colliderUrl`, as a trimesh), keyframe velocity `v` handed to physics on pause, `source.audioUrl` played in sync (resync past 100 ms drift), `.ply` background first, then `.spz` | `apps/web/` | Viewer on the Quest at 72 fps, then load the L0 `memory.json` |
| **P4 · Multiplayer & phone** | SpacetimeDB module, syncing, phone controls, upload page, storage bucket, demo | `server/spacetime/`, `apps/web/` | Two devices in one room seeing each other |

Everyone does **Part 1**. Then do the part for your role.

---

## Part 1 · Everyone (5 minutes)

You need **Node 20 or newer** and **git**.

```bash
node -v            # should print v20 or higher. If not: brew install node
git clone <repo-url> memory-replay && cd memory-replay
npm install
npm run dev
```

Open http://localhost:5173. You should see a butterfly splat and a box moving along a timeline. The splat can take ~10 s to appear on slow Wi-Fi.

> If `npm install` times out on venue Wi-Fi, switch to a phone hotspot and run it again.

---

## Part 2 · P4: SpacetimeDB (multiplayer server)

**Install the CLI** (macOS / Linux; on Windows use WSL):

```bash
curl -sSf https://install.spacetimedb.com | sh
spacetime --version          # expect 2.13.x
```

**Run it locally.** Use two terminals:

```bash
npm run stdb:start           # terminal 1: server on 127.0.0.1:3055
npm run stdb:publish:local   # terminal 2: build + upload the module
```

**Check it works.** With `npm run dev` running, open http://localhost:5173/smoke.html. Two fake players join a room, pause, fork, grab, throw and leave. All 18 lines should say PASS.

**After changing `server/spacetime/src/index.ts`:**

```bash
npm run stdb:publish:local   # add -- --delete-data=always if you changed a table
npm run stdb:generate        # refresh apps/web/src/module_bindings
```

**For the demo** (optional): `spacetime login`, then publish to Maincloud with `spacetime publish -s maincloud -p server/spacetime memory-replay`. The free tier lasts about 2 hours of live use, so run locally on our own router if you can.

---

## Part 3 · P3 / P4: Quest 3S and phones

**One-time Quest setup**

1. Turn on Developer Mode for the headset in the Meta Horizon phone app. This needs a free Meta developer account (developers.meta.com) with an organization.
2. Install adb: `brew install android-platform-tools` (or install Meta Quest Developer Hub).
3. Plug the Quest into the laptop with USB-C and allow USB debugging inside the headset.

**Every session**

```bash
npm run dev
adb reverse tcp:5173 tcp:5173
```

In the Quest Browser, open **http://localhost:5173** and press **VR**. Over USB this counts as a secure page, so VR works without HTTPS.

- **A or X button:** play / pause
- **Thumbstick left/right (while paused):** scrub through time
- **Debug the headset page:** open `chrome://inspect` in desktop Chrome

**Phones and judges** need a public link:

```bash
brew install cloudflared
npm run tunnel               # prints https://<random>.trycloudflare.com
```

The app and SpacetimeDB share that one link. The dev server forwards `/v1` to the local SpacetimeDB, so nothing else needs exposing.

---

## Part 4 · Vision pipeline (GPU)

> **Full runbook: [pipeline/README.md](pipeline/README.md).** Every step, the tool it uses, the exact commands, and how to set up and run everything on Runpod.

**The plan.** One glasses clip in, one `memory.json` out, built by one person. ViPE runs first because everything depends on it: from the single video it gives the camera path, the lens, metric depth for every pixel and per-frame object masks. It gets a go/no-go about 3 hours in. The glasses have one camera (the second opening is the capture LED), so there is no stereo pair; depth comes from the wearer's head moving over time plus ViPE's metric depth model. Two environments: `world` (our code, ffmpeg, gsplat, open3d, Claude SDK) and `vipe` (ViPE's own). L0 (room points + ghosts + head path) comes first, then L1 (pause, grab and throw objects) by morning. **Gate at Sat 11:30 AM:** any failing step switches to its fallback. **L1 is frozen at Sat 12:00 PM (Checkpoint 2).**

**Quick start on the pod** (from the repo root):

```bash
bash pipeline/runpod/setup.sh base world vipe warmup   # warmup pre-downloads ViPE's weights; one comes from Google Drive and can be rate-limited
```

**Recording rules:**
- **1080p at 30 fps, stabilization OFF.**
- **Scripted take, under 30 s:** look at the floor for 3 s, then walk 2–3 m sideways while slowly panning, then the action. Shoot 3 takes. (Turning your head in place gives ViPE no parallax to triangulate from.)
- **Props:** 2–3 symmetric, brightly coloured things (ball, can, bottle). Someone else moves or throws them. Symmetric means position-only tracking is enough.
- **One person in frame.** The wearer turns their head slowly.
- **Measure the wearer's eye height.** It checks ViPE's scale.
- **Optional:** film a checkerboard on a laptop screen for 15 s. It is the fallback lens fix if the ultrawide footage comes out bent.
- Export the clip through the Meta AI app (`.mov` on iPhone, `.mp4` on Android). Its audio plays in sync in the viewer.

**On a laptop without a GPU** (editing code, testing `merge` on a work folder copied from the pod):

```bash
python3.12 -m venv .venv && source .venv/bin/activate   # needs Python >= 3.10; macOS's /usr/bin/python3 is 3.9 (brew install python@3.12)
pip install -e pipeline          # add anthropic for Claude calls
memreplay --help
memreplay merge work/<id> --title "..."
```

---

## Daily commands

| Command | What it does |
|---|---|
| `npm run dev` | Viewer at http://localhost:5173 (smoke test at `/smoke.html`) |
| `npm run build` | Production build into `apps/web/dist` |
| `npm run tunnel` | Public HTTPS link for phones and judges |
| `npm run stdb:start` | Local SpacetimeDB on port 3055 |
| `npm run stdb:publish:local` | Upload the server module to it |
| `npm run stdb:generate` | Regenerate the client bindings |

---

## Repo layout

```
apps/web/            Viewer: one web app for Quest, phones and laptops (three.js, Spark, Rapier)
  src/main.ts        scene, timeline, VR controls
  src/smoke.ts       two-player multiplayer test (/smoke.html)
  src/module_bindings/  generated from the server module; don't edit by hand
server/spacetime/    SpacetimeDB module: rooms, players, clock, branches, grabbing
packages/shared/     memory.json format (TypeScript). Python copy: pipeline/memreplay/manifest.py
pipeline/            Python pipeline: glasses clip → ViPE (cameras, depth, masks) → room, ghosts, objects → memory.json
docs/PLAN.md         The plan
```

---

## Team rules

- **`memory.json` is the contract.** The pipeline and viewer only talk through it. If you change it, change `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py` in the same PR and tell the team.
- **The viewer never waits on the pipeline.** Build against `apps/web/public/mock/memory.json`.
- **Branches:** `pipe/*`, `web/*`, `stdb/*`, `demo/*`. Small PRs into `main`, and `main` must always run.
- **No big files in git:** `.ply`, `.spz`, `.glb` and `.mp4` go to storage.

---

## Gotchas

- **Ports 3000/3001** are often taken by Docker, which is why SpacetimeDB uses **3055**.
- **The `spacetime` CLI defaults to Maincloud.** For local work always pass `-s http://127.0.0.1:3055`; the npm scripts already do.
- **Server module code must be deterministic.** No `Math.random()` or `Date.now()`; use `ctx.random` and `ctx.timestamp`.
- **Names differ by side:** snake_case on the wire and in SQL (`create_room`), camelCase in TypeScript (`conn.reducers.createRoom({...})`).
- **Object modes** in `objectState`: `held` (in a hand), `thrown` (the thrower's device still simulates it, and anyone can catch it), `rest`.
- **Grabbing on the original recording automatically starts a new branch.** The original is never edited.
