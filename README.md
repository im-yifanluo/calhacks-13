# Memory Replay

Record a moment on Ray-Ban Meta glasses. We rebuild it as a 3D scene that moves over time, and you walk back into it with friends on a Quest 3S or a phone. Pause time, grab things, throw them, and branch off an alternate timeline.

- **Full plan** (tracks, design, timeline, risks): [docs/PLAN.md](docs/PLAN.md)
- **Status:** the multiplayer server works (18/18 smoke checks pass). The viewer runs in a browser with a mock scene. In the pipeline, the file formats are frozen and `memreplay merge` works; the other stages are not started.

---

## Who does what

| Person | Owns | Folders | First goal tonight |
|---|---|---|---|
| **P1 · World** | The room: frames, ViPE camera path + depth, world frame (floor, scale), background splat, people ghosts, final merge. Owns the GPU pod. | `pipeline/` (S0, S3–S6, S9) | Test-clip frames to P2 by 11:30 PM, ViPE go/no-go + cameras, depth and `world.json` v0 by 1 AM, L0 `memory.json` to P3 by 2:30 AM |
| **P2 · Things** | Everything you can grab: Claude nouns, SAM 3 masks, SAM 3D object splats + colliders, CoTracker3 6DoF tracks | `pipeline/` (S1, S2, S7, S8) | Hugging Face access requested by 11:15 PM, `nouns.json` v0 by 11:30, masks v0 by 1 AM, translation-only tracks + box colliders by 2:30 AM |
| **P3 · XR client** | Quest rendering, grab + physics, timeline in VR | `apps/web/` | Viewer on the Quest at 72 fps showing P1's splat |
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

## Part 4 · P1 / P2: Reconstruction pipeline (GPU)

**Full runbook: [pipeline/README.md](pipeline/README.md).** It covers what each step does, the tool it uses, the exact commands, and how to set up and run everything on Runpod.

**One clip per memory, no room sweep.** **P1 · World** turns the clip into the room: frames, the camera path and depth (ViPE), the world frame, the background splat, the people ghosts and the final merge (S0, S3–S6, S9). **P2 · Things** builds everything you can grab: Claude's nouns, SAM 3.1 masks, SAM 3D object assets and CoTracker3 tracks (S1, S2, S7, S8). ViPE masks moving things itself and writes those masks to disk, so P1 never waits on P2 for cameras or for the L0 demo. P2 works in camera coordinates until P1's world cameras land.

**Quality levels.** L0 = background + ghosts + head path (P1 alone). L1 = L0 + grabbable objects with tracks (P2's work). L2 (people meshes) and L3 (full 4D) are stretch goals.

**The only things that cross between you** are the files in [`pipeline/memreplay/handoff.py`](pipeline/memreplay/handoff.py). Read it first, and change it only when you both agree. The formats are frozen as of Fri 11:15 PM.

| When | P1 · World | P2 · Things |
|---|---|---|
| Fri 11:15 PM | — | Request Hugging Face access to `sam3.1`, `sam3` and `sam-3d-objects` |
| Fri 11:30 PM | `frames/` + `frames.json` for the test clip → P2 | `nouns.json` v0 → P1 |
| Sat 1:00 AM | ViPE go/no-go; `world/cameras.json` + `depth.npz` + `world.json` v0 → P2 | masks v0 → P1 (SAM 2.1 clicks if access is still pending) |
| Sat 2:30 AM | **Checkpoint 1:** L0 `memory.json` → P3 (fused-point background + ghosts + head path) | translation-only tracks + box colliders |
| Overnight | gsplat on the test clip | SAM 3D batch + Kabsch tracker |
| Sat 9:00 AM | Shoot the demo clip with everyone (3 takes) | Shoot the demo clip with everyone |
| Sat 10:00 AM | final cameras + world | final masks |
| Sat 11:00 AM | `world/bg.spz` + ghosts | object assets + tracks |
| Sat 11:30 AM | `memreplay merge` → `memory.json` v1 | — (assets + tracks already delivered at 11:00) |

**Gate at Sat 11:30 AM:** any stage that is failing switches to its fallback. **L1 is frozen at Sat 12:00 PM (Checkpoint 2).**

**Quick start on the pod** (details in the runbook, section 4):

```bash
bash /workspace/memory-replay/pipeline/runpod/setup.sh base           # once, first
bash /workspace/memory-replay/pipeline/runpod/setup.sh vipe world     # P1
bash /workspace/memory-replay/pipeline/runpod/setup.sh seg obj        # P2
```

**Recording tonight** (full rules in [docs/PLAN.md §5](docs/PLAN.md)):
- **1080p at 30 fps, stabilization OFF.** This is the mode where the toggle is documented; 3K is unverified.
- **One clip per take, 30–60 s:** about 10 s of slow look-around, walk 2–3 m, then the action. Turn your head slowly. Shoot 3 takes.
- **Props:** 1–3 rigid, textured, matte things of 10–50 cm (printed box, book, patterned ball). Someone else moves or throws them. Avoid shiny, thin, deformable or plain props; textureless props can't be tracked.
- **Measure the wearer's eye height.** It sets the scale. The wearer should stand; sitting breaks the eye-height scale.
- **Film a checkerboard** on a laptop screen for 15 s. S0 uses it to straighten the ultrawide lens, which ViPE needs to produce depth.
- **Even light**, and avoid windows.
- An empty-room sweep is optional insurance only. Nothing reads it.

**On a laptop without a GPU** (editing code, testing `merge` on a work folder copied from the pod):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e pipeline          # add anthropic for Claude calls
memreplay --help
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
pipeline/            Python pipeline: video → masks → camera/depth → splats → tracks → memory.json
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
