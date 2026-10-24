# Vision pipeline runbook

**One video in, one `memory.json` out.** A phone or Ray-Ban Meta clip becomes a scene you can walk into: the room as a
Gaussian splat, people as moving point "ghosts", the wearer's head path, and the small props as grabbable objects with
physics. The format is [`packages/shared/src/manifest.ts`](../packages/shared/src/manifest.ts); the files between steps
are in [`memreplay/handoff.py`](memreplay/handoff.py).

Status (Oct 24): **built and run end to end on all five sample clips** (`data/samples`, iPhone footage). Results,
measurements and limitations: [docs/VISION_PIPELINE_REPORT.md](../docs/VISION_PIPELINE_REPORT.md).

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
height). `run` skips finished steps; `--redo world` reruns world and downstream steps, `--force` all. Old outputs from
before motion-aware prop separation automatically rerun objects, background and layers. Each step also runs alone:
`memreplay stage <normalize|nouns|vipe|world|l0|objects|background> --work <dir>`.

Many clips at once, GPU kept busy (ViPE back to back while the other steps follow): `bash pipeline/runpod/batch.sh $WORK/a $WORK/b ...`
(titles from `<work>/title.txt`, device from `<work>/device.txt`).

On a laptop (no GPU): S1 runs anywhere with ffmpeg, and S3–S5, S7 and `verify` run on a copied work dir:
```bash
python3.12 -m venv .venv && source .venv/bin/activate && pip install -e "pipeline[claude,test]"
memreplay stage normalize --work data/work/kitchen --eye-height 1.35
cd pipeline && python -m pytest -q tests        # synthetic scene with known answers: S3-S7 + formats
```

Viewer: copy the published folder to `apps/web/public/memories/<id>/` and open
`/?memory=/memories/<id>/memory.json` (`LOCAL_HTTP=1 VITE_PORT=5177 npm run dev -w apps/web` for plain http).

### The static walk-through (start here)
The room alone, as a high-quality splat you walk through on the Quest: no people, objects or timeline.
```bash
memreplay stage objects --work $W                  # classify props before training
memreplay stage background --static --work $W      # stationary props stay; moving props and people are masked
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

| Step | Code | What it does | Writes |
|---|---|---|---|
| S1 normalize | `normalize.py` | Upright (applies the phone's rotation), constant 30 fps, long side 1280 px, H.264. **iPhone HDR** (HLG, BT.2020) is tone-mapped to SDR with a generated 3D LUT (ffmpeg `lut3d`; neither ffmpeg build has zscale). Audio to AAC. | `input/clip.mp4`, `input/audio.m4a`, `input/frames.json`, `capture.json` |
| S1 nouns | `claude.py` | Claude looks at an 8-frame contact sheet and lists the small movable props, one word each (ViPE's prompts; `person` and `hand` always). Fallback: generic props. | `nouns.json` |
| S2 ViPE | `cli.run_vipe` | NVIDIA ViPE `pipeline=default` (commit `8c9f361`): camera path, intrinsics, metric z-depth for every pixel, instance masks. Detection every 0.5 s (`kf_gap_sec`, default 2 s). | `vipe/` |
| S3 world | `world.py` | Meters, +Y up, floor at 0, wearer starting at the origin looking down −Z. Details below. | `world/world.json`, `world/cameras.json`, `world/frames.npz` |
| S5 select | `objects.observe/select` | Per mask id and keyframe: 3D position, extent, silhouette, sharpness. Splits ids where they jump impossibly (ViPE's tracker hops between look-alikes), joins re-detections, then Claude sees the best crop and says shape, size, density, colour, **grabbable** and **movable** (free-standing vs mounted). Only small, grabbable, free-standing props are kept. | `objects/observations.json`, `objects/selection.json`, `objects/crops/` |
| S4 room | `l0.py` | Room points: static pixels of ~360 frames, 2 cm voxels kept if seen in ≥ 2 frames, ≤ 300k, as small splats. People, hands and kept props are cut out; signs, benches and other segmented fixtures stay in the room. Collider: 10 cm heightfield (90th percentile below 1.2 m, so seats and tables count) plus 2.2 m wall columns. Ghosts: each person's pixels per keyframe, back-projected, in one binary per person (`points-sequence`). | `world/bg_points.ply`, `world/room_collider.glb`, `world/ghosts/*.bin`, `world/ghosts.json` |
| S5 objects | `objects.run` | 10 Hz tracks: Hampel outliers, Savitzky-Golay smoothing, velocity, ballistic arc only through gaps that start as a throw, rests frozen in place. An object that never moved is held at the median of its whole (not edge-cut) views. Bottoms snapped onto the collider at rest. Primitive visual + matching collider, mass = density × volume. | `objects/objects.json`, `objects/report.json` |
| S6 splat | `background.py`, `train_splat.py` | gsplat MCMC (7.5k steps, ≤ 300k Gaussians) on our world-frame cameras, seeded from the room points, with **people and props masked out of the loss** (gsplat's loader only has per-camera masks; `train_splat.py` adds per-image masks, then runs `simple_trainer.py` unchanged). Then `splat-transform` → `.spz`. | `world/bg.spz` |
| S7 merge | `cli.merge` | Everything → validated `memory.json` (prefers `bg.spz` over the points). | `memory.json` |
| verify | `verify.py` | Room points rendered from the recorded cameras vs the real frames; floor flatness; each object's track projected into the frames where ViPE saw it (inside its mask?); a pause-and-drop physics test; a top-down map. | `verify/report.json`, `verify/*.jpg`, `verify/map.png` |

**Prop motion and extraction.** S5 writes one `motion` classification per kept prop to `objects/report.json`.
It uses the existing world-position spread and sustained-excursion checks; this is a heuristic, so inspect the
classification on real footage. Both room training and extraction use that same decision.

- Stationary props remain in static-room training. S6b extracts their splats only when at least 50 Gaussians pass
  the multi-view mask vote. The old bounding-box fallback is removed.
- Moving props are masked out of room training and retain their primitive visual, collider and recorded track.
  They are not carved out of the static splat. Training stops if masks needed to exclude them are missing.
- Failed stationary extraction leaves the prop in the room and removes its separate object from `memory.json`.
  It is not grabbable; there is no second primitive covering the baked appearance.
- `objects/objects.base.json` preserves the original tracked objects so extraction can be retried. The final
  `objects/objects.json` contains only moving props and successfully extracted stationary props.
- `world/background_policy.json` records the moving mask IDs excluded by successful static training. Layers
  reject older or mismatched backgrounds. Rerun `memreplay run $W` to regenerate affected assets, then publish again.

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

---

## 3. Recording tips (what made the sample clips easy or hard)

- **Walk sideways while panning** (parallax); turning on the spot gives ViPE nothing to triangulate.
- Keep the camera at **one height**; S3 uses that to tell the floor from tables.
- **Slow turns, no close-up of blank or dark walls**: that is where ViPE lost tracking in the lobby.
- **Props**: free-standing, compact things (bottles, kettles, pillows, boxes). Wall-mounted things stay part of the room.
- Under 30 s is plenty; ViPE runs at about 2 frames/s on an H100 (a 2½-minute walk took 34 min).
- Glasses footage (ultrawide, SDR) needs no tone mapping; if lines look bent, undistort first (ViPE's default assumes a pinhole).

---

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

---

## 7. Costs and licenses

H100 Secure Cloud ≈ $3–4/h; a full setup is ~1 h (mostly gsplat's build), each clip ~2–35 min of ViPE plus ~4 min of
splat training. Stop the pod when idle; `/workspace` survives.

| Tool | License |
|---|---|
| ViPE | Apache 2.0 (its UniK3D backend is BY-NC-SA and not used; track-anything code is AGPL-3.0) |
| gsplat | Apache 2.0 |
| Grounding DINO / SAM (inside ViPE) | Apache 2.0 |
