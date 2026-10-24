# Integration guide

**Read this before merging anything.** The team built the app on four separate lines of work. None of them has been merged together yet, and they conflict. This page covers:
- where each piece lives and what state it's in;
- which version of each shared contract should win;
- the merge order, with a rule for every conflicting file;
- the checks to run after each merge;
- what nobody has built yet.

*Written Sat Oct 24, ~1:45 AM, from a read of every branch at these commits:*

| Branch | Commit |
|---|---|
| local `main` | `2c1b9cd` |
| `origin/main` | `9c97896` |
| `origin/nikko` | `38e3329` |
| `origin/stdb/jerry-p4` | `09106b3` |
| `origin/part1` | `a9ce785` |

If `git log` shows newer commits, re-check the parts they touch.

---

## 1. Where everything lives

```
615e91d  first scaffold
 ├─ origin/part1          a9ce785  Andrew: local CPU pipeline + scene viewer
 ├─ origin/stdb/jerry-p4  09106b3  Jerry: multiplayer server, upload, phone, iOS capture
 └─ 9c97896 = origin/main          scaffold fixes + 2-player smoke test
     ├─ origin/nikko      38e3329  Nikko: viewer engine (physics, XR, timeline replay)
     └─ local main        2c1b9cd  vision pipeline design + runbook (3 commits, NOT pushed)
```

| Line of work | Owner | Branched from | What it has | Tests | Its docs |
|---|---|---|---|---|---|
| **local `main`** | vision (one person) | `9c97896` | Vision pipeline design, runbook and Runpod setup (`pipeline/`); scene format with new fields (`packages/shared/src/manifest.ts`); `memreplay merge`; scaffold viewer (`apps/web/src/main.ts`); SpacetimeDB module (`server/spacetime`); 18-step smoke test (`/smoke.html`) | Smoke test (manual, in a browser); merge was tested by hand on sample data (no test file yet) | `README.md`, `docs/PLAN.md`, `pipeline/README.md` |
| **`origin/nikko`** | Nikko (P3) | `9c97896` | Viewer engine in `apps/web/src/`: `loader.ts`, `tracks.ts`, `timeline.ts`, `physics.ts` (Rapier), `viewer.ts`, `input-desktop.ts`, `input-xr.ts`; splat test setup (`scripts/setup-splat-test.mjs`) | `npm test`: 17 node tests (verified passing); `npm run build` passes | `docs/P3_VIEWER.md`, `docs/SPLAT_TEST.md` |
| **`origin/stdb/jerry-p4`** | Jerry (P4) | `615e91d` (old) | SpacetimeDB module rewrite; `apps/web/src/net/` multiplayer client; touch input; upload service (`server/upload/`); upload pages; capture simulator (`/capture.html`); iOS capture app (`apps/ios/`); `scripts/pipeline-status.py` | 16 vitest tests (`tests/`), `test:integration`, `test:video`; typecheck verified | `docs/P4.md`, `docs/CAPTURE_TEST.md`, `docs/DEMO.md` |
| **`origin/part1`** | Andrew | `615e91d` (old) | Local CPU pipeline in `pipeline/memreplay/` (`video.py` ingest, `fixture.py`, `splats.py`, `geometry.py`, `export.py`, `reconstruct.py` DA3 adapter); JSON schemas (`packages/shared/*.schema.json`); viewer with schema check and `?debug=1` overlay | 20 pytest tests (15 test functions, `pipeline/tests/`), not re-run | `docs/PART1.md` |

**Inspect a branch without changing your checkout:**
```bash
git fetch origin
git log --oneline --stat origin/nikko -5
git show origin/stdb/jerry-p4:docs/P4.md
git merge-tree --write-tree --name-only main origin/part1   # lists files that would conflict
```

**Conflicts found** (by `git merge-tree`; every pair conflicts):

| Merge | Conflicting files |
|---|---|
| main + nikko | `README.md`, `.gitignore` |
| main + jerry-p4 | `server/spacetime/src/index.ts`, all of `apps/web/src/module_bindings/`, `apps/web/src/main.ts`, `index.html`, `vite.config.ts`, `package.json`, `package-lock.json`, `README.md`, `.gitignore` |
| main + part1 | `pipeline/memreplay/cli.py`, `manifest.py`, `pipeline/pyproject.toml`, `apps/web/src/main.ts`, `vite.config.ts`, `package-lock.json`, `README.md`, `.gitignore` |

---

## 2. Which version wins, per contract

### A. Scene format (`memory.json`): main's version wins
The source of truth is `packages/shared/src/manifest.ts` plus its Python mirror `pipeline/memreplay/manifest.py` on local main. It's a superset of every other branch, adding:
- `Keyframe.v`: velocity in m/s, applied when time is paused;
- `source.audioUrl`;
- visual `primitive {shape, size, color}`;
- visual `points-sequence {url, frameCount, sampleHz}`: people ghosts, binary layout in `pipeline/memreplay/handoff.py`;
- collider `cylinder {halfHeight, radius}`.

What each consumer must change:

| Consumer | Change needed |
|---|---|
| nikko's viewer (`loader.ts`, `physics.ts`, `viewer.ts`) | It **doesn't compile** against main's `manifest.ts`: `loader.ts:55,192` and `physics.ts:10`. The minimal fix that unblocks merging is in step 1. The full support below is P3's follow-up (§4).<br><br>**Visuals:** add the new kinds to `validateManifest`; render `primitive` as a tinted mesh and `points-sequence` as `THREE.Points` (positions via `Float16BufferAttribute`, colors `Uint8`).<br><br>**Colliders:** add `cylinder` to `physics.ts` (`RAPIER.ColliderDesc.cylinder`) and to `proxyGeometry` (`loader.ts:103`, `THREE.CylinderGeometry(r, r, 2*halfHeight)`; today it draws a 0.3 m box).<br><br>**Velocity:** prefer the active keyframe's `v` when present, falling back to the computed `trackVelocity` (`viewer.ts:88`). Keep `trackVelocity` for remote poses (`viewer.ts:110`).<br><br>**Ghosts:** in `seedColliders` (`viewer.ts:85`), add non-grabbable / `mass: 0` objects as fixed or kinematic bodies, or skip them, or they fall when time is paused.<br><br>**Audio:** play `source.audioUrl` in sync (resync past 100 ms drift).<br><br>`colliderUrl` is already loaded as the room trimesh (`loader.ts:166`, `physics.ts:35`). |
| part1's `manifest.py` and schema | Merge main's models with part1's validators (`extra="forbid"`, unit quaternions, increasing times). Two rules to change: `mass` must allow 0 for non-grabbable objects (ghosts use `mass: 0`), and `Keyframe` needs `v`. Then regenerate `packages/shared/memory.schema.json` with `memreplay schema --out packages/shared`; otherwise the viewer's schema check rejects the new fields. In the generated schema, `version` and `grabbable` must be required, as they are in TS. |
| jerry's `main.ts` | Retire it (see C). It only reads colliders, tracks and the background, and turns cylinders into cubes. |
| nikko's mock `apps/web/public/mock/memory.json` | Points to files that don't exist (`/mock/ball.glb`, `./cube.glb`, `./demo-background.spz`). Switch objects to `primitive` visuals and point the background at the splat-test sample. |

Rules every producer and consumer must agree on:
- **URLs** inside `memory.json` are relative to the manifest file. Only SpacetimeDB's `memory.manifestUrl` must be absolute: http(s), at most 2048 characters.
- **`splat-sequence`** frame for time t is `floor((t − visibleFrom) × timeline.sampleHz)` (nikko's `loader.ts:123`).
- **`points-sequence`** frame k is at `t = k / sampleHz` from the start of the clip, positions already in world coordinates, and the object's track is identity.
- **Splat budget:** merge warns above 350k background splats; the viewer warns above 500k total and refuses above 1M.
- **File name clash:** main's `input/frames.json` (`FramesInfo`) and part1's ingest `frames.json` (`kind: "video-frames"`) are different formats. Rename part1's to `keyframes.json`, or write it under `<work>/ingest/`.

### B. SpacetimeDB module: jerry-p4's version wins
Use `server/spacetime/src/index.ts` from `origin/stdb/jerry-p4`. It's more complete, validated and tested:
- **Errors:** `SenderError`.
- **Memory lifecycle:** status goes `uploaded → processing → ready`. `uploaded` or `processing` can go to `failed`, and `failed → processing` is a retry. A memory created with a `manifestUrl` (Add to library) starts as `ready`. Only the pipeline's identity may set status. `ready` needs an http(s) `manifestUrl` and progress exactly 1, and progress can't go backwards. `createRoom` requires `ready`. `createMemory` takes 6 arguments and is idempotent by `requestId`.
- **Edits:** grab and fork require a paused timeline.
- **Keyframe chunks:** validated: 1–120 frames, `t` in **absolute media seconds**, `startMediaUs = round(frames[0].t × 1e6)`, no overlaps.
- **Clock:** the `sampleClock` reducer and `clockSample` table, for clock calibration.
- **Presence:** `leaveRoom` clears your object ownership and marks you offline.

| | main (`9c97896` + fixes) | jerry-p4 (target) |
|---|---|---|
| `objectState` key | `id` (u64) | `key` string `"<branch>:<obj>"` |
| Object modes | held / thrown / rest | held / physics / rest, plus `simOwner` |
| Catching a thrown object | allowed | **rejected** ("owned by another player") |
| Fork on first grab of the original | yes ("what if") | yes ("First edit"), plus a new fork when editing an object already at rest |
| Child branch inherits parent edits | copies rows into the child | copies nothing; client resolves ancestry with `net/replay.ts branchFrames()` |
| Releasing holds on branch/room change | `dropRoomHolds` | rejects seek/fork/setBranch during a simulation; clears ownership on leave/disconnect |
| `memory` table | id, owner, title, manifestUrl, status, progress | adds requestId, pipelineIdentity, sourceUrl, error, durationUs |

**Port nothing from main's module,** except the catch rule if the team wants it (decision 1 in §5).

**Never hand-merge** `apps/web/src/module_bindings/`. Delete both versions, then run `npm run stdb:generate` with SpacetimeDB CLI 2.13.0, and pin `spacetimedb` to exactly 2.13.0.

**Delete main's `apps/web/smoke.html` and `src/smoke.ts`.** They call the old `createMemory({title, manifestUrl})`. Their coverage moves to jerry's `tests/module.test.ts` and `scripts/test-multiplayer.ts`.

### C. Viewer: nikko's engine plus jerry's networking
Target layout of `apps/web/src/`:

| File(s) | From | Notes |
|---|---|---|
| `main.ts`, `index.html`, `style.css` | nikko | Already has `SparkRenderer` (needed, or splats never draw), pixel ratio 1, camera rig and VR spawn |
| `loader.ts`, `tracks.ts`, `timeline.ts`, `physics.ts`, `viewer.ts`, `input-desktop.ts`, `input-xr.ts` | nikko | Plus the scene-format changes in A |
| `session.ts` (new) | from jerry's `main.ts` | Room / library / upload HUD, head-sphere avatars |
| `net/index.ts` (`Multiplayer`), `net/replay.ts` | jerry | Connection, subscriptions, clock, poses at 12.5 Hz |
| `net/adapter.ts` (new) | to write | Implements nikko's `InteractionAuthority` on top of `Multiplayer` (mapping below) |
| `input-touch.ts` | jerry | Point it at the viewer's grab/move/release |
| `upload.ts`, `recorded-upload.ts`, `capture.html`, `capture*.ts`, `capture.css` | jerry | Unchanged |
| `debug.ts` (new, optional) | from part1's `main.ts` | The `?debug=1` grid and camera path; drop the ruler hard-coded to the fixture cube. Optionally also part1's schema check (Ajv) inside `loader.ts`. |
| **Delete:** `net/physics-bridge.ts` | jerry | A second Rapier world. Copy its timings (moves at 15 Hz, keyframe chunks every 25 samples) into the adapter first |
| **Delete:** main's `main.ts` and `smoke.*`; part1's `main.ts` | | After moving the useful parts |

How `net/adapter.ts` maps viewer events to server calls (also in nikko's `docs/P3_VIEWER.md:68-77`):

| Viewer event | Server call |
|---|---|
| `acquire` (start grab) | Pause if needed, then `grab`. Wait for the timeline and branch rows, then return `{branch}`. Branch `0n` maps to `"original"`; other ids become strings; µs become seconds. |
| `pose` while held | `moveObject` at 15 Hz |
| `throw` | `release(rest: false)` |
| Simulation recording | Downsample, split into chunks of at most 120 frames, `saveBranchKeyframes` for each and wait for all, then `release(rest: true)` |
| Seek, play/pause, switch branch | `seek`, `setPaused`, `setBranch` |
| Row updates from the server | `applyClock` (**only** when the timeline row changes: it finishes any running simulation), `upsertBranch` (parents first), `appendRecording`, `applyRemotePose` |

### D. Vision pipeline: main's design, plus reusable parts of part1
- **Keep main's pipeline:** S1 normalize → S2 ViPE → S3 world frame → S4 L0 export → S5 objects → S6 background → S7 merge, with `pipeline/memreplay/handoff.py`, `cli.py` and `pipeline/runpod/`. See `pipeline/README.md`. Main deliberately does **not** use Depth Anything 3 or VGGT as the camera solver: they assume nothing moves.
- **Reuse from part1:**
  - `splats.py` as the S4 room-points writer (same 14-field PLY).
  - `fixture.py`, extended to write a full work folder, so `merge` gets a test that runs on a CPU.
  - `io.py`, the model validators, `pipeline/tests/` and the `schema` command.
  - `video.py` as a frame-preview tool (it keeps real timestamps and converts HDR). Not as S1, which must output a constant-30-fps `input/clip.mp4` plus `audio.m4a`.
- **Owner's call:** keep `reconstruct.py` / `doctor` (the DA3 adapter) as `experimental-da3`, or drop them.
- **Duplicate code:** `geometry.camera_tracks` duplicates `cli.quat_from_c2w_opencv`. Keep one, with a test.
- **Merged `cli.py`:** one parser with `stage`, `merge`, `ingest`, `fixture`, `calibrate`, `export`, `validate`, `schema` (and `doctor`/`reconstruct` if kept). Import heavy libraries inside each command.
- **Merged `pyproject.toml`:** part1's `[build-system]`, package discovery and `[test]` extra, plus the union of dependencies: numpy, pydantic>=2,<3, opencv-python-headless, trimesh, av, imageio-ffmpeg, pillow, scipy, plyfile.

### E. Ports, settings and scripts

| | main | nikko | jerry-p4 | part1 | **Target** |
|---|---|---|---|---|---|
| SpacetimeDB port | 3055 | 3055 | 3000 | 3000 | **3000** (use another if Docker holds it) |
| Vite proxy | `/v1` → `STDB_URL` | same | `/stdb` (websocket) → 3000, `/api` → 8788 (upload) | none | jerry's, plus a `STDB_URL` override |
| HTTPS in dev | off; `HTTPS=1` turns it on | same | on; `LOCAL_HTTP=1` turns it off | on; `MEMREPLAY_HTTP=1` turns it off | **jerry's (`LOCAL_HTTP=1`)** |
| Tests | `/smoke.html` | `node --test` (17) | vitest (16) + integration scripts | pytest (20) | all three |

- **Env vars** (jerry's): browser `VITE_STDB_URL`, `VITE_STDB_DATABASE`, `VITE_UPLOAD_API`; dev server and `upload:local` `PUBLIC_ORIGIN`; upload service `server/upload/.env.example`; worker `STDB_HTTP_URL`, `STDB_DATABASE`, `PIPELINE_TOKEN`.
- **Root `package.json`:** jerry's scripts and dev dependencies. `"test": "vitest run && npm run test -w apps/web"`, plus a `test:pipeline` script running pytest. Node ≥ 22.12 (jerry's `engines` field; his `.nvmrc` pins 22.23.2).
- **`apps/web/package.json`:** nikko's `test` script, plus `ajv` if part1's schema check is kept.
- **Library versions match on every branch:** three ^0.186.1, @sparkjsdev/spark ^2.4.0, @dimforge/rapier3d-compat ^0.21.0, vite ^7, typescript ^5.9.
- **Never hand-merge `package-lock.json`.** Delete it and run `npm install`.

---

## 3. Merge plan

### Step 0: start from a clean `main`
These docs, plus a fix to `package.json`, may still be uncommitted on local `main`. The fix moves the SpacetimeDB scripts from port 3001 to 3055, matching Vite's proxy. `git merge` refuses to run while `README.md` or `package.json` have uncommitted edits.
1. **Commit, with the owner's OK** (CLAUDE.md: commit or push only when asked):
   ```bash
   git add README.md CLAUDE.md docs/ package.json pipeline/README.md && git commit -m "Add integration guide"
   ```
2. **Check** that `git status` is clean.
3. **Push `main`** (`git push origin main`), again with the owner's OK. The Runpod setup clones `main` from GitHub, and local `main` has unpushed commits.
4. **Branch:** `git switch -c integration main`.

### Step 1: merge `origin/nikko`
```bash
git merge origin/nikko
```

Resolve the conflicts:
- **`README.md`:** only the top block conflicts. Keep main's status table and links, add nikko's P3 viewer link, and drop nikko's old status line. Don't use `git checkout --ours`: nikko's controls and `npm test` rows merge in automatically.
- **`.gitignore`:** union of both.

Then commit a **minimal fix** so the viewer compiles against main's scene format. The rest of the nikko row in §2 A is P3's follow-up.
- **`loader.ts`:** narrow `o.visual.url` by `kind` (lines 55 and 192), and accept `primitive`, `points-sequence` and `cylinder` in `validateManifest`.
- **`physics.ts:10`:** add `case "cylinder": return RAPIER.ColliderDesc.cylinder(definition.halfHeight * scale, definition.radius * scale);`
- **Rendering:** draw `primitive` as a tinted mesh. Other new visuals may draw as their collider proxy for now.
- **`apps/web/public/mock/memory.json`:** fix it (§2 A, last row). Give both objects `primitive` visuals, one with a `cylinder` collider, and drop the missing `.glb`/`.spz` references.

Check:
```bash
npm install && npm run build && npm test && npx tsc -p server/spacetime --noEmit
npm run stdb:start                            # terminal 1 (port 3055 until step 2)
npm run stdb:publish:local && npm run dev     # terminal 2; open / and /?memory=/mock/memory.json (no load errors),
                                              # then /smoke.html: 18 checks pass (smoke is deleted in step 2)
```

### Step 2: merge `origin/stdb/jerry-p4`
```bash
git merge origin/stdb/jerry-p4
```

| File | Resolution |
|---|---|
| `server/spacetime/src/index.ts` | take jerry's (`git checkout --theirs`) |
| `apps/web/src/module_bindings/*` | delete, then `npm run stdb:generate` |
| `apps/web/src/main.ts`, `index.html`, `style.css` | keep nikko's (`--ours`); read jerry's later with `git show origin/stdb/jerry-p4:apps/web/src/main.ts` |
| `apps/web/vite.config.ts` | jerry's, plus the `STDB_URL` override; drop `/v1` and the smoke page entry |
| `package.json` | per §2 E |
| `apps/web/package.json`, `.gitignore` | union |
| `package-lock.json` | delete, then `npm install` |
| `apps/web/smoke.html`, `src/smoke.ts` | delete |
| `README.md` | keep ours; add jerry's setup rows (port 3000, `LOCAL_HTTP=1`, `npm run upload:local`, Node ≥ 22.12) and his npm scripts |

Check:
```bash
npm ci && npm run stdb:build && npm run stdb:generate && git diff --exit-code apps/web/src/module_bindings
npm run typecheck && npm test && npm run build
spacetime start --listen-addr 127.0.0.1:3000 &      # terminal 1
npm run stdb:publish:local && npm run upload:local   # terminal 2 (see docs/P4.md for --anonymous login)
LOCAL_HTTP=1 npm run dev                             # terminal 3; open / and check the viewer still loads (no room UI until step 3)
npm run test:integration
```

### Step 3: adapter commit
Write `net/adapter.ts` and `session.ts`, point `input-touch.ts` at the viewer, and delete `net/physics-bridge.ts` (§2 C).

Check:
1. Everything from step 2.
2. Open `/?demo=1` in two browsers, create and join a room, then grab, throw and replay on a branch.
3. Do the same from a phone. Either run `npm run dev` (HTTPS) with `npm run tunnel`, or keep `LOCAL_HTTP=1 npm run dev` and run `cloudflared tunnel --url http://127.0.0.1:5173`.

### Step 4: merge `origin/part1`
```bash
git merge origin/part1
```

| File | Resolution |
|---|---|
| `pipeline/memreplay/manifest.py` | main's models + part1's `ContractModel` and validators, with the `mass` rule and `v` (§2 A) |
| `pipeline/memreplay/cli.py` | union of commands (§2 D) |
| `pipeline/pyproject.toml` | union (§2 D) |
| viewer files, `vite.config.ts` | keep ours; move the schema check and debug overlay over (§2 C) |
| `.gitignore` | union, adding `apps/web/public/local/` and `.pytest_cache/` |
| `README.md` | keep ours; add part1's pipeline commands (`memreplay fixture/export/validate/schema`) |
| `package-lock.json`, `packages/shared/*.schema.json` | regenerate |

Check:
```bash
python3.12 -m venv .venv && .venv/bin/pip install -e './pipeline[test]'
.venv/bin/memreplay schema --out packages/shared && git diff --exit-code packages/shared
.venv/bin/python -m pytest pipeline/tests -q
.venv/bin/memreplay fixture --out data/fixture-v1
.venv/bin/memreplay export --geometry data/fixture-v1/geometry.json --alignment data/fixture-v1/alignment.json \
  --out apps/web/public/local/fixture --id synthetic-room --title 'Synthetic pipeline fixture'
# open /?memory=/local/fixture/memory.json  (&debug=1 only works once debug.ts exists)
.venv/bin/memreplay validate apps/web/public/mock/memory.json
npm run build && npm test
```

### Step 5: docs
- **Status lines:** update the status matrix in `README.md` and the status lines in `docs/PLAN.md` §2.3/§2.4 and `pipeline/README.md` §9.
- **Stale claims:** fix the "contract unchanged" lines in `docs/P3_VIEWER.md:42` and `docs/P4.md:17`.
- **PART1.md caveat:** add to `docs/PART1.md` that `npm run dev -- --host 127.0.0.1` doesn't pass `--host` through the workspace script.

---

## 4. Not built by anyone yet

| Gap | What it needs | Owner (suggested) |
|---|---|---|
| **Pipeline worker** (upload → pipeline → ready) | 1. Subscribe to the public `memory` table (jerry's `docs/P4.md:95`) and take rows with `status = 'uploaded'` and its own `pipelineIdentity`.<br>2. Call `scripts/pipeline-status.py <id> processing --progress 0.1`.<br>3. Download `sourceUrl` to `<work>/clip.mov`.<br>4. Run S1–S7, reporting progress after each step (progress can't go backwards).<br>5. Upload the viewer files (list in `pipeline/README.md` §7) to a public URL.<br>6. Finish with `<id> ready --progress 1 --manifest-url https://…/memory.json`; on error, `<id> failed --progress <p> --error "…"`.<br><br>The pod must reach SpacetimeDB at a public URL. | Vision |
| **Pipeline steps S3–S6** | Code; S1 is a snippet, S2 is ViPE itself, S7 is done | Vision |
| **Viewer support for new scene fields** | §2 A, nikko row | P3 |
| **`net/adapter.ts`, `session.ts`** | §2 C | P3 + P4 |
| **Quest controller grab in the multiplayer build** | Comes from nikko's `input-xr.ts` once the adapter exists | P3 |

Known mismatches the worker must handle:
- iOS clips from jerry's app are 24 fps with no audio, so leave `audioUrl` out for them.
- `memory.durationUs` can't change after upload. Keep `timeline.durationSec` equal to the source duration, or add a duration argument to `setMemoryStatus`.

## 5. Decisions for the team

1. **Catching a thrown object.** Main allowed it; jerry's server rejects it. Keep jerry's behavior (simpler), or let `grab` take over an object in `physics` mode.
2. **Part1's DA3 reconstruction.** Keep it as an experimental command, or drop it?
3. **SpacetimeDB port.** 3000 is the target, but Docker held 3000 and 3001 on one laptop. Pick one and put it in `.env`.
4. **Privacy.** All memory rows and `sourceUrl`s are public on jerry's server (`docs/P4.md:124`). Fine for the demo; note it.
5. **Phones reaching registered manifests.** Jerry's "Add to library" resolves the manifest URL against `location.href`, so a manifest registered from `127.0.0.1` can't be opened on a phone. Register it from the tunnel URL, or type a full public `https://…/memory.json`. (`PUBLIC_ORIGIN` only sets the URLs `upload:local` gives uploaded clips, and Vite's allowed host.)

## 6. Gotchas
- **Deterministic server code.** SpacetimeDB module code can't use `Math.random()` or `Date.now()`; use `ctx.random` and `ctx.timestamp`.
- **Name casing.** Names are snake_case on the wire and in SQL (`create_room`), and camelCase in TypeScript (`conn.reducers.createRoom({...})`).
- **The `spacetime` CLI defaults to Maincloud.** Pass `-s http://127.0.0.1:<port>` for local work.
- **Spark needs a `SparkRenderer` in the scene,** or no splat draws.
- **Two copies of the scene format.** It lives in both `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py`. Change both in the same commit, then regenerate the JSON schema.
- **Untested on hardware:** nothing has run on a real Quest, real glasses footage or a real Runpod pod. Everything above was checked by reading code, type-checking, and the tests each branch ships.
