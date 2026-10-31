# Vision pipeline runbook

**One video in, one `memory.json` out.** A phone or Ray-Ban Meta clip becomes a scene you can walk into: the room as a
Gaussian splat, people as moving point "ghosts", the wearer's head path, and the small props as grabbable objects with
physics. The format is [`packages/shared/src/manifest.ts`](../packages/shared/src/manifest.ts); the files between steps
are in [`memreplay/handoff.py`](memreplay/handoff.py).

Results on the demo clips (five phone samples and nine glasses clips), measurements and limitations:
[docs/reports/vision-pipeline.md](../docs/reports/vision-pipeline.md). How to record clips that reconstruct well:
[docs/recording-guide.md](../docs/recording-guide.md).

```
memreplay/          the package: one module per step, the CLI (cli.py), the worker (worker.py) and its helpers
tests/              pytest on a synthetic scene with known answers, plus the worker helpers
runpod/             pod setup and environments, the batch runner, laptop helpers for a pod (remote/pod/sync/pull.sh)
tools/              render-vs-video scoring, the judge workflow, card previews, scene index and scene packaging
experiments/fourd/  the 4D Gaussian splatting comparison (docs/reports/4dgs.md)
```

---

## 1. Run it

On the pod (setup in §5), one command per clip:

```bash
source /workspace/memory-replay/pipeline/runpod/env.sh && use world
mkdir -p $WORK/kitchen && cp clip.mov $WORK/kitchen/            # clip.mov or clip.mp4
memreplay run $WORK/kitchen --title "Kitchen" --eye-height 1.35 --device iphone   # all steps, then memory.json
memreplay verify $WORK/kitchen                                    # numbers + pictures in $WORK/kitchen/verify
memreplay publish $WORK/kitchen --to /some/public/dir/kitchen     # or --to s3 (bucket settings from the env)
```

`--eye-height` is the camera's height while recording (phone at the chest of a 185 cm person ≈ 1.35 m; glasses ≈ eye
height). `run` skips finished steps; `--redo world l0` reruns some, `--force` all. Each step also runs alone:
`memreplay stage <normalize|nouns|vipe|world|l0|objects|background> --work <dir>`.

Many clips at once, GPU kept busy (ViPE back to back while the remaining `memreplay run` steps follow):
`bash pipeline/runpod/batch.sh $WORK/a $WORK/b ...`
(titles from `<work>/title.txt`, device from `<work>/device.txt`).

On a laptop (no GPU): S1 runs anywhere with ffmpeg, and S3–S5, S7 and `verify` run on a copied work dir:

```bash
python3.12 -m venv .venv && source .venv/bin/activate && pip install -e "pipeline[claude,dev]"
memreplay stage normalize --work data/work/kitchen --eye-height 1.35
pytest pipeline                                  # from the repo root: synthetic scene with known answers, S3-S7, formats
```

Viewer: copy the published folder to `apps/web/public/memories/<id>/` and open
`/?memory=/memories/<id>/memory.json` (`LOCAL_HTTP=1 VITE_PORT=5177 npm run dev -w apps/web` for plain http).
`python pipeline/tools/index_scenes.py` lists every local scene at `/scenes/index.html` and lets the dev server seed
them into the library.

### The static walk-through (start here)

The room alone, as a high-quality splat you walk through on the Quest: no people, objects or timeline.

```bash
memreplay stage background --static --work $W      # props stay in the room, only people masked; ≤ 500k splats; poses refined
memreplay merge $W --static --title "Kitchen"       # -> memory.static.json (room splat, collider, start position, audio)
```

On the Quest (USB): `LOCAL_HTTP=1 npm run dev`, `adb reverse tcp:5173 tcp:5173`, then in the Quest Browser open
`http://localhost:5173/?memory=/memories/<id>/memory.static.json` and press **Enter VR**. Left stick walks, right stick
snap-turns. (Root README, Part 3, has the one-time Quest setup.)

---

## 2. The steps

```
clip ─► S1 normalize ─► S1 nouns ─► S2 ViPE ─► S3 world ─► S4 room + ghosts ─► S5 objects ─► S6 splat ─► S7 merge ─► memory.json
                                                       (S5 select runs before S4: it decides what is cut out of the room)
```

| Step         | Code                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                               | Writes                                                                                      |
| ------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| S1 normalize | `normalize.py`                    | Upright (applies the phone's rotation), constant 30 fps, long side 1280 px, H.264. **iPhone HDR** (HLG, BT.2020) is tone-mapped to SDR with a generated 3D LUT (ffmpeg `lut3d`; neither ffmpeg build has zscale). Audio to AAC.                                                                                                                                                                                                            | `input/clip.mp4`, `input/audio.m4a`, `input/frames.json`, `capture.json`                    |
| S1 nouns     | `claude.py`                       | Claude looks at an 8-frame contact sheet and lists the small movable props, one word each (ViPE's prompts; `person` and `hand` always). Fallback: generic props.                                                                                                                                                                                                                                                                           | `nouns.json`                                                                                |
| S2 ViPE      | `cli.run_vipe`                    | NVIDIA ViPE `pipeline=default` (commit `8c9f361`): camera path, intrinsics, metric z-depth for every pixel, instance masks. Detection every 0.5 s (`kf_gap_sec`, default 2 s).                                                                                                                                                                                                                                                             | `vipe/`                                                                                     |
| S3 world     | `world.py`                        | Meters, +Y up, floor at 0, wearer starting at the origin looking down −Z. Details below.                                                                                                                                                                                                                                                                                                                                                   | `world/world.json`, `world/cameras.json`, `world/frames.npz`                                |
| S5 select    | `objects.observe/select`          | Per mask id and keyframe: 3D position, extent, silhouette, sharpness. Splits ids where they jump impossibly (ViPE's tracker hops between look-alikes), joins re-detections, then Claude sees the best crop and says shape, size, density, colour, **grabbable** and **movable** (free-standing vs mounted). Only small, grabbable, free-standing props are kept.                                                                           | `objects/observations.json`, `objects/selection.json`, `objects/crops/`                     |
| S4 room      | `l0.py`                           | Room points: static pixels of ~360 frames, 2 cm voxels kept if seen in ≥ 2 frames, ≤ 300k, as small splats. People, hands and kept props are cut out; signs, benches and other segmented fixtures stay in the room. Collider: 10 cm heightfield (90th percentile below 1.2 m, so seats and tables count) plus 2.2 m wall columns. Ghosts: each person's pixels per keyframe, back-projected, in one binary per person (`points-sequence`). | `world/bg_points.ply`, `world/room_collider.glb`, `world/ghosts/*.bin`, `world/ghosts.json` |
| S5 objects   | `objects.run`                     | 10 Hz tracks: Hampel outliers, Savitzky-Golay smoothing, velocity, ballistic arc only through gaps that start as a throw, rests frozen in place. An object that never moved is held at the median of its whole (not edge-cut) views. Bottoms snapped onto the collider at rest. Primitive visual + matching collider, mass = density × volume.                                                                                             | `objects/objects.json`, `objects/report.json`                                               |
| S6 splat     | `background.py`, `train_splat.py` | gsplat MCMC (7.5k steps, ≤ 300k Gaussians) on our world-frame cameras, seeded from the room points, with **people and props masked out of the loss** (gsplat's loader only has per-camera masks; `train_splat.py` adds per-image masks, then runs `simple_trainer.py` unchanged). Then `splat-transform` → `.spz`.                                                                                                                         | `world/bg.spz`                                                                              |
| S7 merge     | `cli.merge`                       | Everything → validated `memory.json` (prefers `bg.spz` over the points).                                                                                                                                                                                                                                                                                                                                                                   | `memory.json`                                                                               |
| verify       | `verify.py`                       | Room points rendered from the recorded cameras vs the real frames; floor flatness; each object's track projected into the frames where ViPE saw it (inside its mask?); a pause-and-drop physics test; a top-down map.                                                                                                                                                                                                                      | `verify/report.json`, `verify/*.jpg`, `verify/map.png`                                      |

**S3 in detail** (each part exists because a real clip broke without it):

1. **Up direction** from the cameras' right axes: a hand-held camera barely rolls, so up is the direction most perpendicular
   to all right axes, whatever the pitch. (The average camera "up" was 22–30° off when the wearer looked down at a couch.)
   Falls back to the average when the head barely turned.
2. **Floor**: sequential RANSAC for planes within 40° of up; the best-supported plane fixes the normal; the lowest parallel
   plane with support is the floor.
3. **Tracking glitches**: frames whose pose jumps > 15 cm off a 15-frame median path, or turns > 20° in one frame, are
   left out of all geometry (the lobby clip has 325 such frames). The head path uses the smoothed position there.
4. **Re-levelling**: ViPE's path drifts vertically over long walks, which stacked the floor in 10–40 cm layers. Every
   0.5 s the floor is measured below the camera and each frame is shifted so it stays at y = 0. Samples that would put
   the camera > 0.2 m off its typical height, or > 0.3 m off the floor plane, saw a seat or table and are ignored.
5. **Scale**: trust ViPE's metric depth unless the camera height is > 25 % off the given height (> 40–70 % without one).
6. **Snap** the densest layer near 0 to exactly 0, then write every frame's final pose (`frames.npz`, used by S4–S6).

Tried and switched off: per-frame depth-scale alignment (map-based and pairwise). ViPE's pose errors leak into the depth
ratios, and both versions made reprojection worse (see the report). `world.ALIGN_DEPTH`.

**S6 today** (the table above is the original design; the report's §4 has the history):

- **S6 splat** (`background.py`): gsplat MCMC, cap 500k Gaussians, `steps_scaler 0.67` (about 20k steps), appearance
  model on (`--app_opt`; without it MCMC collapses), default pose refinement, ViPE depth supervision through COLMAP-style
  tracks (`--depth_loss`, λ 0.01), people masked out with a 12 px margin, sky pixels kept in the loss and seeded on a
  dome 150 m out (`MEMREPLAY_SKY_DOME`). Static mode trains the room on every frame.
- **S6c bake** (`bake.py`): exports the room at the mean appearance embedding, calibrates colour against the frames
  (global gain and bias), writes the per-frame exposure `e` that the viewer replays in wearer's view, and applies a
  viewer gain only if `world/viewer_gain.json` exists (identity by default: a per-clip fit cost 0.3 dB on glasses clips).
- **S6b layers** (`layers.py`, `cleanup.py`): prunes floaters near the path, giants, needles, haze and anything seen by
  fewer than two frames; beyond 60 m (facades, the sky dome) the size limit grows with distance and only faint
  Gaussians go (the old 80 m cut-off rendered the rotunda's sky black), then grows the far sky Gaussians so they
  overlap (`MEMREPLAY_SKY_FILL`, 2.5); carves each kept prop out of the room splat by mask votes.

---

## 3. Recording tips

[docs/recording-guide.md](../docs/recording-guide.md) covers capture settings and what makes a clip easy or hard to
reconstruct. In short: walk sideways while panning (turning on the spot gives ViPE no parallax), keep the camera at one
height, turn slowly, avoid close-ups of blank or dark walls, and keep clips under 30 s; ViPE runs at about 2 frames/s
on an H100.

---

## 3b. Does the scene match the video? (`memreplay compare`)

The direct check is to look at the scene from the recorded camera, at the video's field of view, and put it next to
the frame. `memreplay compare <memory dir> --video <clip.mp4> --shot <seconds>=<render.png> ...` does the scoring:
PSNR, SSIM and a colour-histogram match over the whole frame and the centre third, written to `compare.json`, plus
`compare.jpg` (rows = moments; columns = original | render | amplified difference). Renders are taken with the
viewer in **wearer's view** (the `Wearer's view` toggle, or `?mode=...` plus the checkbox), paused, HUD hidden, at
the clip's portrait aspect; `pipeline/tools/capture.js` does that headless with Chrome (run `npm ci` in `pipeline/tools` first) and
`pipeline/tools/evalclip.py` chains capture and scoring. `tools/judge.js` is the Claude Code workflow that has an
independent judge and a skeptic score every grid (`judge_args.py` builds its input); `tools/results_table.py` prints
the per-clip table for the report. Rows inside `timeline.gaps` (tracking lost) render black on purpose and are scored apart.
Reference numbers: the hotel room corner scores PSNR 19 / SSIM 0.88 from the recorded camera; gsplat's own held-out
PSNR is not comparable (it uses un-refined cameras and a mid-training checkpoint).

## 4. Files

`handoff.py` has the full list. The ones that matter outside the pod: `memory.json`, `input/audio.m4a`, `world/bg.spz`
(or `world/bg_points.ply`), `world/room_collider.glb`, `world/ghosts/*.bin` — exactly what `memreplay publish` copies.
ViPE's raw output (`vipe/`: depth zip, mask zip) is 60 MB–1 GB per clip and stays on the pod.

---

## 5. Runpod setup (once)

Pod: H100 80 GB, image `runpod/pytorch:1.4.1-cu1281-torch280-ubuntu2404`, 50 GB container disk, a network volume at
`/workspace` (100 GB is enough for 5 clips), TCP 22 exposed. Copy the repo to `/workspace/memory-replay` (rsync from a
laptop works; no push needed), put `export ANTHROPIC_API_KEY=...` in `/workspace/secrets.sh`, then:

```bash
tmux new -s setup
bash /workspace/memory-replay/pipeline/runpod/setup.sh base world vipe warmup
```

What setup learned the hard way (all handled in the scripts now):

- **CUDA must match torch (12.8).** A conda channel label alone loses to conda-forge's newest CUDA (we got 13.4 + gcc 15);
  `setup.sh` pins `cuda-version=12.8` and checks nvcc.
- **ViPE must build with uv's own Python** (`UV_PYTHON_PREFERENCE=only-managed` in `env.sh`); the image's Debian Python
  splits `pyconfig.h` where conda's compiler can't find it.
- **ninja** makes the CUDA builds parallel. ViPE builds in ~10 min. **gsplat's three world-space batch rasterizer files take
  over 2 hours** with CUDA 12.8 for three GPU types (the rest of gsplat takes ~20 min). For an H100-only pod, set
  `TORCH_CUDA_ARCH_LIST="9.0"` before `setup.sh world` to cut that by about 3x.
- The network volume is NFS: chown fails (harmless), small-file creation is slow (~4 ms/file).
- `/root/.ssh` is wiped on stop, and the SSH port changes on every restart.
- The Linux `opencv-python-headless` 5.0 wheel has no EXR codec; depth is read with `OpenEXR`.

After every restart: `bash /workspace/memory-replay/pipeline/runpod/on_start.sh`.

Look at ViPE's own result: `use vipe && cd $SRC/vipe && uv run vipe visualize $W/vipe`, then read the `http://<pod-ip>:<port>`
line it prints (it listens on the pod's internal address, not localhost) and tunnel to it:
`ssh -N -L 20540:<pod-ip>:<port> -p <ssh-port> root@<ip>`.

---

## 6. Worker (upload → pipeline → ready)

`memreplay worker` polls SpacetimeDB for `memory` rows with `status = 'uploaded'` assigned to this worker, downloads
`sourceUrl`, runs every step (reporting progress after each, which only goes up), publishes the viewer files and marks
the row `ready` with the public `memory.json` URL — or `failed` with the error. It uses the same env names as
`server/upload/.env.example`: `STDB_HTTP_URL`, `STDB_DATABASE`, `PIPELINE_TOKEN`, `PIPELINE_IDENTITY`, and either the
bucket (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ASSET_BASE_URL`) or
`MEMREPLAY_PUBLISH_DIR` + `MEMREPLAY_PUBLIC_BASE_URL`. The pod must reach SpacetimeDB at a public URL. Keep the memory
row's `durationUs` equal to `timeline.durationSec`.

The worker downloads only URLs the upload service issued (`memreplay/source_check.py`). To report a status by hand,
use `python3 pipeline/memreplay/status.py <memory id> <processing|ready|failed> --progress <0-1>` with the same
environment. Running the worker on Runpod, end to end: [docs/deployment.md](../docs/deployment.md).

---

## 7. Costs and licenses

H100 Secure Cloud ≈ $3–4/h; a full setup is ~1 h (mostly gsplat's build), each clip ~2–35 min of ViPE plus ~4 min of
splat training. Stop the pod when idle; `/workspace` survives.

| Tool                               | License                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| ViPE                               | Apache 2.0 (its UniK3D backend is BY-NC-SA and not used; track-anything code is AGPL-3.0) |
| gsplat                             | Apache 2.0                                                                                |
| Grounding DINO / SAM (inside ViPE) | Apache 2.0                                                                                |
