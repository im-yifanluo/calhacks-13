# Vision pipeline runbook

**One glasses clip goes in. One `memory.json` comes out.** One person runs the whole pipeline. This page covers:
- the input and the output;
- what each step does, its tool, and how to run it;
- how to set everything up on Runpod.

The reasons behind the design are in [docs/PLAN.md §2.2](../docs/PLAN.md). The file formats between steps are in [`memreplay/handoff.py`](memreplay/handoff.py).

Commands marked **verified** come from each tool's own README or source code, checked on Oct 23–24. Nothing here has run on a real pod or real glasses footage yet, so expect small fixes the first time.

**Tonight, in this order:**
1. §6 Runpod setup (~1 h).
2. §8 go/no-go: S0 record, S1 normalize, S2 ViPE.
3. Write S3, then S4, as `memreplay stage world|l0` in `pipeline/memreplay/cli.py`. Today those are stubs that print "not written yet" and exit 1.
4. S7 merge, which gives you **L0**.

Only S1 (a pasteable snippet), S2 (ViPE) and S7 (merge) run today. The times in §7 are run times, not coding times.

**Demo levels.**
- **L0** is the room, the people ghosts and the head path: you can walk into the memory. Goal: about 6 hours in.
- **L1** adds grabbable objects: pause, grab, throw. Goal: by morning.
- Everything after L1 is polish.

---

## 1. Input: what the glasses give us

- **One video file**, exported through the Meta AI app to a phone:
  - **Format:** HEVC `.mov` on iPhone, `.mp4` on Android.
  - **Picture:** portrait 3:4, from a 12 MP ultrawide camera.
  - **Modes:** 3K at 30 fps, 1080p at 30 or 60 fps, or 720p at 120 fps. Clips run up to 3 minutes.
  - **Audio:** there's an audio track.
- **One camera, so no stereo.** The second opening on the front is the recording light. And even if there were two cameras, the exported video is a single view.
  - **Depth from motion:** as the wearer moves, ViPE triangulates the same points across frames (structure from motion).
  - **Depth from a model:** a depth network fills in every pixel and sets real-world scale.
  - **What the file doesn't have:** no depth, no camera position, no motion-sensor data, no lens model. All of it is inferred.
- **Optional live stream** (Meta's Device Access Toolkit): at most 720×1280 over Bluetooth. Too low quality to rebuild from; a stretch goal for a "live" moment only.
- **What we add when recording** (this matters a lot):
  - **Settings:** 1080p at 30 fps, **stabilization off**.
  - **Script:** look at the floor for 3 s, then **walk 2–3 m sideways while slowly panning** across the room, then the action. Under 30 s; 3 takes. Turning your head in place gives ViPE no parallax, so depth would come only from the depth model.
  - **People:** one person in frame; slow head motion.
  - **Props:** 2–3 symmetric, brightly coloured objects (ball, can, bottle), moved or thrown by someone else.
  - **Measure the wearer's eye height.**
  - **Optional:** film a checkerboard on a laptop screen for 15 s, used only if the lens needs fixing.

## 2. Output: what the viewer needs

One `memory.json` (format: [`packages/shared/src/manifest.ts`](../packages/shared/src/manifest.ts)). Everything is in meters, +Y up, floor at y = 0.

| # | Part | File | Notes |
|---|---|---|---|
| 1 | Room you see | `world/bg_points.ply` (L0), then `world/bg.spz` | ≤ 300k splats so the Quest keeps 72 fps |
| 2 | Room you collide with | `world/room_collider.glb` | Floor and tables as a 10 cm heightfield, so thrown things land on tables |
| 3 | Head path | in `memory.json` | Camera at 10 Hz, plus field of view |
| 4 | People | `world/ghosts/<id>.bin` | Coloured points per frame, not grabbable |
| 5 | Grabbable objects | in `memory.json` | Tinted sphere, box or cylinder; collider; mass; position at 10 Hz with velocity |
| 6 | Audio | `input/audio.m4a` | Played in sync with the timeline |

## 3. The pipeline at a glance

```
clip.mov ─► S1 Normalize ─► S2 ViPE ─► S3 World frame ─► S4 L0 export ─► S7 Merge ─► memory.json  (L0)
                                                      └─► S5 Objects ───► S7 Merge ─► memory.json  (L1)
                                                      └─► S6 Background splat (overnight) ─► S7 Merge
```

| Step | Tool | What it does | Writes | Env | Our code |
|---|---|---|---|---|---|
| S0 Record | the glasses | Scripted clip and eye height | `clip.mov` | — | — |
| S1 Normalize | ffmpeg | Upright, constant 30 fps, 1280 px; splits off the audio; lists the prompts | `input/`, `nouns.json` | `world` | small (snippet below) |
| S2 Cameras, depth, masks | **NVIDIA ViPE** | Head path, lens, metric depth for every pixel, per-frame masks with object IDs | `vipe/` | `vipe` | tool only |
| S3 World frame | numpy + open3d | Finds "up" and the floor; puts everything in meters with the floor at 0 | `world/world.json`, `world/cameras.json` | `world` | to write |
| S4 L0 export | numpy + trimesh | Room points, room collider, people ghosts | `world/` | `world` | to write |
| S5 Objects | numpy + Claude | Object positions over time; Claude picks each object's shape, size and mass | `objects/` | `world` | to write |
| S6 Background splat | gsplat | A sharper room splat, trained overnight | `world/bg.spz` | `world` | to write (patch) |
| S7 Merge | `memreplay merge` | Combines everything and checks it | `memory.json` | `world` | **done** |

**Frame numbering.** Frame `i` is the `i`-th frame of `input/clip.mp4`, and ViPE uses the same numbers. Every 3rd frame is a keyframe, which gives 10 Hz for tracks, ghosts and the head path.

**Cut on purpose:**
- **SAM 3 / 3.1:** access approval plus a clashing environment.
- **SAM 3D:** half a day of installs.
- **FoundationPose.**
- **Full 4D splatting.**
- **VGGT and Depth Anything 3 as the camera solver:** they assume nothing moves.

The upgrades in section 5 cover the gaps if there's time.

---

## 4. Each step in detail

Every new shell on the pod starts with:
```bash
source /workspace/memory-replay/pipeline/runpod/env.sh    # defines $WORK, $SRC, $ENVS and the `use` command
W=$WORK/kitchen                                          # one folder per memory; put clip.mov in it
```

### S0 · Record
Follow the script in section 1. Copy the clip to the pod:
```bash
ssh -p <port> root@<ip> mkdir -p /workspace/work/kitchen
rsync -avP -e "ssh -p <port>" <exported-file> root@<ip>:/workspace/work/kitchen/clip.mov   # always name it clip.mov; ffmpeg reads the container, not the extension
ssh -p <port> root@<ip> "echo '{\"eye_height_m\": 1.65}' > /workspace/work/kitchen/capture.json"   # the wearer's measured eye height; S3 reads it
```

### S1 · Normalize (env `world`; to write: `memreplay stage normalize --work $W`; until then paste the snippet below)
**What it does.**
- Rotates the video upright (ffmpeg applies the phone's rotation flag when decoding).
- Forces a constant 30 fps.
- Scales the long side to 1280 px.
- Splits off the audio.
- Records the frame count and size.

```bash
use world && cd $W && mkdir -p input
ffmpeg -i clip.mov -vf "fps=30,scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'" -an -c:v libx264 -crf 14 -pix_fmt yuv420p input/clip.mp4
ffmpeg -i clip.mov -vn -c:a aac -b:a 128k input/audio.m4a
python - <<'EOF'
import json, subprocess
from memreplay.handoff import FramesInfo
s = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", "input/clip.mp4"]))["streams"][0]
n = int(s["nb_read_frames"])
open("input/frames.json", "w").write(FramesInfo(source="clip.mov", width=s["width"], height=s["height"],
                                                frame_count=n, duration_sec=n / 30).model_dump_json(indent=2))
EOF
echo '{"nouns": ["person", "hand", "ball", "can", "bottle"]}' > nouns.json   # single words; always keep person and hand
```

### S2 · Cameras, depth and masks with ViPE (env `vipe`)
**What it does.** ViPE finds the named things in every frame and ignores them when it works out the camera path. It writes:
- the head path for every frame;
- the lens settings;
- metric depth for **every** pixel, people and objects included;
- a mask image per frame, with an ID for each person and object.

**Run** (**verified**; `run.py` is the only way to set the prompts):
```bash
use vipe && cd $SRC/vipe
uv run python run.py pipeline=default streams=raw_mp4_stream \
  streams.base_path=$W/input/clip.mp4 streams.frame_end=-1 \
  pipeline.output.path=$W/vipe pipeline.output.save_artifacts=true \
  "pipeline.init.instance.phrases=[$(python3 -c "import json;print(','.join(json.load(open('$W/nouns.json'))['nouns']))")]"
```

**What it writes** in `$W/vipe/` (`<name>` = `clip`; readers are in `vipe.utils.io`):

| File | Contents |
|---|---|
| `pose/clip.npz` | `data` (N,4,4) camera-to-world, OpenCV axes (x right, y down, z forward); `inds` frame numbers |
| `intrinsics/clip.npz` | `data` (N,4) `[fx, fy, cx, cy]` |
| `depth/clip.zip` | one float16 EXR per frame, metric, every pixel |
| `mask/clip.zip` | one PNG per frame, pixel value = instance ID (0 = static) |
| `mask/clip.txt` | `id: phrase` for each ID, including `sky` |

**Look at it:**
1. On the pod, in a new tmux window (Ctrl-b c): `source /workspace/memory-replay/pipeline/runpod/env.sh; W=$WORK/kitchen; use vipe && cd $SRC/vipe && uv run vipe visualize $W/vipe`. It runs until you stop it.
2. On your laptop, run `ssh -L 20540:localhost:20540 -p <port> root@<ip>`.
3. Open http://localhost:20540.

**Check (verified from ViPE's source):**
- **Prompts:** our list replaces ViPE's default one, which is why `person` and `hand` are always in it.
- **IDs:** an object keeps its ID while ViPE tracks it. If it's lost and found again, it gets a new ID, and S5 joins those back up.
- **Depth includes everything,** people and sky too. S4 removes them for the room.
- **Feed it the mp4,** not a folder of images, so it reads the real frame rate.
- **Use the `default` preset.** `wide_angle` and `pose_only_long` write **no depth**.
- **The two `run.py` settings matter:** without `streams.frame_end=-1` it stops at 1000 frames, and without `save_artifacts=true` it writes nothing.
- **Depth details (unverified):**
  - Check that each depth EXR is the same size as `input/clip.mp4`; resize with nearest-neighbour if not.
  - Check that the floor comes out flat. If it bends, the values are distance along each ray, not straight-ahead depth.

**If it fails**, in order:
1. If straight lines look bent, fix the lens with the checkerboard (`cv2.calibrateCamera`, then `cv2.undistort` on `input/clip.mp4`) and rerun.
2. Compare the camera path with `use vipe && cd $SRC/vipe && uv run vipe infer $W/input/clip.mp4 -p wide_angle -o $W/vipe_wide` (poses only).
3. Try MapAnything (`facebook/map-anything-apache` weights).
4. Try MegaSaM.

### S3 · World frame (env `world`; to write: `memreplay stage world --work $W`)
**What it does.** Moves everything into one world frame: meters, +Y up, floor at y = 0.
1. **Find "up":** the average of the cameras' up directions. The camera's up is the negative of its y axis in OpenCV terms.
2. **Find the floor:** with open3d, fit a plane to static depth points (mask ID 0) from every 10th frame:
   ```python
   pcd.segment_plane(distance_threshold=0.02, ransac_n=3, num_iterations=1000)
   ```
   Only accept a plane whose normal is within 15° of "up", and take the lowest one; otherwise tabletops win.
3. **Build the transform:** rotate the floor normal onto +Y and shift the floor to y = 0.
4. **Scale:** trust ViPE's metric depth (`scale = 1.0`). Compare the median head height with the wearer's eye height from `capture.json`. If they differ by more than 20%, set `scale = eye_height / median_height`.
5. **Write** `world/world.json` and `world/cameras.json` (keyframes only, already in the world frame).

**If it fails:** pick 3 floor points by hand in the ViPE viewer.

### S4 · L0 export (env `world`; to write: `memreplay stage l0 --work $W`)
**What it does.** Builds the first walkable memory.
- **Room points:**
  1. From every 3rd frame, keep pixels with mask ID 0, which also drops sky because sky gets its own ID. Also drop anything deeper than 8 m.
  2. Back-project them to world points.
  3. Thin them to a 2 cm grid, keeping at most 300k points.
  4. Write them as small round splats in `world/bg_points.ply`:
     - fields `x y z f_dc_0..2 opacity scale_0..2 rot_0..3`;
     - `f_dc = (rgb/255 − 0.5) / 0.28209`;
     - `scale = log(0.01)`; `opacity` = logit of 0.9.
  5. Set `bgPointsCount` in `world/world.json` to the number written; merge copies it into `background.splatCount`.
- **Room collider:**
  1. Lay a 10 cm grid over the floor.
  2. Each cell's height is the 90th-percentile height of the room points below 1.2 m in it, so tables count. Empty cells stay at 0.
  3. Turn the grid into a mesh with `trimesh` and save `world/room_collider.glb`.
- **People ghosts:** for each `person` ID, at each keyframe:
  1. Shrink the mask by 5 px.
  2. Drop pixels at depth edges, where depth jumps more than 10 cm to a neighbour.
  3. Back-project, keep at most 15k points, and keep their colours.
  4. Write each person with `write_points_sequence()` from `handoff.py` to `world/ghosts/<id>.bin`. The positions are already in world meters.
     - **One block per keyframe of the whole clip.** Frame k is at t = k / 10 s; frames where the person isn't visible have 0 points.
     - **List each person in `world/ghosts.json`** with:
       - `visual: {kind: "points-sequence", url: "world/ghosts/<id>.bin", frameCount, sampleHz: 10}`;
       - `grabbable: false`, `mass: 0`;
       - a `capsule` collider (`halfHeight: 0.6, radius: 0.25`);
       - `visibleFrom` and `visibleTo` from the masks;
       - an identity track `[{t: 0, p: [0,0,0], q: [0,0,0,1]}]`.
- **Then:** `memreplay merge $W --title "Kitchen"`. This is the **L0 demo**.

**If it fails:** use 5k points and every 2nd keyframe for ghosts; skip the room collider (things only land on the floor).

### S5 · Objects (env `world`; to write: `memreplay stage objects --work $W`)
**What it does.** Turns each moving object into something you can grab.
1. **Group IDs.** Take every mask ID whose phrase isn't `person`, `hand` or `sky`. Join IDs with the same phrase whose 3D positions are within 0.3 m and whose time ranges don't overlap; those are re-detections of the same object.
2. **Track position.** At each keyframe:
   - Take the object's world points: shrunk mask, depth-edge filter.
   - Its position is their median.
   - Smooth the positions with Savitzky-Golay (window 7, order 2).
   - Velocity `v` in m/s: `(p[k+1] − p[k−1]) / (t[k+1] − t[k−1])` on the smoothed positions, one-sided at the first and last keyframe.
   - Rotation stays fixed. That's correct for symmetric props.
3. **Ask Claude what it is.** Crop the frame where the object's mask is biggest and sharpest into `objects/crops/<id>.jpg`, then send the crop and the label to Claude (snippet below). It returns a shape, size, density, colour and whether it's grabbable.
4. **Sanity-check and finish.**
   - **Size:** keep Claude's size within 0.5–2× of the largest extent we actually saw.
   - **Mass:** density × volume.
   - **Write** `objects/objects.json` with:
     - a `primitive` visual;
     - a matching `sphere`, `box` or `cylinder` collider;
     - the track, with `v` on every keyframe.
5. **Then** merge again. This is the **L1 demo**.

**Claude call** (Anthropic SDK; `ANTHROPIC_API_KEY` in `/workspace/secrets.sh`):
```python
import anthropic, base64
from memreplay.handoff import ObjectSpec

def describe(crop_path: str, label: str) -> ObjectSpec:
    schema = {"type": "object", "additionalProperties": False,
              "required": ["label", "shape", "size_m", "density_kg_m3", "color", "grabbable"],
              "properties": {"label": {"type": "string"},
                             "shape": {"type": "string", "enum": ["sphere", "box", "cylinder"]},
                             "size_m": {"type": "array", "items": {"type": "number"}},
                             "density_kg_m3": {"type": "number"},
                             "color": {"type": "string"},
                             "grabbable": {"type": "boolean"}}}
    img = base64.standard_b64encode(open(crop_path, "rb").read()).decode()
    prompt = (f"This crop shows a '{label}' from a first-person video. Pick the simple shape that best "
              "approximates it for a physics engine (sphere, box, or cylinder with a vertical axis), its full "
              "size in meters as [x, y, z] (y is up), a realistic average density in kg/m3, its main colour "
              "as #rrggbb, and whether a person could pick it up.")
    resp = anthropic.Anthropic().beta.messages.create(
        model="claude-opus-5-5", max_tokens=16000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",   # retries on another model if declined
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img}},
            {"type": "text", "text": prompt}]}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError(f"declined: {resp.stop_details}")
    return ObjectSpec.model_validate_json(next(b.text for b in resp.content if b.type == "text"))
```

**If it fails:** write `objects.json` by hand. Two objects take 5 minutes.

### S6 · Background splat (env `world`; overnight)
**What it does.** Trains a proper Gaussian splat of the room. It starts from the L0 points and ignores every masked pixel, so people and props don't smear.

**Prepare** (to write: `memreplay stage background --work $W`). It writes `$W/colmap/`:
- `images/`: the keyframes as full-size JPGs.
- `masks/`: one PNG per image, **white = static**; this is ViPE's mask ID 0.
- `sparse/0/`:
  - `cameras.txt` (`PINHOLE fx fy cx cy`);
  - `images.txt` with **world-to-camera** poses, quaternion `QW QX QY QZ`, then an empty second line;
  - `points3D.txt` seeded from `bg_points.ply`.

**Patch gsplat** (`examples/datasets/colmap.py`, `Dataset.__getitem__`): load `masks/<stem>.png` and set `data["mask"] = torch.from_numpy(m > 127)`. The `main` branch already drops masked pixels from the loss.

**Train and convert** (gsplat and splat-transform flags **verified** from their docs and scripts):
```bash
use world && cd $SRC/gsplat/examples
python simple_trainer.py mcmc --data_dir $W/colmap --data_factor 1 --result_dir $W/gsplat \
  --strategy.cap-max 300000 --steps_scaler 0.25 --save_ply \
  --app_opt --pose_opt --disable_viewer --eval_steps -1 --no-normalize-world-space
splat-transform $W/gsplat/ply/point_cloud_7499.ply --filter-nan --decimate 300000 $W/gsplat/bg_300k.ply
splat-transform -w $W/gsplat/bg_300k.ply $W/world/bg.spz
```
Then set `bgSplatCount` in `world/world.json` and merge again. Merge picks `bg.spz` over the points automatically.

**Watch out.**
- **`normalize_world_space` must be off,** or the splat lands in a different frame. Confirm the flag spelling with `python simple_trainer.py mcmc --help | grep normalize`.
- **Step count:** `--steps_scaler 0.25` gives about 7.5k steps and scales the refinement schedule to match. The last PLY is `point_cloud_<steps−1>.ply`, so check `ls $W/gsplat/ply`.
- **Orientation:** if the splat shows up upside down, add `-r 180,0,0` to the convert step.

**If it fails:** keep the L0 points; or try Brush (`brush $W/colmap --max-splats 300000 --total-steps 7500 --export-path $W/brush`).

### S7 · Merge (env `world`; **done** and tested)
```bash
memreplay merge $W --title "Kitchen"
```

It combines `input/`, `world/` and `objects/`:
- **Background:** uses `bg.spz` if it exists, otherwise `bg_points.ply`.
- **Extras:** adds the room collider and audio when present.
- **Stops** on duplicate IDs, missing cameras (run S3) or no background yet (run S4).
- **Warns** about a background over 350k splats, or objects below the floor.

---

## 5. Upgrades (only after L1 works)

| Upgrade | When it's worth it | Install | Tool |
|---|---|---|---|
| Object rotation | A prop isn't symmetric (a book, a shoe) | `bash setup.sh extras` (into `world`) | CoTracker3 follows points on the object, lifted to 3D with ViPE depth; a RANSAC Kabsch fit per frame gives the rotation |
| Better masks | ViPE's masks miss or bleed | `bash setup.sh extras` | SAM 2.1 with a box from Grounding DINO (no access approval needed) |
| Real object shapes | Everything else is done | `bash setup.sh sam3d sam3d_weights` (gated; half a day) | SAM 3D Objects |

**CoTracker3** (**verified** from its repo):
```python
cotracker = torch.hub.load("facebookresearch/co-tracker", "cotracker3_offline").cuda()
tracks, vis = cotracker(video, grid_size=40, segm_mask=torch.from_numpy(mask_t0).float()[None, None].cuda(),
                        grid_query_frame=t0, backward_tracking=True)
# mask_t0 (H,W) bool mask of frame t0; video (1,T,3,H,W) 0-255; tracks (1,T,N,2) pixels; vis (1,T,N).
# Run ~200-frame windows: memory grows with T.
```

---

## 6. Set up Runpod (once)

### 6.1 Accounts
- **Anthropic API key** for S5.
- **Runpod account:** ask the Runpod booth about credits. Add your SSH **public** key under Account Settings → SSH public keys.
- **Hugging Face:** only needed for the SAM 3D stretch.

### 6.2 Storage and pod
1. **Storage → New Network Volume:** Secure Cloud, a datacenter with H100s, **200 GB**. Everything lives here and survives restarts.
2. **Pods → Deploy:**
   - **GPU:** H100 80 GB. Secure Cloud, because Community Cloud can't attach volumes.
   - **Network volume:** attach yours. This only works at deploy time.
   - **Image:** `runpod/pytorch:1.4.1-cu1281-torch280-ubuntu2204`.
   - **Ports:** leave TCP 22 exposed.
3. **Connect:** on the pod page, open **Connect → Direct TCP Ports** for the IP and port, then run `ssh root@<ip> -p <port> -i ~/.ssh/id_ed25519`. The port changes on every restart. The proxy SSH address can't do `scp` or `rsync`.

### 6.3 Repo and secrets
Make sure the latest commits are pushed to GitHub; the pod clones `main`.
```bash
apt-get update -qq && apt-get install -y -qq git tmux rsync
cd /workspace && git clone https://github.com/im-yifanluo/calhacks-13.git memory-replay
# private repo: use https://<github-token>@github.com/im-yifanluo/calhacks-13.git
cd memory-replay && git log -1 --oneline && ls pipeline/runpod/setup.sh pipeline/memreplay/handoff.py   # both must exist; if not, push first
cat > /workspace/secrets.sh <<'EOF'
export ANTHROPIC_API_KEY=sk-ant-...
# export HF_TOKEN=hf_...          # uncomment ONLY for the SAM 3D stretch; a fake token makes public downloads fail
EOF
chmod 600 /workspace/secrets.sh
```
Replace `sk-ant-...` with the real key before running anything.

### 6.4 Install
```bash
tmux new -s vision                                                      # reconnect later: tmux attach -t vision
bash /workspace/memory-replay/pipeline/runpod/setup.sh base world vipe warmup
```
`warmup` runs ViPE on a 2-second test video so all its weights download now, including one from Google Drive that can get rate-limited later. It ends with "ViPE warmup OK" or a warning saying what to do. Expect 30–60 minutes in total, mostly CUDA builds (estimate). A failed target can be rerun: finished steps are skipped.

| Env | For | Python / torch / CUDA |
|---|---|---|
| `world` | S1, S3–S7: our `memreplay` code, ffmpeg 6, gsplat, open3d, Claude SDK, splat-transform (plus SAM 2.1 and CoTracker3 after `extras`) | 3.12 / 2.9.1 / 12.8 |
| `vipe` | S2: ViPE. Its packages live in `$SRC/vipe/.venv`; run with `uv run` | 3.12 / cu128 build / 12.8 |
| `sam3d` (stretch) | SAM 3D Objects | 3.11 / 2.5.1 / 12.1 |

### 6.5 After every pod restart
```bash
bash /workspace/memory-replay/pipeline/runpod/on_start.sh    # tmux, rsync and git are wiped on stop
source /workspace/memory-replay/pipeline/runpod/env.sh
```

---

## 7. Run one clip end to end

| Order | Step | Env | Time (estimate) | Demo after it |
|---|---|---|---|---|
| 1 | S1 Normalize | `world` | 2 min | — |
| 2 | S2 ViPE | `vipe` | 5–15 min | go/no-go |
| 3 | S3 World frame | `world` | 1 min | — |
| 4 | S4 L0 export, then S7 merge | `world` | 5 min | **L0** |
| 5 | S5 Objects, then S7 merge | `world` | 5 min | **L1** |
| 6 | S6 Background splat, then S7 merge | `world` | 15–25 min | L1, sharper room |

**Get it into the viewer.** Run this from the repo root on your laptop. It copies only what the viewer loads; frames, depth and checkpoints stay on the pod:
```bash
rsync -avP -e "ssh -p <port>" --include='memory.json' --include='input/' --include='input/audio.m4a' \
  --include='world/' --include='world/bg_points.ply' --include='world/bg.spz' --include='world/room_collider.glb' \
  --include='world/ghosts/***' --exclude='*' \
  root@<ip>:/workspace/work/kitchen/ apps/web/public/memories/kitchen/
# open http://localhost:5173/?memory=/memories/kitchen/memory.json
```
`apps/web/public/memories/` is git-ignored.

## 8. Go/no-go test (first 3 hours)

The test answers one question: does ViPE give a usable camera path and depth on glasses footage?
1. Record a test clip with the script from section 1, then run S1 and S2.
2. Open the ViPE viewer (the "Look at it" steps in S2).

It passes if:
- **the floor points form one flat sheet,** not a bowl or a ramp;
- **the cameras look about head height above the floor** (a rough visual check; the exact number is `median_camera_height_m` in `world/world.json` once S3 exists);
- **two frames 3 s apart line up:** walls and furniture land on one surface, not two shifted copies;
- **straight edges** (door frames, table edges) **look straight.**

If it fails, go down the S2 fallbacks in order.

## 9. What the viewer must support (for P3)

> **Status:** the viewer engine is on Nikko's branch (`origin/nikko`). It doesn't support any of the items below yet, and it doesn't compile against this scene format until they're added. Nobody has built the **pipeline worker** yet either. It takes an uploaded video from Jerry's upload service, runs S1–S7, publishes the files and marks the memory `ready` with `scripts/pipeline-status.py` (on `origin/stdb/jerry-p4`). See [docs/INTEGRATION.md](../docs/INTEGRATION.md) §2 A and §4.

These are new in `memory.json`, and `apps/web` doesn't handle them yet:
- **`points-sequence` ghosts:** read the binary (layout in `handoff.py`) and draw each frame with `THREE.Points`, using a `Float16BufferAttribute` for positions and a `Uint8` colour attribute.
- **`primitive` objects:** a tinted sphere, box or cylinder mesh.
- **Rapier physics:**
  - colliders: sphere, box and cylinder for objects, and a trimesh collider from `background.colliderUrl` for the room;
  - on pause, give each body the velocity `v` from its current keyframe.
- **Audio:** an `<audio>` element on `source.audioUrl` that follows play, pause and seek, and resyncs if it drifts more than 100 ms.
- **Background format:** load `.ply` (L0) or `.spz`; Spark reads both.

## 10. Costs

| GPU | Price | Notes |
|---|---|---|
| H100, Secure Cloud | about $2.89/h | About $70 for 24 hours |
| L40S | $1.09/h | Can run everything; `env.sh` builds CUDA code for A100, L40S and H100 |

- **Stop the pod when idle.** `/workspace` survives; nothing else does.
- **If a restart comes back with 0 GPUs,** terminate and redeploy with the same network volume; nothing is lost.
- **No Docker inside pods.** Everything is installed with conda, pip or uv.

## 11. Licenses (fine for a hackathon demo; check before any commercial use)

| Tool | License |
|---|---|
| ViPE | Apache 2.0, except its UniK3D backend (BY-NC-SA, don't use) and its track-anything code (AGPL-3.0) |
| gsplat | Apache 2.0 |
| CoTracker3 (upgrade) | CC-BY-NC 4.0 |
| SAM 2.1 (upgrade) | Apache 2.0 |
| SAM 3D (stretch) | SAM License |
