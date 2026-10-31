# Memory Replay: CalHacks 13 plan

> The plan as written at the start of the hackathon, kept as a record. File paths, owners and statuses are from that
> time; the current design is in [architecture.md](../architecture.md).

Record a moment on Ray-Ban Meta glasses, rebuild it as a **4D scene** (3D + time), and walk back into it with friends on a **Quest 3S or a phone**. Pause time, grab things, throw them, and branch off an **alternate timeline**.

_Written Fri Oct 23, 7 PM. Vision pipeline revised Sat Oct 24, after midnight, for one owner: ViPE on one clip, simple object shapes picked by Claude, SAM 3 and SAM 3D cut. Items marked (verify) or unverified still need checking._

---

## 0. Decisions

| Question                    | Decision                                                                                                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unity or web?               | **One WebXR web app** (three.js + Spark splats), served over HTTPS to the Quest 3S browser, phones and laptops                                                                                                                                 | One URL gives you sharing, phones and multiplayer together. Unity Gaussian splats on Quest are only "reported to work" (aras-p's plugin is no longer developed), and Unity would mean a second phone build.                                                                                                                                                                                                                                     |
| XR framework                | Default: **plain three.js + Spark 2.4 + Rapier**, built out on `origin/nikko` (see docs/INTEGRATION.md). Spike: **Meta IWSDK** (Havok physics, grab, locomotion built in), timeboxed to 90 min tonight                                         | IWSDK saves hours of grab and hand code. The risk is that it pins `three` to `super-three@0.185`, and Spark has to share that same instance. Switch only if the spike renders a `.spz` on Quest at 72 fps.                                                                                                                                                                                                                                      |
| Full 4D Gaussian splatting? | **No, use a layered scene.** A static background, people as per-frame colored points ("ghosts"), and each grabbable object as a simple shape with a collider and a position track                                                              | Per-scene 4DGS (Shape of Motion, MoSca) takes hours to train, is fragile on head-mounted video, and **gives no colliders**, so no physics. Layering gets you motion and physics together.                                                                                                                                                                                                                                                       |
| Camera solve                | **NVIDIA ViPE on the single clip. No room sweep.** Go/no-go about 3 hours after the pod starts.                                                                                                                                                | One model gives the camera path, lens, metric depth for every pixel and per-frame masks. The glasses have one camera and export a single view, so there is no stereo pair: ViPE triangulates across time as the wearer moves, and a metric depth model sets the scale. DA3 and VGGT assume a static scene, and VGGT has no metric scale. A separate sweep would mean registering two clips, and it breaks the "footage you already shot" pitch. |
| Semantic segmentation       | **ViPE's own masks**, prompted with single words we type (`person`, `hand`, `ball`, `can`...). **SAM 2.1 + Grounding DINO only if ViPE's masks are poor. SAM 3 is cut.**                                                                       | ViPE already writes a mask with object IDs for every frame. SAM 3 has gated weights and an environment that clashes with the rest. Dropping it takes the setup from 5 environments to 2.                                                                                                                                                                                                                                                        |
| Multiplayer backend         | **SpacetimeDB 2.13 with a TypeScript module.** It's a CalHacks 13 sponsor.                                                                                                                                                                     | Rooms, avatars, the shared clock, grab ownership and timeline branches all map onto tables and reducers, and the browser SDK is `spacetimedb` on npm.                                                                                                                                                                                                                                                                                           |
| Physics authority           | **The player holding an object simulates it.** The server only arbitrates ownership.                                                                                                                                                           | No server physics tick and no lockstep. Everyone else interpolates the owner's transforms.                                                                                                                                                                                                                                                                                                                                                      |
| GPU                         | **One Runpod H100 80GB pod** with a persistent volume, owned by Vision. **Two environments:** `world` (our code, ffmpeg, gsplat, open3d, Claude SDK) and `vipe` (ViPE's own uv venv) (section 2.2). (Runpod is a sponsor, so ask for credits.) | ViPE and gsplat need a CUDA box you can SSH into to debug. ViPE keeps its packages in its own uv venv, so it gets its own env.                                                                                                                                                                                                                                                                                                                  |
| Repo                        | **Monorepo with npm workspaces** (this repo)                                                                                                                                                                                                   | The `memory.json` contract, viewer, server module and pipeline change together in one PR.                                                                                                                                                                                                                                                                                                                                                       |

---

## 1. Tracks, sponsors and credits

The Slack connected to Claude is **RoboTouchLab (UIUC), not CalHacks**, so none of this came from Slack. Sources are calhacks.io and last year's live site.

- **Confirmed CH13 sponsors** (calhacks.io): **SpacetimeDB, Meta, Anthropic, Runpod**, Supercell, Convex, Fetch.ai, Bright Data, Microsoft, Figma, Cartesia, Apify, Elastic, YC, a16z, and more. $100k in prizes. Event is Oct 23–25 at the Palace of Fine Arts.
- **The CH13 prize list isn't published yet.** `live.calhacks.io/prizes` still shows CH12, and the CH13 Devpost returned 403.
- **The deadline is unknown.** CH12 had initial submission Sun 4:30 PM, final at 5:30 PM, and judging 5:30–7:30 PM. **This plan assumes Sun 4:30 PM** (verify).
- **Credits:** none published yet. Ask at the **Runpod** (GPU), **Anthropic** (API credits; CH12's Best Use of Claude prize was $5k in credits) and **SpacetimeDB** (Maincloud Pro) booths.

**Tracks to target** (re-rank once the CH13 list is posted):

1. **SpacetimeDB.** The whole shared world runs on it: rooms, a mixed Quest and phone presence, the shared clock, grab ownership, and branching timelines stored as data.
2. **Meta.** Capture on Ray-Ban Meta glasses, relive the moment on a Quest 3S, and Meta's Immersive Web SDK if the spike passes.
3. **Best Use of Claude**, if it repeats. Claude picks each object's shape, size and mass from its label and a crop, titles and captions memories, and turns "what if the ball went left?" into a physics edit on a new branch.
4. **Overall / Most Creative.** The pitch: "Hyperscape gives you a static room. We give you the moment, and you can change it."
5. **Runpod / Supercell**, if they run tracks: GPU pipeline, and game-like physics play.

> **Action for a human, tonight:** in the CalHacks 13 Slack, read #announcements and every `#spons-*` channel (spacetimedb, meta, anthropic, runpod). Update this section with the real tracks and deadline.

---

## 2. System design

```
 Ray-Ban Meta (1080p30, stabilization OFF)
        │ Meta AI app → camera roll
        ▼
 ┌──────────────┐   upload (presigned PUT)   ┌───────────────────────────┐
 │ Phone/web    │ ─────────────────────────▶ │ Object storage (R2/S3)    │
 │ /upload page │                            │ videos, .spz, .glb, json  │
 └──────────────┘                            └──────────┬────────────────┘
        │ createMemory reducer                          │ read/write
        ▼                                               ▼
 ┌─────────────────────────┐  status via HTTP   ┌──────────────────────────────────────────┐
 │ SpacetimeDB 2.13 module │ ◀───────────────── │ GPU pipeline (Runpod H100), one clip     │
 │ memory, room, player,   │                    │ S1 normalize  ffmpeg: 30 fps mp4 + audio │
 │ timeline, branch,       │                    │ S2 ViPE       camera path, depth, masks  │
 │ object_state, grab,     │                    │ S3 world      open3d: floor, +Y up       │
 │ branch_keyframes        │                    │ S4 L0         points, room, ghosts       │
 └──────────┬──────────────┘                    │ S5 objects    tracks + Claude shapes     │
            │ websocket subscriptions           │ S6 background gsplat → bg.spz            │
            ▼                                   │ S7 merge      memreplay merge            │
 ┌─────────────────────────────────────────┐    └──────────────────────────────────────────┘
 │ Viewer (apps/web): one URL              │
 │  Quest 3S browser: immersive-vr, hands  │
 │  Phone: touch orbit + tap-grab          │
 │  three.js · Spark · Rapier · STDB SDK   │──── loads memory.json + assets from storage
 └─────────────────────────────────────────┘
```

### 2.1 The contract: `memory.json`

Defined in [`packages/shared/src/manifest.ts`](../../packages/shared/src/manifest.ts), with a Python mirror in [`pipeline/memreplay/manifest.py`](../../pipeline/memreplay/manifest.py). It holds:

- **World frame:** +Y up, meters, floor at y = 0. The pipeline gravity-aligns the scene and checks its scale (S3), so **the viewer never sees ViPE's raw frame.**
- **Source:** clip length, fps and size, plus **`audioUrl`** (`input/audio.m4a`), played in sync with the timeline.
- **Background:** one splat (`.ply` points at L0, a trained `.spz` later), plus **`colliderUrl`**: a room collider `.glb` (floor + tables as a 10 cm heightfield), so thrown things land on tables.
- **Camera track:** the wearer's head path at 10 Hz plus the field of view, for "see it through my eyes" mode.
- **Objects:** visual, collider, mass, grabbable, visible time range, and a track `[{t, p, q}]` at 10 Hz. New in this revision:
  - visual kind **`primitive`**: a tinted sphere, box or cylinder (grabbable objects);
  - visual kind **`points-sequence`**: per-frame colored points in one binary file (people ghosts; layout in [`pipeline/memreplay/handoff.py`](../../pipeline/memreplay/handoff.py));
  - collider kind **`cylinder`**, next to box, sphere, capsule and convex hull;
  - per-keyframe **velocity `v`** in m/s, handed to physics on pause.

The viewer develops against `apps/web/public/mock/memory.json` and never waits on the pipeline. The mock doesn't use the new fields yet.

### 2.2 Reconstruction pipeline (`pipeline/`, Python, Runpod GPU)

**Step-by-step commands and Runpod setup: [pipeline/README.md](../../pipeline/README.md).**

**One person ("Vision") owns the whole pipeline. One clip per memory; there is no separate room sweep.** Each memory gets one work dir, and every step reads and writes files in it (layout and formats in [`pipeline/memreplay/handoff.py`](../../pipeline/memreplay/handoff.py)). So any step reruns alone: `memreplay stage <name> --work work/<id>`. S2 is ViPE's own `run.py`. S7 is `memreplay merge work/<id>`, which is done and tested; the other `memreplay` steps are still stubs.

**Input: what the glasses give**

| What                   | Details                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| File                   | One video, exported through the Meta AI app to a phone: HEVC `.mov` on iPhone, `.mp4` on Android. Clips up to 3 min, with an audio track. |
| Camera                 | One 12 MP ultrawide camera, portrait 3:4. Modes listed by Ray-Ban: 3K at 30 fps, 1080p at 30 or 60 fps, 720p at 120 fps.                  |
| Not in the file        | Depth, camera pose, IMU data, lens model. We infer all of them.                                                                           |
| Live stream (optional) | Meta's Device Access Toolkit: at most 720×1280 over Bluetooth. Too low quality to rebuild from, so only a stretch "live" moment.          |

**One camera, so no stereo.** The second opening on the front of the glasses is the capture LED, not a second camera. Even with two cameras, the exported video is a single view, so there would be no stereo pair. Depth comes from the wearer's own movement (ViPE triangulates across time, like structure-from-motion) plus a metric depth model for scale.

**What we add when recording:** 1080p at 30 fps with stabilization off, a scripted take, symmetric bright props, the wearer's eye height, and an optional checkerboard. Rules in section 5.

**Output: what the viewer needs** (`memory.json`; meters, +Y up, floor at y = 0)

| Part              | What the pipeline writes                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room visual       | L0: static points as small splats in `world/bg_points.ply` (Spark reads `.ply`). Later: a trained `world/bg.spz`, ≤ 300k splats (merge warns above the 350k Quest budget).                    |
| Room collider     | `world/room_collider.glb`: floor + tables as a 10 cm heightfield, in `background.colliderUrl`.                                                                                                |
| Head path         | Camera keyframes at 10 Hz, plus the field of view.                                                                                                                                            |
| People            | Per-frame colored points ("ghosts"), not grabbable: kind `points-sequence`, one binary per person (`world/ghosts/<id>.bin`).                                                                  |
| Grabbable objects | Visual: kind `primitive` (tinted sphere, box or cylinder), chosen by Claude. Collider: sphere, box or cylinder. A mass. A 10 Hz position track with velocity `v`, handed to physics on pause. |
| Audio             | `source.audioUrl` = `input/audio.m4a`, played in sync with the timeline.                                                                                                                      |

These format additions are already in `manifest.ts` and `manifest.py` (section 2.1).

**Steps**

| Step                         | Tool                                                                                                     | Result                                                                                                                                                                                                                                    | Demo                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **S0** Record                | the glasses                                                                                              | scripted clip + the wearer's eye height                                                                                                                                                                                                   | —                            |
| **S1** Normalize             | ffmpeg                                                                                                   | `input/clip.mp4` (upright, constant 30 fps, long side 1280 px), `input/audio.m4a`, `input/frames.json`. Type `nouns.json` by hand: single words (`person`, `hand`, `ball`, `can`...).                                                     | —                            |
| **S2** Cameras, depth, masks | **NVIDIA ViPE**, `default` preset via `run.py` with our phrases                                          | `vipe/`: per-frame camera path, lens, metric depth for every pixel, and per-frame masks with object IDs (verified in ViPE's source)                                                                                                       | **go/no-go**                 |
| **S3** World frame           | numpy + open3d                                                                                           | Up = mean camera up, refined by a floor plane within 15°. Floor at y = 0. Trust ViPE's scale; check it against the eye height. Writes `world/world.json`, `world/cameras.json`.                                                           | —                            |
| **S4** L0 export             | numpy + trimesh                                                                                          | Static points (drop sky and every instance ID) → `bg_points.ply`; heightfield room collider; ghosts from eroded person masks + depth; head path; merge                                                                                    | **L0:** walk into the memory |
| **S5** Objects               | numpy + Claude                                                                                           | Merge ViPE IDs by phrase + 3D position; smoothed 10 Hz position track + velocity. Claude maps label + crop → shape, size, density, color. Size is clamped to the observed extent; mass = density × volume. Writes `objects/objects.json`. | **L1:** pause, grab, throw   |
| **S6** Background splat      | gsplat (~7k steps, seeded with ViPE's points, with masks, `normalize_world_space` off) + splat-transform | `world/bg.spz` replaces the points                                                                                                                                                                                                        | L1, better looking           |
| **S7** Merge                 | `memreplay merge` (done, tested)                                                                         | `memory.json`                                                                                                                                                                                                                             | —                            |

**If a step fails**

- **S2 (ViPE)**, in order: ① fix the lens with the checkerboard, then rerun ViPE ② MapAnything (Apache weights variant) ③ MegaSaM.
- **S6:** the L0 points stay as the background. Merge uses `bg.spz` only when it exists.
- **S4 ghosts or S5 objects missing:** merge warns and continues without them.

**Upgrades, only if time**

| Upgrade                    | Gives               | When it matters                                         |
| -------------------------- | ------------------- | ------------------------------------------------------- |
| CoTracker3 + RANSAC Kabsch | object rotation     | only for non-symmetric props                            |
| SAM 2.1 + Grounding DINO   | better masks        | if ViPE's masks are poor                                |
| SAM 3D Objects             | nicer object shapes | stretch; its own `sam3d` env and half a day of installs |

**Cut from the initial plan:** SAM 3 / 3.1 (gated weights, clashing env), SAM 3D in the main path (half a day of installs), FoundationPose, full 4D splatting, and VGGT or DA3 as the camera solver.

**Why this is the best initial plan for one person**

1. **Risk first.** Everything depends on the camera path and depth from head-mounted footage. ViPE runs at S2, with a go/no-go about 3 hours in and named fallbacks (checkerboard lens fix then rerun; MapAnything; MegaSaM).
2. **One model, four outputs.** ViPE gives the camera path, lens, metric depth and per-frame masks. That replaces SAM 3, cuts the setup from 5 environments to 2, and takes gated weights off the critical path. One person can install and debug it.
3. **Always a demo.** L0 in a few hours, L1 by morning. Every later step improves something that already works.
4. **Built for the demo's physics.** Grab and throw need colliders, velocity and a room to land in, not detailed meshes. With symmetric props, position-only tracking is physically correct.
5. **Two cheap, high-impact wins:** the scripted recording and synced audio.

**Go/no-go test (about H+3).** Run S1 and ViPE's `default` preset on a test clip. It passes if:

- the floor comes out flat;
- straight lines stay straight (the lens is ultrawide);
- the median camera height is close to the wearer's measured eye height (1.4–1.8 m);
- two frames 3 s apart don't show the background doubled.

If it fails, move down the S2 fallbacks in order.

**Environments.** One H100 80GB, two envs. Setup: `bash pipeline/runpod/setup.sh base world vipe warmup`.

| Env                | Contents                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world`            | Our code (`memreplay`), ffmpeg 6, gsplat, open3d, trimesh, the Claude SDK, splat-transform. SAM 2.1 and CoTracker3 go in here too if needed (`setup.sh extras`). |
| `vipe`             | ViPE, in its own uv venv (the conda env only holds CUDA and uv).                                                                                                 |
| `sam3d` (optional) | SAM 3D Objects, stretch only (`setup.sh sam3d sam3d_weights`; Python 3.11, torch 2.5.1, ≥ 32 GB VRAM).                                                           |

`warmup` pre-downloads ViPE's weights. One of them comes from Google Drive and can be rate-limited, so do it at H+0. The storage bucket is owned by P4. Upload each work dir as-is, because `memory.json` uses URLs relative to it.

**ViPE facts (verified in its source)**

- Any phrases work through `run.py`; the `vipe infer` CLI takes no overrides. Our list replaces ViPE's default list, so always keep `person` and `hand`.
- Masks are saved for every frame, at input resolution.
- IDs carry across the video, but an object that is lost and found again gets a new ID. S5 merges them by phrase + 3D position.
- Depth covers every pixel, including people (good for ghosts). For the background, we drop sky and instances ourselves.
- Feed it an mp4 (real fps), not an image folder.
- The `wide_angle` and `pose_only_long` presets write no depth.
- `run.py` needs `streams.frame_end=-1` and `pipeline.output.save_artifacts=true`.
- ViPE's track-anything code is AGPL-3.0.

**Quality ladder.** Every level is a working demo.

- **L0 (a few hours in):** point background, room collider, people ghosts and the head path on a scrubber, with audio.
- **L1 (the target, by morning):** plus grabbable objects (Claude's shape, a collider, mass, a position track with velocity) and physics while paused. The trained background splat (S6) makes it look better.
- **L2 (if time):** the upgrades above: object rotation, better masks, nicer object shapes.

**Licenses** (fine for a hackathon demo; note them for later): ViPE is Apache 2.0, except the UniK3D backend (BY-NC-SA, don't use it) and its track-anything code (AGPL-3.0). gsplat and SAM 2.1 are Apache 2.0. Optional: CoTracker3 is CC-BY-NC, and SAM 3D is under the SAM License. MapAnything: use the Apache weights variant.

### 2.3 Viewer (`apps/web`)

> **Status:** merged. Nikko's engine (`loader`, `physics`, `timeline`, `tracks`, `viewer`, `input-xr`, `input-desktop`) is the viewer; Jerry's client is `net/index.ts`; `net/adapter.ts` connects them; `session.ts` is the room panel and `phone-joystick.ts` the phone joystick. File-by-file layout: [viewer.md](../viewer.md). The module list below is the original design.
> Modules:

- `loader`: manifest, Spark `SplatMesh`es, colliders.
- `clock`: the shared playhead.
- `tracks`: interpolates keyframes.
- `physics`: Rapier world plus the branch recorder.
- `input-xr`: controllers and hands. Squeeze ray-grabs; release throws with hand velocity.
- `input-touch`: orbit, joystick, tap-to-grab, flick to throw.
- `net`: SpacetimeDB connection, avatars, ownership.
- `ui`: scrubber, play/pause, branch tree, room code.

**Quest settings:**

- ≤500k splats total (≤300k background; objects are simple shapes and people are points, up to 15k per ghost per frame); 1M is the hard ceiling.
- `.spz` files; `SparkRenderer` with `preUpdate:false` and `maxStdDev = √5`.
- `antialias:false`, pixel ratio 1, foveation on.

**Phone:** no immersive mode needed. Use orbit plus a joystick; optional gyro look needs `DeviceOrientationEvent.requestPermission()` from a tap on iOS.

**Getting builds onto the Quest:**

- `LOCAL_HTTP=1 npm run dev` and `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` (localhost is a secure context).
- Phones and judges: `npm run tunnel` (cloudflared gives an HTTPS URL; add the host to Vite `server.allowedHosts`).

### 2.4 Multiplayer and timelines (`server/spacetime`)

> **Status:** merged. The module is Jerry's (`server/spacetime/src/index.ts`); the table below lists its fields. Rules (who may set status, chunk validation, the simulation lock, catching) are in [multiplayer.md](../multiplayer.md). The upload page and presigned upload are in `server/upload/` and `apps/web/src/upload.ts`. `scripts/pipeline-status.py` reports pipeline progress, but no worker calls it yet.
> **Tables**

| Table                                            | Fields (short)                                                                                                                                | Written by                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `memory`                                         | id, requestId, owner, pipelineIdentity, title, sourceUrl, manifestUrl, status (uploaded/processing/ready/failed), progress, error, durationUs | upload service (createMemory), pipeline worker (setMemoryStatus) |
| `room`                                           | id, memoryId, joinCode, host                                                                                                                  | createRoom                                                       |
| `player`                                         | identity, roomId, name, device (quest/phone/desktop), color, head pose, hand positions, online                                                | setPose at 10–15 Hz                                              |
| `timeline`                                       | roomId, branchId, paused, speed, anchorMediaUs, anchorServerTs                                                                                | play / pause / seek only                                         |
| `clock_sample`                                   | identity, clientSentUs, serverTs                                                                                                              | sampleClock (clock calibration)                                  |
| `branch`                                         | id, roomId, memoryId, parentId, forkMediaUs, name, creator                                                                                    | grab (auto fork) / forkBranch                                    |
| `object_state`                                   | key `"<branch>:<object>"`, branchId, objectId, heldBy?, simOwner?, mode (held/physics/rest), pose, velocity, fromMediaUs, updatedAt           | grab / moveObject / release                                      |
| `branchKeyframes` (wire name `branch_keyframes`) | key, branchId, objectId, startMediaUs, endMediaUs, `keyframesJson` chunk of ≤120 `[{t,p,q}]` with t in absolute media seconds, author         | simulation owner, before `release(rest: true)`                   |

**The shared clock costs nothing per frame.** Each client computes `t = anchorMediaUs + (now − anchorServerTs) × speed`, and the server only writes on play, pause or seek.

**Pause → physics → alternate timeline**

1. **Pause:** everyone freezes at the same `t`. Each grabbable object becomes a Rapier body at its track pose, **with its track velocity**, so a ball caught mid-air keeps its momentum when released.
2. **Grab:** the `grab(objectId)` reducer succeeds only if nobody else holds or simulates the object. The holder streams `moveObject` at 15 Hz; others interpolate. On release, the holder keeps simulating until the body sleeps, saves the flight as keyframe chunks, then writes a rest pose. Catching an object someone else threw is rejected.
3. **Editing while paused** makes a take. Grabbing on the original recording forks "First edit" at `t0`; re-grabbing an object that already rests on a take forks "Edit <id>", so recorded takes never change. Grabbing another object on a take edits that take. `forkBranch` makes an empty take by hand.
4. **Play on a branch:** objects you touched run physics from their overridden state, and everything else follows its recorded track. The owner records the touched objects' trajectories into `branchKeyframes`, so the branch **replays identically for everyone, including people who join later.**
5. **Switching branches** in the timeline tree is a `setBranch` reducer.
6. **Claude "what if":** a typed prompt becomes `{objectId, impulse, t}` on a new branch.

**Hosting**

- Develop on local `spacetime start`.
- Demo on Maincloud **Pro ($25)** or on a laptop server behind our own travel router.
- The free tier lasts **about 2 hours** at pose rates.

---

## 3. Team and ownership

| Person                       | Lane                                                                                                                                              | Owns                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Vision (one person)**      | GPU pod, recording the clip, the whole vision pipeline: normalize, ViPE, world frame, L0 export, objects + Claude shapes, background splat, merge | `pipeline/` steps S0–S7 and `pipeline/runpod/`; envs `world` and `vipe`         |
| **P3 · XR client**           | Quest rendering, grab and physics, timeline UX                                                                                                    | `apps/web` loader, physics, input-xr, ui                                        |
| **P4 · Multiplayer & phone** | SpacetimeDB module, net sync, phone controls, upload page, storage bucket, demo and Devpost                                                       | `server/spacetime`, `server/upload`, `apps/web` net, session and phone joystick |

**How we work**

- **Contract first.** Changes to `memory.json` go in one PR that touches both the TypeScript and Python files, and get announced in chat.
- **Branches:** `pipe/*`, `web/*`, `stdb/*`, `demo/*`. Small PRs. `main` always runs.
- **No assets in git.** Put them in storage and reference them by URL.
- **Checkpoints** are go/no-go meetings: 10 minutes, standing, with a demo on the real device.

---

## 4. Timeline (assumes the deadline is Sun 4:30 PM; verify)

Vision's steps count in hours from starting the pod (**H+0**, after midnight on Sat). They slide; the clock anchors (Sat 9 AM shoot, 11:30 AM merge gate, 12 PM freeze) stay fixed.

| When                  | Goal                                | Details                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fri 7:30–8:30 PM**  | Kickoff                             | Everyone reads this plan. Accounts: Runpod (ask for credits), `spacetime login`, Claude API key, GitHub repo, R2 bucket. **Shoot a test clip** (rules in section 5).                                                                                                                |
| **Fri 8:30–11:30 PM** | Spikes in parallel                  | **P3:** scaffold on Quest over adb; load a `.spz` at 72 fps (ours arrives at Checkpoint 1, as `.ply` points first); 90-min IWSDK + Spark spike. **P4:** module published locally; two browsers see each other's heads; shared play/pause.                                           |
| **H+0 to H+1**        | Pod                                 | **Vision:** start the pod; `bash pipeline/runpod/setup.sh base world vipe warmup`.                                                                                                                                                                                                  |
| **H+1 to H+3**        | ViPE go/no-go                       | **Vision:** record a test clip (section 5), S1, ViPE go/no-go (section 2.2). **P3:** Rapier grab and throw while paused. **P4:** viewer wired to the shared clock and avatars.                                                                                                      |
| **H+3 to H+6**        | L0                                  | **Vision:** S3 + S4 → L0 `memory.json`. **P3:** viewer to-dos below: `.ply` background, `points-sequence` ghosts, room collider, audio.                                                                                                                                             |
| **H+6**               | ✅ **Checkpoint 1**                 | **L0 `memory.json` in the Quest:** our own test clip as a point background with a room collider, ghosts, the head path and audio. Gates: if ViPE fails, **move down its fallbacks** (checkerboard lens fix + rerun, MapAnything, MegaSaM); if IWSDK fails, **stay on plain three**. |
| **H+6 to H+9**        | L1 objects                          | **Vision:** S5 objects → L1 (pause, grab, throw). **P3:** `primitive` objects, cylinder colliders, velocity on pause.                                                                                                                                                               |
| **Overnight**         | S6, sleep in shifts                 | **Vision:** S6 background splat on the test clip. Sleep in shifts.                                                                                                                                                                                                                  |
| **Sat 9–10 AM**       | Shoot the demo clip                 | **Everyone:** 3 takes (rules in section 5). **Vision:** rerun S1–S7 on the best take.                                                                                                                                                                                               |
| **Sat 10 AM–12 PM**   | L1                                  | **Vision:** finish S1–S7 on the demo clip. **11:30 AM: merge gate;** any failing step switches to its fallback. **P3/P4:** fork, replay and branch keyframes; phone avatars and controls.                                                                                           |
| **Sat 12 PM**         | ✅ **Checkpoint 2**                 | **L1 frozen; lock the demo clip.** One object replays, gets grabbed in VR, and forks a branch while a second person watches on a phone.                                                                                                                                             |
| **Sat 12–6 PM**       | Features                            | Branch tree UI; upload page and job status; Claude "what if" and captions; vision upgrades if time (section 2.2).                                                                                                                                                                   |
| **Sat 6 PM**          | ✅ **Checkpoint 3: feature freeze** | After this, only polish, performance and stretch work, each behind a flag.                                                                                                                                                                                                          |
| **Sat 6 PM–Sun 2 AM** | Polish                              | Quest frame rate, visuals for timeline branches, sounds, onboarding. Stretch: live glasses stream via Meta DAT; passthrough AR mode.                                                                                                                                                |
| **Sun 2–9 AM**        | Sleep shifts, bug bash              |                                                                                                                                                                                                                                                                                     |
| **Sun 9 AM–1 PM**     | Ship                                | Record the demo video (Quest cast plus phone screen recording), Devpost, per-track write-ups.                                                                                                                                                                                       |
| **Sun 1–4:30 PM**     | Buffer                              | Submit by 4:30 PM. Rehearse the 3-minute pitch three times.                                                                                                                                                                                                                         |

**Viewer to-dos this creates (P3)**

- Render `points-sequence` ghosts: three.js `Points` with a `Float16BufferAttribute` (binary layout in `handoff.py`).
- Render `primitive` objects: tinted sphere, box or cylinder.
- Wire Rapier: sphere, box and cylinder colliders; the room collider `.glb` as a trimesh collider; each object's velocity `v` on pause.
- Play `source.audioUrl` in sync with the timeline; resync when it drifts past 100 ms.
- Load the `.ply` point background first (L0), then the `.spz`.

---

## 5. Capture rules (test clip tonight, demo clip Sat 9 AM)

- Meta AI app → Devices → Settings → Media: **1080p at 30 fps, stabilization OFF.** Stabilization warps each frame differently, which breaks the camera solve. 1080p is the mode where the stabilization toggle is documented; whether 3K is unstabilized is unverified. The export is HEVC `.mov` on iPhone and `.mp4` on Android; S1 converts either.
- **One scripted take, under 30 s, 3 takes:**
  1. Look at the floor for 3 s.
  2. Walk 2–3 m sideways while slowly panning across the room. Turning your head in place gives ViPE no parallax to triangulate from.
  3. Then the action.
- **Props:** 2–3 symmetric, brightly colored things (a ball, a can, a bottle). **Someone other than the wearer** moves or throws them. Symmetric props need no rotation track, so position-only tracking is correct.
- **One person in frame,** and slow head motion.
- **Measure the wearer's eye height.** S3 checks ViPE's scale against it, so the wearer should stay standing.
- **Optional: film a checkerboard on a laptop screen for 15 s.** It is the lens-fix fallback for S2.
- Light should be even; avoid windows, mirrors and glass. Textured surroundings help; blank white walls hurt the camera solve.
- No room sweep. Nothing in the pipeline reads one.

---

## 6. Risks

| Risk                                                                                 | Mitigation                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ViPE fails on glasses footage (ultrawide lens, rolling shutter)                      | Capture rules; go/no-go about 3 hours in; S2 fallbacks in order: checkerboard lens fix + rerun, MapAnything, MegaSaM                                             |
| ViPE's `default` preset assumes an ordinary lens; the glasses are ultrawide          | Check that straight lines stay straight; if not, the checkerboard lens fix, then rerun                                                                           |
| Unverified ViPE details: multi-word prompts, H100 runtime, z-depth vs ray distance   | Single-word prompts; time the test clip; check that the floor comes out flat (ray distance read as z-depth bends it)                                             |
| A ViPE weight comes from Google Drive (rate limits)                                  | `setup.sh warmup` downloads it at H+0                                                                                                                            |
| ViPE's masks are poor, or an object gets a new ID after it is lost                   | S5 merges IDs by phrase + 3D position; SAM 2.1 + Grounding DINO as an upgrade (`setup.sh extras`)                                                                |
| A prop isn't symmetric, so rotation matters                                          | Choose symmetric props; CoTracker3 + RANSAC Kabsch only if time                                                                                                  |
| ViPE's metric scale is off, or the wearer sits down                                  | S3 compares the median camera height with the measured eye height and rescales only if needed; the wearer stays standing                                         |
| S6 gsplat fails or runs long                                                         | The L0 points stay as the background; merge uses `bg.spz` only when it exists                                                                                    |
| Nothing has run on a real pod or real glasses footage yet                            | Setup and a test clip first (H+0 to H+3); the go/no-go decides before anything else is built                                                                     |
| Spark in WebXR on Quest 3S (unverified), or IWSDK and Spark conflicting over `three` | Test tonight; plain three is the default; ≤500k splats                                                                                                           |
| Scale or axis mismatch between splats and colliders                                  | One world frame in the manifest; up direction and floor plane in S3; `memreplay merge` checks for objects below the floor; a debug view with collider wireframes |
| CUDA environment problems                                                            | Two envs only (`world`, `vipe`); setup steps leave markers, so a rerun skips finished steps; every step keeps its files in the work dir                          |
| Venue Wi-Fi                                                                          | Own travel router or hotspot; local SpacetimeDB; assets preloaded                                                                                                |
| Physics desync                                                                       | Single-owner simulation; recorded branch keyframes                                                                                                               |
| Unknown tracks or deadline                                                           | Read the CH13 Slack tonight and update section 1                                                                                                                 |

---

## 7. Prior art and how we differ

- **Meta Horizon Hyperscape:** headset room scans become splats, but **static only**, and sharing was reportedly discontinued in Mar 2026.
- **Others:** EgoLifter, Shape of Motion, Polycam, Luma.
- **What we add:**
  - **Passive capture:** footage you already shot on glasses.
  - **Moving objects over time.**
  - **Physics and branching alternate timelines.**
  - **Cross-device multiplayer:** Quest and phones in one room.
