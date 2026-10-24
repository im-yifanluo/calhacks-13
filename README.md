# Memory Replay

Record a moment on Ray-Ban Meta glasses. We rebuild it as a 3D scene that moves over time, and you walk back into it with friends on a Quest 3S or a phone. Pause time, grab things, throw them, and branch off an alternate timeline.

- **Full plan** (tracks, design, timeline, risks): [docs/PLAN.md](docs/PLAN.md)
- **P3 viewer:** [controls, verification, asset conventions, and the P4 integration API](docs/P3_VIEWER.md).
- **Status:** the multiplayer server works (18/18 smoke checks pass). The viewer runs in a browser with a mock scene. The pipeline stages are not started.

---

## Who does what

| Person | Owns | Folders | First goal tonight |
|---|---|---|---|
| **P1 · Pipeline** | GPU box, camera path + depth, background splat, export | `pipeline/` | One real glasses clip → background `.spz` with a URL |
| **P2 · Objects & AI** | Claude labels, SAM 3 masks, object splats, motion paths | `pipeline/` | Claude object list + SAM 3 masks on the same clip |
| **P3 · XR client** | Quest rendering, grab + physics, timeline in VR | `apps/web/` | Viewer on the Quest at 72 fps showing P1's splat |
| **P4 · Multiplayer & phone** | SpacetimeDB module, syncing, phone controls, upload page, demo | `server/spacetime/`, `apps/web/` | Two devices in one room seeing each other |

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

Open http://localhost:5173. The local demo uses a procedural splat floor, a moving ball, and a cube, with no external asset downloads. Pause, drag an object, release to throw, then play the new take. Select **Original** to return to the untouched recording. Load pipeline assets with `?memory=<encoded-manifest-url>`.

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

In the Quest Browser, open **http://localhost:5173** and press **Enter VR**. Over USB this counts as a secure page, so VR works without HTTPS.

- **A or X button:** play / pause
- **Squeeze or hand pinch:** grab a paused object; move and release to throw
- **Trigger on the floating panel:** play/pause, seek ±1 second, cycle takes, or return to Original
- **Left thumbstick:** move; **right thumbstick:** snap-turn
- **B or Y button:** cycle takes
- **Debug the headset page:** open `chrome://inspect` in desktop Chrome

**Phones and judges** need a public link:

```bash
brew install cloudflared
npm run tunnel               # prints https://<random>.trycloudflare.com
```

The app and SpacetimeDB share that one link. The dev server forwards `/v1` to the local SpacetimeDB, so nothing else needs exposing.

---

## Part 4 · P1 / P2: Reconstruction pipeline (GPU)

The pipeline runs on **one shared Runpod H100 (80 GB)**. Ask the Runpod booth for credits. P1 owns the box; P2 works on it too.

**Create the pod**
- Template: a PyTorch / CUDA 12.x image
- Add a **200 GB network volume** mounted at `/workspace`, so models and data survive restarts
- Add your SSH key and connect with `ssh root@<pod-ip> -p <port>`

**Base tools on the pod**

```bash
apt-get update && apt-get install -y ffmpeg git
curl -LsSf https://astral.sh/uv/install.sh | sh     # fast Python envs
cd /workspace && git clone <repo-url> memory-replay
```

**One environment per tool.** They need different CUDA and Python versions, so don't mix them. Check each repo's README for its exact install line; these were current on Oct 23.

| Env | For | Install |
|---|---|---|
| `core` | our CLI, ffmpeg steps, export | `uv venv /workspace/envs/core && source /workspace/envs/core/bin/activate && uv pip install -e memory-replay/pipeline anthropic` |
| `sam3` | object masks (P2) | Python 3.12, PyTorch ≥ 2.7, CUDA ≥ 12.6. `git clone https://github.com/facebookresearch/sam3` and follow its README |
| `recon` | camera path + depth (P1) | Depth Anything 3 (`ByteDance-Seed/Depth-Anything-3`) or VGGT (`facebookresearch/vggt`) |
| `splat` | background splat (P1) | `uv pip install gsplat` (needs nvcc; first run compiles CUDA kernels) |
| `obj3d` | object splats (P2) | SAM 3D Objects (`facebookresearch/sam-3d-objects`). Fallback: TRELLIS.2 (`microsoft/TRELLIS.2`) |

**Model access**
- SAM 3 and SAM 3D weights are on Hugging Face and may require accepting a license. Do it early, then run `huggingface-cli login` on the pod.
- Claude: `export ANTHROPIC_API_KEY=...` in the `core` env. Never commit it; `.env` files are git-ignored.

**Working on a laptop without a GPU** (editing code, the manifest, export logic):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e pipeline
memreplay --help
```

**Output goes to storage, not git.** Upload `memory.json` and the `.spz`/`.glb` files to the shared bucket, then open the viewer with `http://localhost:5173/?memory=<url-of-memory.json>`.

---

## Daily commands

| Command | What it does |
|---|---|
| `npm run dev` | Viewer at http://localhost:5173 (smoke test at `/smoke.html`) |
| `npm run build` | Production build into `apps/web/dist` |
| `npm test` | P3 track, branch, ownership, and real Rapier regression tests |
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
