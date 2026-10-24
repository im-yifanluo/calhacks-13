# Memory Replay: CalHacks 13 plan

Record a moment on Ray-Ban Meta glasses, rebuild it as a **4D scene** (3D + time), and walk back into it with friends on a **Quest 3S or a phone**. Pause time, grab things, throw them, and branch off an **alternate timeline**.

*Written Fri Oct 23, 7 PM. Items marked (verify) still need checking.*

---

## 0. Decisions

| Question | Decision | Why |
|---|---|---|
| Unity or web? | **One WebXR web app** (three.js + Spark splats), served over HTTPS to the Quest 3S browser, phones and laptops | One URL gives you sharing, phones and multiplayer together. Unity Gaussian splats on Quest are only "reported to work" (aras-p's plugin is no longer developed), and Unity would mean a second phone build. |
| XR framework | Default: **plain three.js + Spark 2.4 + Rapier**, already scaffolded in `apps/web`. Spike: **Meta IWSDK** (Havok physics, grab, locomotion built in), timeboxed to 90 min tonight | IWSDK saves hours of grab and hand code. The risk is that it pins `three` to `super-three@0.185`, and Spark has to share that same instance. Switch only if the spike renders a `.spz` on Quest at 72 fps. |
| Full 4D Gaussian splatting? | **No, use a layered scene.** Static background splat, plus each moving object as its own splat with a collider and a pose track | Per-scene 4DGS (Shape of Motion, MoSca) takes hours to train, is fragile on head-mounted video, and **gives no colliders**, so no physics. Layering gets you motion and physics together. |
| Semantic segmentation | **SAM 3**, text-prompted video segmentation with stable IDs. **Claude picks the prompts** from keyframes. | SAM 3 needs nouns ("ball", "dog"), and Claude vision supplies them, along with mass and grabbable flags. |
| Multiplayer backend | **SpacetimeDB 2.13 with a TypeScript module.** It's a CalHacks 13 sponsor. | Rooms, avatars, the shared clock, grab ownership and timeline branches all map onto tables and reducers, and the browser SDK is `spacetimedb` on npm. |
| Physics authority | **The player holding an object simulates it.** The server only arbitrates ownership. | No server physics tick and no lockstep. Everyone else interpolates the owner's transforms. |
| GPU | **One Runpod H100 80GB pod** with a persistent volume (Runpod is a sponsor, so ask for credits) | The CUDA extensions (SAM 3, TRELLIS.2, gsplat) need a box you can SSH into to debug. |
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
 Ray-Ban Meta (3K@30, stabilization OFF)
        │ Meta AI app → camera roll
        ▼
 ┌──────────────┐   upload (presigned PUT)   ┌───────────────────────────┐
 │ Phone/web    │ ─────────────────────────▶ │ Object storage (R2/S3)    │
 │ /upload page │                            │ videos, .spz, .glb, json  │
 └──────────────┘                            └──────────┬────────────────┘
        │ createMemory reducer                          │ read/write
        ▼                                               ▼
 ┌─────────────────────────┐  status via HTTP   ┌────────────────────────────────┐
 │ SpacetimeDB 2.13 module │ ◀───────────────── │ GPU pipeline (Runpod H100)      │
 │ memory, room, player,   │                    │ 1 ingest  ffmpeg, blur filter   │
 │ timeline, branch,       │                    │ 2 label   Claude: object list   │
 │ object_state, grab,     │                    │ 3 segment SAM 3 video masks     │
 │ branch_keyframe         │                    │ 4 poses   DA3 / VGGT / MegaSaM  │
 └──────────┬──────────────┘                    │ 5 bg      gsplat (masked) → spz │
            │ websocket subscriptions           │ 6 objects SAM 3D Obj / TRELLIS2 │
            ▼                                   │ 7 tracks  depth+mask → SE(3)    │
 ┌─────────────────────────────────────────┐   │ 8 export  memory.json           │
 │ Viewer (apps/web): one URL              │   └────────────────────────────────┘
 │  Quest 3S browser: immersive-vr, hands  │
 │  Phone: touch orbit + tap-grab          │──── loads memory.json + assets from storage
 │  three.js · Spark · Rapier · STDB SDK   │
 └─────────────────────────────────────────┘
```

### 2.1 The contract: `memory.json`
Defined in [`packages/shared/src/manifest.ts`](../packages/shared/src/manifest.ts), with a Python mirror in [`pipeline/memreplay/manifest.py`](../pipeline/memreplay/manifest.py). It holds:
- **World frame:** +Y up, meters, and the floor height. The pipeline gravity-aligns and scales the scene, so **the viewer never sees COLMAP's Y-down frame.**
- **Background:** one splat (`.spz`), plus an optional coarse collider `.glb`.
- **Camera track:** the wearer's head path, for "see it through my eyes" mode.
- **Objects:** visual (splat or mesh), collider (box, sphere, capsule or convex hull), mass, grabbable, visible time range, and a pose track `[{t, p, q}]` sampled at 10–30 Hz.

The viewer develops against `apps/web/public/mock/memory.json` and never waits on the pipeline.

### 2.2 Reconstruction pipeline (`pipeline/`, Python, Runpod H100)
Each stage reads and writes a work directory, so any stage can be re-run on its own.

| # | Stage | Tool (fallback) | Output | Est. time (45 s clip) |
|---|---|---|---|---|
| 1 | Ingest | ffmpeg at 10 fps, drop blurry frames (Laplacian variance) | frames/ | 1 min |
| 2 | Label | **Claude vision** on 8 keyframes → `[{label, prompt, mass_kg, grabbable}]` | objects.json | 30 s |
| 3 | Segment | **SAM 3** text prompts, plus always "person" and "hand" (SAM 2.1 with clicks) | masks per object ID | ~5 min |
| 4 | Poses and depth | **Depth Anything 3** or **VGGT** on frames with dynamic pixels blacked out (MegaSaM for heavy motion; COLMAP/GLOMAP; a phone scan as last resort) | cameras, metric depth | ~2–10 min |
| 5 | Background | **gsplat** 7k–30k iterations with masked loss, so movers leave no ghosts (DA3's feed-forward Gaussians) → `.spz`, ≤350k splats | bg.spz | 5–20 min |
| 6 | Objects | **SAM 3D Objects** on the sharpest crop gives an object splat; collider is the convex hull of its points (TRELLIS.2 → GLB → CoACD hull) | obj_i.spz plus a hull | ~1 min each |
| 7 | Tracks | Each frame: masked depth → world points. Translation = centroid; rotation = ICP against the object's points (yaw-only fallback). Smooth with Savitzky-Golay. | tracks | 2 min |
| 8 | Export | RANSAC the floor plane, set gravity to +Y, scale to meters, write `memory.json`, upload | memory.json | 1 min |

**People:** L0 renders a per-frame masked point cloud as a "ghost hologram" (cheap, hides artifacts). L2 is a stretch: SAM 3D Body meshes per frame with kinematic capsule colliders.

**Quality ladder.** Every level is a working demo.
- **L0:** background splat plus point-cloud ghosts on a scrubber.
- **L1 (target):** plus rigid objects with splat, collider and pose track, and physics while paused.
- **L2:** plus people as meshes.
- **L3 (stretch):** full 4DGS.

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
| `object_state` | (branchId, objectId), heldBy?, mode (track/physics/rest), pose, velocity, fromMediaUs | grab / move / release |
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
| **P1 · Pipeline** | GPU box, poses, background | `pipeline/` stages 1, 4, 5, 8; Runpod pod; storage |
| **P2 · Objects & AI** | Claude labeling, SAM 3, object splats, tracks, ghosts | `pipeline/` stages 2, 3, 6, 7 |
| **P3 · XR client** | Quest rendering, grab and physics, timeline UX | `apps/web` loader, physics, input-xr, ui |
| **P4 · Multiplayer & phone** | SpacetimeDB module, net sync, phone controls, upload page, demo and Devpost | `server/spacetime`, `apps/web` net and input-touch |

**How we work**
- **Contract first.** Changes to `memory.json` go in one PR that touches both the TypeScript and Python files, and get announced in chat.
- **Branches:** `pipe/*`, `web/*`, `stdb/*`, `demo/*`. Small PRs. `main` always runs.
- **No assets in git.** Put them in storage and reference them by URL.
- **Checkpoints** are go/no-go meetings: 10 minutes, standing, with a demo on the real device.

---

## 4. Timeline (assumes the deadline is Sun 4:30 PM; verify)

| When | Goal | Details |
|---|---|---|
| **Fri 7:30–8:30 PM** | Kickoff | Everyone reads this plan. Accounts: Runpod (ask for credits), `spacetime login`, Claude API key, GitHub repo, R2 bucket. **Record the capture set** (rules below). |
| **Fri 8:30–11:30 PM** | Spikes in parallel | **P1:** real clip → DA3/VGGT → splat → `.spz` → URL. **P2:** Claude labels and SAM 3 masks on the same clip. **P3:** scaffold on Quest over adb; load the real `.spz` at 72 fps; 90-min IWSDK + Spark spike. **P4:** module published locally; two browsers see each other's heads; shared play/pause. |
| **Fri 11:30 PM** | ✅ **Checkpoint 1** | Our own footage is visible in the Quest. Gates: if poses are bad, use a **phone scan for the background**; if IWSDK fails, **stay on plain three**. |
| **Sat 12–4 AM** | L0 + physics | Point-cloud ghosts on the scrubber; object splats and hull colliders; Rapier grab and throw while paused; grab ownership in STDB. |
| **Sat 4–9 AM** | Sleep in shifts | Two people at a time. The pipeline processes all takes overnight. |
| **Sat 9 AM–12 PM** | L1 | Object pose tracks; fork, replay and branch keyframes; phone avatars and controls. |
| **Sat 12 PM** | ✅ **Checkpoint 2** | **Lock the demo clips.** One object replays, gets grabbed in VR, and forks a branch while a second person watches on a phone. |
| **Sat 12–6 PM** | Features | Branch tree UI; upload page and job status; Claude "what if" and captions; people (SAM 3D Body, stretch). |
| **Sat 6 PM** | ✅ **Checkpoint 3: feature freeze** | After this, only polish, performance and stretch work, each behind a flag. |
| **Sat 6 PM–Sun 2 AM** | Polish | Quest frame rate, visuals for timeline branches, sounds, onboarding. Stretch: live glasses stream via Meta DAT; passthrough AR mode. |
| **Sun 2–9 AM** | Sleep shifts, bug bash | |
| **Sun 9 AM–1 PM** | Ship | Record the demo video (Quest cast plus phone screen recording), Devpost, per-track write-ups. |
| **Sun 1–4:30 PM** | Buffer | Submit by 4:30 PM. Rehearse the 3-minute pitch three times. |

---

## 5. Capture rules (tonight, before anything else)
- Meta AI app → Devices → Settings → Media: **max resolution at 30 fps, stabilization OFF**, longest clip length. iPhone gives HEVC; ffmpeg handles it.
- **Two clips per scene:**
  1. A 30–60 s **static sweep**, walking sideways in an arc. Close the loop at the end.
  2. The **action clip**, with ≤3 rigid, textured, slow-moving things: a ball, a toy, a cup, a dog.
- Keep head turns slow. Light should be bright and even. Avoid mirrors, glass and screens. Textured surroundings help; blank white walls break pose estimation.
- Record 3–5 takes and keep the best one. **Backup:** also scan the room with Scaniverse or Polycam on a phone.

---

## 6. Risks
| Risk | Mitigation |
|---|---|
| Bad camera poses from head-mounted video | Capture rules; masked frames for pose estimation; phone-scan background fallback |
| Spark in WebXR on Quest 3S (unverified), or IWSDK and Spark conflicting over `three` | Test tonight; plain three is the default; ≤500k splats |
| Scale or axis mismatch between splats and colliders | One world frame in the manifest; floor RANSAC; metric DA3; a debug view with collider wireframes |
| CUDA environment problems | One owner for the box; a separate conda env per tool; cache every stage |
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
