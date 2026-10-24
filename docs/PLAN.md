# Memory Replay: CalHacks 13 plan

Record a moment on Ray-Ban Meta glasses, rebuild it as a **4D scene** (3D + time), and walk back into it with friends on a **Quest 3S or a phone**. Pause time, grab things, throw them, and branch off an **alternate timeline**.

*Written Fri Oct 23, 7 PM. Vision pipeline revised at 10:55 PM (one clip, ViPE / SAM 3 / SAM 3D / CoTracker3). Items marked (verify) or unverified still need checking.*

---

## 0. Decisions

| Question | Decision | Why |
|---|---|---|
| Unity or web? | **One WebXR web app** (three.js + Spark splats), served over HTTPS to the Quest 3S browser, phones and laptops | One URL gives you sharing, phones and multiplayer together. Unity Gaussian splats on Quest are only "reported to work" (aras-p's plugin is no longer developed), and Unity would mean a second phone build. |
| XR framework | Default: **plain three.js + Spark 2.4 + Rapier**, already scaffolded in `apps/web`. Spike: **Meta IWSDK** (Havok physics, grab, locomotion built in), timeboxed to 90 min tonight | IWSDK saves hours of grab and hand code. The risk is that it pins `three` to `super-three@0.185`, and Spark has to share that same instance. Switch only if the spike renders a `.spz` on Quest at 72 fps. |
| Full 4D Gaussian splatting? | **No, use a layered scene.** Static background splat, plus each moving object as its own splat with a collider and a pose track | Per-scene 4DGS (Shape of Motion, MoSca) takes hours to train, is fragile on head-mounted video, and **gives no colliders**, so no physics. Layering gets you motion and physics together. |
| Camera solve | **NVIDIA ViPE on the single action clip. No room sweep.** | ViPE masks moving things itself, solves the lens (including a wide-angle model) and gives near-metric depth on long clips. DA3 and VGGT assume a static scene, and VGGT has no metric scale. A separate sweep would mean registering two clips, and it breaks the "footage you already shot" pitch. Go/no-go test tonight. |
| Semantic segmentation | **SAM 3**, text-prompted video segmentation with mostly stable IDs. **Claude picks the prompts** from keyframes. | SAM 3 needs nouns ("box", "ball"), and Claude vision supplies them, along with size range, density and grabbable flags. The same nouns tell ViPE what to mask. |
| Multiplayer backend | **SpacetimeDB 2.13 with a TypeScript module.** It's a CalHacks 13 sponsor. | Rooms, avatars, the shared clock, grab ownership and timeline branches all map onto tables and reducers, and the browser SDK is `spacetimedb` on npm. |
| Physics authority | **The player holding an object simulates it.** The server only arbitrates ownership. | No server physics tick and no lockstep. Everyone else interpolates the owner's transforms. |
| GPU | **One Runpod H100 80GB pod** with a persistent volume, owned by P1. Each person has their own environments: P1 `world`, P2 `seg` and `obj`, plus a shared `core` (section 2.2). Optional second, smaller pod for P2 on the same network volume (attaching one volume to two pods is unverified). (Runpod is a sponsor, so ask for credits.) | The CUDA stacks (ViPE, SAM 3, SAM 3D, gsplat) need a box you can SSH into to debug. Separate envs keep their torch versions from colliding. |
| Repo | **Monorepo with npm workspaces** (this repo) | The `memory.json` contract, viewer, server module and pipeline change together in one PR. |

---

## 1. Tracks, sponsors and credits

The Slack connected to Claude is **RoboTouchLab (UIUC), not CalHacks**, so none of this came from Slack. Sources are calhacks.io and last year's live site.

- **Confirmed CH13 sponsors** (calhacks.io): **SpacetimeDB, Meta, Anthropic, Runpod**, Supercell, Convex, Fetch.ai, Bright Data, Microsoft, Figma, Cartesia, Apify, Elastic, YC, a16z, and more. $100k in prizes. Event is Oct 23–25 at the Palace of Fine Arts.
- **The CH13 prize list isn't published yet.** `live.calhacks.io/prizes` still shows CH12, and the CH13 Devpost returned 403.
- **The deadline is unknown.** CH12 had initial submission Sun 4:30 PM, final at 5:30 PM, and judging 5:30–7:30 PM. **This plan assumes Sun 4:30 PM** (verify).
- **Credits:** none published yet. Ask at the **Runpod** (GPU), **Anthropic** (API credits; CH12's Best Use of Claude prize was $5k in credits) and **SpacetimeDB** (Maincloud Pro) booths.

**Tracks to target** (re-rank once the CH13 list is posted):
1. **SpacetimeDB.** The whole shared world runs on it: rooms, a mixed Quest and phone presence, the shared clock, grab ownership, and branching timelines stored as data.
2. **Meta.** Capture on Ray-Ban Meta, relive on Quest 3S, built on Meta's SAM 3 and SAM 3D, and Meta's Immersive Web SDK if the spike passes.
3. **Best Use of Claude**, if it repeats. Claude discovers objects for SAM 3, estimates physical properties, titles and captions memories, and turns "what if the ball went left?" into a physics edit on a new branch.
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
 │ memory, room, player,   │                    │ S0 frames   P1  ffmpeg, sharpest/100ms   │
 │ timeline, branch,       │                    │ S1 nouns    P2  Claude: what moves       │
 │ object_state, grab,     │                    │ S2 masks    P2  SAM 3 video masks        │
 │ branch_keyframe         │                    │ S3 cameras  P1  ViPE: path, lens, depth  │
 └──────────┬──────────────┘                    │ S4 world    P1  floor, +Y up, scale      │
            │ websocket subscriptions           │ S5 background P1 gsplat (masked) → spz   │
            ▼                                   │ S6 ghosts   P1  people as splats         │
 ┌─────────────────────────────────────────┐    │ S7 objects  P2  SAM 3D Objects + hull    │
 │ Viewer (apps/web): one URL              │    │ S8 tracks   P2  CoTracker3 + Kabsch      │
 │  Quest 3S browser: immersive-vr, hands  │    │ S9 merge    P1  memreplay merge          │
 │  Phone: touch orbit + tap-grab          │    └──────────────────────────────────────────┘
 │  three.js · Spark · Rapier · STDB SDK   │──── loads memory.json + assets from storage
 └─────────────────────────────────────────┘
```

### 2.1 The contract: `memory.json`
Defined in [`packages/shared/src/manifest.ts`](../packages/shared/src/manifest.ts), with a Python mirror in [`pipeline/memreplay/manifest.py`](../pipeline/memreplay/manifest.py). It holds:
- **World frame:** +Y up, meters, and the floor height. The pipeline gravity-aligns and scales the scene (S4), so **the viewer never sees the camera solver's raw frame.**
- **Background:** one splat (`.spz`), plus an optional coarse collider `.glb`.
- **Camera track:** the wearer's head path, for "see it through my eyes" mode.
- **Objects:** visual (splat or mesh), collider (box, sphere, capsule or convex hull), mass, grabbable, visible time range, and a pose track `[{t, p, q}]` sampled at 10–30 Hz.

The viewer develops against `apps/web/public/mock/memory.json` and never waits on the pipeline.

### 2.2 Reconstruction pipeline (`pipeline/`, Python, Runpod GPU)

**One clip per memory. There is no separate room sweep.** Each memory gets one work dir, and every stage reads and writes files in it (layout and formats in [`pipeline/memreplay/handoff.py`](../pipeline/memreplay/handoff.py)). So any stage reruns alone: `memreplay stage <name> --work work/<id>`.

The pipeline is split by **what each person delivers**. P1 and P2 both start on real work tonight and only meet through a few frozen files.

- **P1 · World** owns the camera path, the world frame, the background and the people ghosts: S0, S3, S4, S5, S6 and S9. P1's output on its own is the L0 demo.
- **P2 · Things** owns everything you can grab: S1, S2, S7 and S8. P2's output turns L0 into L1.

| Stage | Tool | Why this one | Output | Fallback |
|---|---|---|---|---|
| **S0** Frames (P1) | ffmpeg, keeping the clip's real timestamps. Keep the sharpest frame (Laplacian variance) in each 100 ms. Write a full-size copy and a small (~640 px) copy. | Real timestamps and fewer blurry frames than plain `fps=10`. | `frames/full/`, `frames/small/`, `frames.json` | ffmpeg `fps=10` |
| **S1** Nouns (P2) | **Claude** on 8 keyframes → ≤6 rigid, textured things that move, each with a size range, density and grabbable flag. Always adds `person` and `hand`. | A fixed vocabulary misses the props in this scene. The same list is ViPE's masking phrases. | `nouns.json` | fixed list |
| **S2** Masks (P2) | **SAM 3** (`facebookresearch/sam3`) in video mode, one run per noun. An object that leaves and re-enters the frame can get a new ID, so stitch tracklets (same 3D centroid within 0.3 m + similar look) before writing `tracks.json`. The wearer's own hands are tagged `ego-hand` (they touch the frame edge and sit closer than 0.8 m; the depth check runs after S3). Frames where a hand covers an object get a `held` flag. Claude reviews a crop gallery. Weights are gated on Hugging Face. | A text prompt finds every instance, and the detector keeps re-finding objects through the clip. Grounded-SAM-2's own README says its new-object IDs aren't very stable, and DEVA is obsolete. Egocentric video is still SAM 3's weakest domain, so expect some misses. | `masks/tracks.json` (COCO RLE), `masks/dyn/<idx>.png` | SAM 2.1 + Grounding DINO via HF `transformers`, plus 1-click fixes |
| **S3** Cameras + depth (P1) | **NVIDIA ViPE** (`nv-tlabs/vipe`; `pip install nvidia-vipe` or its cu128 env). Phrases = defaults + `hand` + S1 nouns. Wide-angle (Mei) camera model (the override syntax for both is unverified). `pose_only_long` for long clips. Set `save_artifacts=true`, or no depth is written (from ViPE's default config; unverified). Don't use the UniK3D backend (BY-NC-SA). | The only released tool we found that masks moving things itself, solves the lens and gives near-metric depth on long clips. Its paper reports lower pose and focal error than MegaSaM at 3–5× the speed. DA3 and VGGT assume a static scene, and VGGT has no metric scale. | `world/cameras.json`, `world/depth.npz` | In order: ① undistort with the checkerboard, then ViPE pinhole ② MapAnything (`facebook/map-anything-apache` weights) on masked keyframes ③ MegaSaM, if a GPU is free |
| **S4** World frame (P1) | open3d RANSAC floor fit on masked depth. +Y up. Scale = measured eye height ÷ median camera height. Cameras and depth are rewritten into the world frame (`in_world_frame=true`). | ViPE's depth is only near-metric. One physical measurement fixes the scale and sets the floor. | `world/world.json` | click 3 floor points |
| **S5** Background (P1) | **gsplat** MCMC with a per-frame masked loss (~10-line patch), a trimmed loss on the top 5% of residuals, a 300k splat cap, appearance and pose refinement, ~15k steps (~12–15 min, estimate). Then crop, filter floaters and convert to `.spz`. **L0 version first:** fused masked depth points as splats (~2 min). | The cap applies during training, which is sharper than decimating afterwards. Explicit masks beat learned distractor handling (WildGaussians), and the trimmed loss catches shadows the masks miss. DA3's Gaussian head is non-commercial and doesn't remove movers; AnySplat is too low-resolution for VR. | `world/bg.spz` | Brush binary on the same data |
| **S6** Ghosts (P1) | Depth inside eroded person masks, a depth-edge filter, 20–30k colored splats per frame at 10 Hz. | Simple: it reuses S2's masks and S3's depth, with no extra model. The depth-edge filter removes flying pixels, so ghosts look like people instead of noise. 4DGT only reads Aria `.vrs` files. | `world/ghosts.json` + `world/ghosts/<id>/<n>.spz` (non-grabbable splat-sequence objects) | 10k points, every 2nd frame |
| **S7** Object asset (P2) | **SAM 3D Objects** on the best keyframe (mask area × sharpness × not covered by a hand) → splat, ≤30k. Scale fix: render the asset's depth, scale = median(observed) ÷ median(rendered), then ICP on rotation and translation only (scale locked), clamped to Claude's size range. trimesh convex hull, ≤64 vertices. Mass = density × volume. | It fills in hidden sides and also predicts a pose. TRELLIS.2 and Hunyuan3D give an unscaled asset with no pose. Letting scale float in ICP on one-sided depth collapses it, so scale comes from the depth ratio. | `objects/<id>/gs.spz`, `objects/<id>/hull.glb` | TRELLIS.2 + our own fit; or fused points + box collider |
| **S8** 6DoF tracks (P2) | **CoTracker3** offline on points inside the mask minus hands → lift to world with P1's depth and cameras → per-frame RANSAC Kabsch (scale fixed, 2 cm inliers, at least 6) → Savitzky-Golay (window 7, order 2) → 10 Hz keyframes. `held` frames are interpolated. Until P1's world cameras land, work in camera coordinates. | Real point matches keep rotation stable; ICP on one-sided monocular depth slides, jitters or flips. FoundationPose would be better, but it needs a source build, fails when a hand wraps the object, and its license is probably non-commercial (unverified). Textureless props fail, so choose textured ones. | `objects/objects.json` | translation only (median of masked world points), then static |
| **S9** Merge (P1; anyone can run it) | `memreplay merge <work>`, implemented and tested. Checks that cameras are in the world frame, the background splat budget, and objects below the floor. | — | `memory.json` | — |

**Why this split.** ViPE masks moving things itself, so P1's cameras never wait for P2; P2's nouns only make them better. P1 needs P2's masks only for S5 and S6, and can use ViPE's own masks for L0 (whether ViPE writes them to disk is unverified; if it doesn't, P1 uses P2's masks v0 from 1 AM). P2 works in camera coordinates until P1's world cameras land. The cut follows env and file boundaries, so nobody imports the other person's env.

**Handoffs.** Formats are frozen in [`pipeline/memreplay/handoff.py`](../pipeline/memreplay/handoff.py). Change them only when P1 and P2 both agree.

| When | P1 · World | P2 · Things |
|---|---|---|
| Fri 11:15 PM | — | Request Hugging Face access to `sam3` and `sam-3d-objects`. Formats frozen in `handoff.py`. |
| Fri 11:30 PM | `frames/` + `frames.json` for the test clip → P2 | `nouns.json` v0 → P1 |
| Sat 1:00 AM | ViPE go/no-go; `cameras.json` + `depth.npz` + `world.json` v0 → P2 | masks v0 → P1 (SAM 2.1 clicks if access is still pending) |
| **Sat 2:30 AM** | **Checkpoint 1:** L0 `memory.json` → P3 (fused-point background + ghosts + head path) | translation-only tracks + box colliders |
| Overnight | gsplat on the test clip | SAM 3D batch + Kabsch tracker |
| Sat 9:00 AM | **Everyone:** shoot the demo clip (3 takes) | |
| Sat 10:00 AM | final cameras + world → P2 | final masks → P1 |
| Sat 11:00 AM | `bg.spz` + ghosts | object assets + tracks |
| **Sat 11:30 AM** | **Merge to `memory.json` v1.** Gate: any failing stage switches to its fallback. | |
| **Sat 12:00 PM** | **L1 frozen (Checkpoint 2)** | |

**Go/no-go test tonight (by Sat 1:00 AM).** P1 runs ViPE twice on a test clip, once with the default config and once with the wide-angle camera model. It passes if:
- the floor comes out flat;
- eye height before rescaling is 1.4–1.8 m;
- two frames 3 s apart don't show the background doubled.

At the same time, P2 runs SAM 3 (or SAM 2.1) with the prompt "box" on the same clip. If ViPE fails, P1 moves down the S3 fallbacks in order.

**GPU and environments.** One H100 80GB is enough if each person has their own envs. P1 owns the pod.

| Env | Owner | Contents |
|---|---|---|
| `world` | P1 | ViPE, gsplat, open3d. P1 also owns the Brush binary. |
| `seg` | P2 | SAM 3, SAM 2.1, CoTracker3 (Python 3.12, torch ≥ 2.7) |
| `obj` | P2 | SAM 3D Objects |
| `core` | shared | memreplay CLI, `anthropic` |

Optional: a second, smaller pod for P2 on the same network volume (attaching one volume to two pods is unverified). The storage bucket is owned by P4. Upload each work dir as-is, because `memory.json` uses URLs relative to it.

**Quality ladder.** Every level is a working demo.
- **L0 (P1 alone):** background splat, people ghosts and the head path on a scrubber.
- **L1 (P2's work, the target):** plus grabbable objects with splat, collider and 6DoF track, and physics while paused.
- **L2 (stretch, unverified):** plus people as meshes (SAM 3D Body) with kinematic capsule colliders, taken by whoever is ahead.
- **L3 (stretch):** full 4D.

**Licenses** (fine for a hackathon demo; note them for later): ViPE is Apache (skip the UniK3D backend). MapAnything: use the Apache weights variant. SAM 3 and SAM 3D are under the SAM License. CoTracker3 is CC-BY-NC. TRELLIS.2 is MIT (verify).

### 2.3 Viewer (`apps/web`)
Modules:
- `loader`: manifest, Spark `SplatMesh`es, colliders.
- `clock`: the shared playhead.
- `tracks`: interpolates keyframes.
- `physics`: Rapier world plus the branch recorder.
- `input-xr`: controllers and hands. Squeeze ray-grabs; release throws with hand velocity.
- `input-touch`: orbit, joystick, tap-to-grab, flick to throw.
- `net`: SpacetimeDB connection, avatars, ownership.
- `ui`: scrubber, play/pause, branch tree, room code.

**Quest settings:**
- ≤500k splats total (~350k background + ~150k objects); 1M is the hard ceiling.
- `.spz` files; `SparkRenderer` with `preUpdate:false` and `maxStdDev = √5`.
- `antialias:false`, pixel ratio 1, foveation on.

**Phone:** no immersive mode needed. Use orbit plus a joystick; optional gyro look needs `DeviceOrientationEvent.requestPermission()` from a tap on iOS.

**Getting builds onto the Quest:**
- `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` (localhost is a secure context).
- Phones and judges: `npm run tunnel` (cloudflared gives an HTTPS URL; add the host to Vite `server.allowedHosts`).

### 2.4 Multiplayer and timelines (`server/spacetime`)
**Tables**
| Table | Fields (short) | Written by |
|---|---|---|
| `memory` | id, owner, title, manifestUrl, status (uploaded/processing/ready/failed), progress | upload page, pipeline |
| `room` | id, memoryId, joinCode, host | createRoom |
| `player` | identity, roomId, name, device (quest/phone/desktop), color, head pose, hand poses, online | setPose at 10–15 Hz |
| `timeline` | roomId, branchId, paused, speed, anchorMediaUs, anchorServerTs | play / pause / seek only |
| `branch` | id, memoryId, parentId, forkMediaUs, name, creator | forkBranch |
| `object_state` | (branchId, objectId), heldBy?, mode (held/thrown/rest), pose, velocity, fromMediaUs | grab / move / release |
| `branch_keyframe` | branchId, objectId, chunk of recorded `[t,p,q]` | owner, after its sim ends |

**The shared clock costs nothing per frame.** Each client computes `t = anchorMediaUs + (now − anchorServerTs) × speed`, and the server only writes on play, pause or seek.

**Pause → physics → alternate timeline**
1. **Pause:** everyone freezes at the same `t`. Each grabbable object becomes a Rapier body at its track pose, **with its track velocity**, so a ball caught mid-air keeps its momentum when released.
2. **Grab:** the `grab(objectId)` reducer succeeds only if nobody holds the object. The holder simulates it and streams `moveObject` at 15 Hz; others interpolate. On release, the holder keeps simulating until the body sleeps, then writes a rest pose.
3. **Changing anything while paused** forks a branch: `forkBranch(parent, t0)`. The branch tree shows a new fork marker at `t0`.
4. **Play on a branch:** objects you touched run physics from their overridden state, and everything else follows its recorded track. The owner records the touched objects' trajectories into `branch_keyframe`, so the branch **replays identically for everyone, including people who join later.**
5. **Switching branches** in the timeline tree is a `setBranch` reducer.
6. **Claude "what if":** a typed prompt becomes `{objectId, impulse, t}` on a new branch.

**Hosting**
- Develop on local `spacetime start`.
- Demo on Maincloud **Pro ($25)** or on a laptop server behind our own travel router.
- The free tier lasts **about 2 hours** at pose rates.

---

## 3. Team and ownership (4 people)

| Person | Lane | Owns |
|---|---|---|
| **P1 · World** | GPU pod, frames, ViPE camera path + depth, world frame, background splat, people ghosts, merge | `pipeline/` stages S0, S3, S4, S5, S6, S9; env `world` and the Brush binary |
| **P2 · Things** | Claude nouns, SAM 3 masks, SAM 3D object assets + colliders, CoTracker3 6DoF tracks | `pipeline/` stages S1, S2, S7, S8; envs `seg` and `obj` |
| **P3 · XR client** | Quest rendering, grab and physics, timeline UX | `apps/web` loader, physics, input-xr, ui |
| **P4 · Multiplayer & phone** | SpacetimeDB module, net sync, phone controls, upload page, storage bucket, demo and Devpost | `server/spacetime`, `apps/web` net and input-touch |

**How we work**
- **Contract first.** Changes to `memory.json` go in one PR that touches both the TypeScript and Python files, and get announced in chat.
- **Branches:** `pipe/*`, `web/*`, `stdb/*`, `demo/*`. Small PRs. `main` always runs.
- **No assets in git.** Put them in storage and reference them by URL.
- **Checkpoints** are go/no-go meetings: 10 minutes, standing, with a demo on the real device.

---

## 4. Timeline (assumes the deadline is Sun 4:30 PM; verify)

| When | Goal | Details |
|---|---|---|
| **Fri 7:30–8:30 PM** | Kickoff | Everyone reads this plan. Accounts: Runpod (ask for credits), `spacetime login`, Claude API key, GitHub repo, R2 bucket. **Shoot a test clip** (rules in section 5). |
| **Fri 8:30–11:30 PM** | Spikes in parallel | **P1:** pod and `world` env with ViPE; `frames/` + `frames.json` for the test clip to P2 by 11:30. **P2:** request Hugging Face access (`sam3`, `sam-3d-objects`) by 11:15; `seg` env with SAM 2.1 meanwhile; `nouns.json` v0 to P1 by 11:30. **P3:** scaffold on Quest over adb; load a `.spz` at 72 fps (ours arrives with L0 at 2:30 AM); 90-min IWSDK + Spark spike. **P4:** module published locally; two browsers see each other's heads; shared play/pause. |
| **Fri 11:30 PM–Sat 2:30 AM** | ViPE go/no-go, then L0 + physics | **P1:** ViPE go/no-go test (section 2.2); `cameras.json` + `depth.npz` + `world.json` v0 to P2 by 1 AM; then the L0 `memory.json`. **P2:** SAM 3 (or 2.1) "box" test on the same clip; masks v0 to P1 by 1 AM; then translation-only tracks + box colliders. **P3:** Rapier grab and throw while paused. **P4:** viewer wired to the shared clock and avatars. |
| **Sat 2:30 AM** | ✅ **Checkpoint 1** | **L0 `memory.json` to P3:** our own test clip as a fused-point background, ghosts and the head path, visible in the Quest. P2 adds translation-only tracks + box colliders. Gates: if ViPE fails, **move down its fallbacks** (checkerboard + pinhole, MapAnything, MegaSaM); if SAM 3 access is still pending, **stay on SAM 2.1**; if IWSDK fails, **stay on plain three**. |
| **Sat 2:30–9 AM** | Overnight runs, sleep in shifts | Two people sleep at a time. **P1:** gsplat on the test clip. **P2:** SAM 3D batch + Kabsch tracker. |
| **Sat 9–10 AM** | Shoot the demo clip | **Everyone:** 3 takes (rules in section 5). |
| **Sat 10 AM–12 PM** | L1 | **10 AM:** P1 final cameras + world; P2 final masks. **11 AM:** P1 `bg.spz` + ghosts; P2 object assets + tracks. **11:30 AM:** merge to `memory.json` v1; any failing stage switches to its fallback. **P3/P4:** fork, replay and branch keyframes; phone avatars and controls. |
| **Sat 12 PM** | ✅ **Checkpoint 2** | **L1 frozen; lock the demo clip.** One object replays, gets grabbed in VR, and forks a branch while a second person watches on a phone. |
| **Sat 12–6 PM** | Features | Branch tree UI; upload page and job status; Claude "what if" and captions; people (SAM 3D Body, stretch). |
| **Sat 6 PM** | ✅ **Checkpoint 3: feature freeze** | After this, only polish, performance and stretch work, each behind a flag. |
| **Sat 6 PM–Sun 2 AM** | Polish | Quest frame rate, visuals for timeline branches, sounds, onboarding. Stretch: live glasses stream via Meta DAT; passthrough AR mode. |
| **Sun 2–9 AM** | Sleep shifts, bug bash | |
| **Sun 9 AM–1 PM** | Ship | Record the demo video (Quest cast plus phone screen recording), Devpost, per-track write-ups. |
| **Sun 1–4:30 PM** | Buffer | Submit by 4:30 PM. Rehearse the 3-minute pitch three times. |

---

## 5. Capture rules (test clip tonight, demo clip Sat 9 AM)
- Meta AI app → Devices → Settings → Media: **1080p at 30 fps, stabilization OFF.** That is the mode where the stabilization toggle is documented; whether 3K is unstabilized is unverified. Stabilization warps each frame differently, which breaks the camera solve. The export codec is unverified (the Meta AI app may re-encode); ffmpeg decodes it either way.
- **One clip per take, 30–60 s, 3 takes:**
  1. About 10 s of slow look-around.
  2. Walk 2–3 m, so the camera solve gets some baseline.
  3. Then the action.
- **Props:** 1–3 rigid, textured, matte things of 10–50 cm (a printed box, a book, a patterned ball). **Someone other than the wearer** moves or throws them. Avoid shiny, thin, deformable or plain props: the tracker needs texture.
- **Measure the wearer's eye height.** S4 uses it to set the scale, so the wearer should stay standing.
- **Film a checkerboard on a laptop screen for 15 s.** It is the lens fallback for S3.
- Keep head turns slow. Light should be even; avoid windows, mirrors and glass. Textured surroundings help; blank white walls hurt the camera solve.
- An empty-room sweep is **optional insurance only.** Nothing in the pipeline reads it.

---

## 6. Risks
| Risk | Mitigation |
|---|---|
| ViPE fails on glasses footage (the wide-angle flag is barely documented; rolling shutter) | Capture rules; go/no-go test tonight; S3 fallbacks in order: checkerboard undistort + ViPE pinhole, MapAnything, MegaSaM |
| Gated weights (SAM 3; SAM 3D Objects may be gated too, unverified) delay P2 | Request access at 11:15 PM; SAM 2.1 + Grounding DINO meanwhile |
| SAM 3D details unverified (whether it takes our own pointmap; whether its mesh and splat share one frame) | Fix scale afterwards in S7 (depth ratio, then rotation-and-translation ICP, clamped to Claude's size range) |
| Textureless props break the tracker | Choose textured props; translation-only fallback, then static |
| Wearer sits down, so the eye-height scale is wrong | Ask the wearer to stand; fallback: click 3 floor points |
| Spark in WebXR on Quest 3S (unverified), or IWSDK and Spark conflicting over `three` | Test tonight; plain three is the default; ≤500k splats |
| Scale or axis mismatch between splats and colliders | One world frame in the manifest; floor RANSAC and eye-height scale in S4; `memreplay merge` checks the world frame and objects below the floor; a debug view with collider wireframes |
| CUDA environment problems | P1 owns the pod; separate envs per person (`world`, `seg`, `obj`, plus shared `core`); Brush binary as the gsplat fallback; cache every stage |
| Venue Wi-Fi | Own travel router or hotspot; local SpacetimeDB; assets preloaded |
| Physics desync | Single-owner simulation; recorded branch keyframes |
| Unknown tracks or deadline | Read the CH13 Slack tonight and update section 1 |

---

## 7. Prior art and how we differ
- **Meta Horizon Hyperscape:** headset room scans become splats, but **static only**, and sharing was reportedly discontinued in Mar 2026.
- **Others:** EgoLifter, Shape of Motion, Polycam, Luma.
- **What we add:**
  - **Passive capture:** footage you already shot on glasses.
  - **Moving objects over time.**
  - **Physics and branching alternate timelines.**
  - **Cross-device multiplayer:** Quest and phones in one room.
