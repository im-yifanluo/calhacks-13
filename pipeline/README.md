# Vision pipeline runbook (P1 + P2)

**One glasses clip goes in. One `memory.json` comes out.** This page says what each step does, which tool it uses, and how to run it on Runpod. The reasons behind the tool choices are in [docs/PLAN.md §2.2](../docs/PLAN.md). The exact file formats are in [`memreplay/handoff.py`](memreplay/handoff.py).

Commands marked **verified** were copied from each tool's own README on Oct 23. Nothing here has run on a real pod yet, so expect to fix small things the first time.

**Who's who.**
- **P1 = World** (S0, S3–S6, S9): the room, the camera path, the people, and the final merge.
- **P2 = Things** (S1, S2, S7, S8): everything you can grab.
- **P3** builds the Quest viewer (`apps/web`) and is the one who loads our output.

**Demo levels.**
- **L0** is what P1 can make alone: the room as a point cloud or splat, the people ghosts and the head path. Due Sat 2:30 AM.
- **L1** is L0 plus P2's grabbable objects.

**Eye height** is measured on the wearer when the clip is shot; S4 needs it to set real-world scale.

---

## 1. What we produce

`memory.json` describes one memory that the viewer can play:

- **The room:** one Gaussian splat of everything that doesn't move (`world/bg.spz`, at most 300k splats so the Quest keeps 72 fps).
- **The head path:** where the wearer's eyes were in every frame.
- **People:** a colored point cloud per frame ("ghosts"). You can't grab them.
- **Things you can grab:** for each object, a splat of the object, a simple collision shape, a mass, and its position and rotation 10 times a second.

Everything is in one world frame: **meters, +Y up, floor at y = 0**.

## 2. The steps at a glance

```
                              clip.mp4
                                 │
                       S0 Frames (P1, ffmpeg)
               ┌─────────────────┴──────────────────┐
     S1 Nouns (P2, Claude) ──phrases──►   S3 Cameras + depth (P1, ViPE)
     S2 Masks (P2, SAM 3)                 S4 World frame (P1)
               │ └─────────masks───────►  S5 Background (P1, gsplat)
               │                          S6 Ghosts (P1)
     S7 Objects (P2, SAM 3D)  ◄──cameras, depth, world frame──┘
     S8 Tracks (P2, CoTracker3)
               └─────────────────┬──────────────────┘
                       S9 Merge → memory.json
```

| Step | Owner | Tool | What it does | Writes | Env | Our code |
|---|---|---|---|---|---|---|
| S0 Frames | P1 | ffmpeg + OpenCV | Picks the sharpest frame in every 100 ms and straightens the lens | `frames/`, `frames.json` | `world` | to write |
| S1 Nouns | P2 | Claude (`claude-opus-5-5`) | Names the things that move, with size and weight | `nouns.json` | `core` | to write |
| S2 Masks | P2 | SAM 3.1 | Outlines every person, hand and object in every frame | `masks/` | `seg` | to write |
| S3 Cameras | P1 | NVIDIA ViPE | Finds where the head was and how far away everything is | `vipe/` | `vipe` | tool only |
| S4 World frame | P1 | open3d | Finds the floor, sets +Y up and real-world scale | `world/cameras.json`, `depth.npz`, `world.json` | `world` | to write |
| S5 Background | P1 | gsplat | Trains the room splat, ignoring anything that moves | `world/bg.spz` | `world` | to write (patch) |
| S6 Ghosts | P1 | numpy | Turns people into colored points per frame | `world/ghosts/` | `world` | to write |
| S7 Objects | P2 | SAM 3D Objects | Builds each object in 3D from one good frame | `objects/<id>/` | `obj` | to write |
| S8 Tracks | P2 | CoTracker3 | Follows each object's position and rotation over time | `objects/objects.json` | `seg` | to write |
| S9 Merge | P1 (anyone can run it) | `memreplay merge` | Combines everything and checks it | `memory.json` | `core` | **done** |

**Frame numbering rule.** S0 keeps only the sharp frames and names each one by its original index, always zero-padded to 5 digits (`frames/full/00042.jpg`, `masks/dyn/00042.png`). Tools like SAM and ViPE number frames by position in the folder instead (0, 1, 2…). **Position p always means the p-th kept frame in `frames.json`.** Convert positions back to `idx` before writing any handoff file.

---

## 3. Each step in detail

### S0 · Frames (P1, env `world`)

**What it does.** It decodes every frame with its real timestamp and keeps the sharpest one in each 100 ms window, which gives about 10 frames per second. If we filmed the checkerboard, it also straightens the ultrawide lens. ViPE then sees a normal (pinhole) camera and can produce depth, which its wide-angle mode does not.

**Run.** Every new shell needs `source /workspace/memory-replay/pipeline/runpod/env.sh` first; it defines `$WORK`, `$SRC` and the `use` command. Use the `world` env, because its ffmpeg 6 understands `-fps_mode` and the apt ffmpeg 4.4 doesn't.
```bash
use world
W=$WORK/livingroom                       # one folder per memory
mkdir -p $W/frames/raw && cd $W
ffmpeg -i clip.mp4 -fps_mode passthrough -q:v 2 -start_number 0 frames/raw/%05d.jpg
ffprobe -v error -select_streams v:0 -show_entries frame=pts_time -of csv=p=0 clip.mp4 > frames/raw_times.txt
memreplay stage frames --work $W          # TO WRITE (P1): sharpness pick, undistort, frames/full + frames/small (640 px), frames.json
ffmpeg -framerate 10 -pattern_type glob -i 'frames/small/*.jpg' -c:v libx264 -crf 12 -pix_fmt yuv420p frames/small.mp4   # ViPE input
```

**Tonight, until `memreplay stage frames` exists,** use plain 10 fps frames instead. This needs no Python, and it's enough for the go/no-go test:
```bash
use world && W=$WORK/livingroom && cd $W && mkdir -p frames/full frames/small
ffmpeg -i clip.mp4 -vf fps=10 -q:v 2 -start_number 0 frames/full/%05d.jpg
ffmpeg -i clip.mp4 -vf "fps=10,scale='if(gt(iw,ih),640,-2)':'if(gt(iw,ih),-2,640)'" -q:v 2 -start_number 0 frames/small/%05d.jpg
ffmpeg -framerate 10 -i frames/small/%05d.jpg -c:v libx264 -crf 12 -pix_fmt yuv420p frames/small.mp4
```

**Sharpness score.** `cv2.Laplacian(gray, cv2.CV_64F).var()`. Higher is sharper.

**Lens straightening (optional).** Run `cv2.calibrateCamera` on about 20 checkerboard frames, save the result to `calib.json`, then apply `cv2.undistort` to every kept frame.

**If it fails.** Use plain `ffmpeg -vf fps=10` and skip the lens straightening.

### S1 · Nouns (P2, env `core`)

**What it does.** Sends 8 evenly spaced frames to Claude and gets back up to 6 rigid, textured things that move, plus `person` and `hand`. Each entry has a size range and a density. The list has two uses:
- SAM 3's text prompts (S2);
- ViPE's "ignore these" list (S3), so a thrown box doesn't throw off the camera path.

**Run** (Claude API usage per Anthropic's docs; needs `ANTHROPIC_API_KEY` in `/workspace/secrets.sh`):
```python
import anthropic, base64, glob, json
from memreplay.handoff import Nouns

W = "/workspace/work/livingroom"
files = sorted(glob.glob(f"{W}/frames/small/*.jpg"))
keyframes = files[:: max(1, len(files) // 8)][:8]
img = lambda p: {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                 "data": base64.standard_b64encode(open(p, "rb").read()).decode()}}
PROMPT = ("These are 8 frames from a first-person video. List up to 6 rigid, textured things that move "
          "during the clip (carried, thrown, rolled) as short noun phrases usable as segmentation prompts. "
          "For each give the longest-side size range in meters, a density in kg/m3, and whether a person "
          "could pick it up. Also include one entry with kind 'person' and one with kind 'hand' "
          "(grabbable false). Leave out furniture and anything that never moves.")
item = {"type": "object", "additionalProperties": False,
        "required": ["noun", "kind", "size_min_m", "size_max_m", "density_kg_m3", "grabbable"],
        "properties": {"noun": {"type": "string"}, "kind": {"type": "string", "enum": ["object", "person", "hand"]},
                       "size_min_m": {"type": "number"}, "size_max_m": {"type": "number"},
                       "density_kg_m3": {"type": "number"}, "grabbable": {"type": "boolean"}}}
schema = {"type": "object", "additionalProperties": False, "required": ["nouns"],
          "properties": {"nouns": {"type": "array", "items": item}}}

client = anthropic.Anthropic()
resp = client.beta.messages.create(
    model="claude-opus-5-5", max_tokens=16000,
    output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
    betas=["server-side-fallback-2026-07-01"], fallbacks="default",   # retries on another model if declined
    messages=[{"role": "user", "content": [*map(img, keyframes), {"type": "text", "text": PROMPT}]}],
)
if resp.stop_reason == "refusal":
    raise SystemExit(f"declined: {resp.stop_details}")
nouns = Nouns.model_validate_json(next(b.text for b in resp.content if b.type == "text"))
open(f"{W}/nouns.json", "w").write(nouns.model_dump_json(indent=2))
```

**If it fails.** Write `nouns.json` by hand. It has the same format and takes 2 minutes.

### S2 · Masks (P2, env `seg`)

**What it does.** For each noun, SAM 3.1 finds every instance in every frame and gives it an ID. We then fix up the results:
- **Re-joined IDs:** an object that leaves the frame and comes back gets a new ID, so stitch them back together (same 3D position within 0.3 m and similar look).
- **The wearer's own hands** become `ego-hand`: masks that touch the frame edge and are closer than 0.8 m. The distance check needs S3's depth.
- **Held frames:** frames where a hand covers an object get `held: true`.

**Output.** `masks/tracks.json` (COCO RLE), plus `masks/dyn/<idx>.png`: every moving pixel combined, grown by 12 px.

**Run** (SAM 3.1 API, **verified** from the repo; the loop around it is ours to write; env `seg`):
```python
import os
from memreplay.handoff import Nouns
from sam3.model_builder import build_sam3_multiplex_video_predictor
W = os.environ["WORK"] + "/livingroom"
nouns = Nouns.model_validate_json(open(f"{W}/nouns.json").read())
predictor = build_sam3_multiplex_video_predictor()      # needs Hugging Face access to facebook/sam3.1
sid = predictor.handle_request(request=dict(type="start_session", resource_path=f"{W}/frames/full"))["session_id"]
for noun in [n.noun for n in nouns.nouns]:
    predictor.handle_request(request=dict(type="add_prompt", session_id=sid, frame_index=0, text=noun))
    for r in predictor.handle_stream_request(request=dict(type="propagate_in_video", session_id=sid)):
        out = r["outputs"]   # out_obj_ids [N], out_probs [N], out_binary_masks [N,H,W] bool, at frame position r["frame_index"]
        ...                  # encode each mask with pycocotools (below) and store under f"{noun}:{obj_id}"
    predictor.handle_request(request=dict(type="reset_session", session_id=sid))   # REQUIRED before the next noun
predictor.handle_request(request=dict(type="close_session", session_id=sid))
```
```python
from pycocotools import mask as mask_util; import numpy as np
rle = mask_util.encode(np.array(m[:, :, None], dtype=np.uint8, order="F"))[0]
rle["counts"] = rle["counts"].decode("utf-8")
```

**Watch out.**
- Frame files must be named `<number>.jpg`; ours are.
- A session expires after 20 minutes.
- SAM 3.1 wants `flash-attn-3`. If that wheel won't install, try `build_sam3_multiplex_video_predictor(use_fa3=False)` (unverified).

**If it fails** (for example, Hugging Face access isn't approved yet): use SAM 2.1 with a box per object from Grounding DINO. Neither needs approval. The complete runnable script is the P2 test in section 6; run it once per noun.

### S3 · Cameras + depth (P1, env `vipe`)

**What it does.** ViPE looks for the named moving things, ignores them, and solves for three things in every frame:
- where the head was;
- the lens settings;
- near-metric depth for every pixel.

It writes poses, intrinsics, depth and its own masks.

**Run** (**verified**; `run.py` is the only way to set the masking phrases):
```bash
cd $SRC/vipe
uv run python run.py pipeline=default streams=raw_mp4_stream \
  streams.base_path=$W/frames/small.mp4 streams.frame_end=-1 \
  pipeline.output.path=$W/vipe pipeline.output.save_artifacts=true \
  "pipeline.init.instance.phrases=[$(python3 -c "import json;print(','.join(json.dumps(n['noun']) for n in json.load(open('$W/nouns.json'))['nouns']))" 2>/dev/null || echo 'person,hand,box')]"
# ^ the S1 nouns, or person,hand,box if nouns.json isn't there yet. Hydra list quoting is unverified; check ViPE's log.
```

**What it writes** in `$W/vipe/` (`<name>` = `small`):

| File | Contents |
|---|---|
| `pose/<name>.npz` | `data` (N,4,4) camera-to-world, OpenCV axes (x right, y down, z forward); `inds` frame positions |
| `intrinsics/<name>.npz` | `data` (N,4) `[fx, fy, cx, cy]` |
| `depth/<name>.zip` | one float16 EXR per frame, metric |
| `mask/<name>.zip` + `mask/<name>.txt` | instance masks and their phrases. These can stand in for S2's masks in the L0 demo. |

The readers are in `vipe.utils.io`.

**Look at it:**
- Run `uv run vipe visualize $W/vipe` on the pod.
- On your laptop, run `ssh -L 20540:localhost:20540 -p <port> root@<ip>`.
- Open http://localhost:20540.

**Watch out.**
- **Use the `default` preset.** `wide_angle` and `pose_only_long` write **no depth**.
- **`run.py` stops at 1000 frames** unless you pass `streams.frame_end=-1`.
- **Without `save_artifacts=true`, nothing is written.**
- **One weight file comes from Google Drive and can be rate-limited.** `setup.sh` doesn't pre-fetch it. Do your first run with `streams.frame_end=30` so the weights download quickly, then do the full run.

**If it fails**, try these in order:
1. If the lens wasn't straightened in S0, straighten it, then rerun `default`.
2. Compare with `uv run vipe infer $W/frames/small.mp4 -p wide_angle -o $W/vipe_wide`. That gives poses only, so use it as a sanity check on the camera path.
3. MapAnything with the `facebook/map-anything-apache` weights on masked keyframes.
4. MegaSaM, if a GPU is free.

### S4 · World frame (P1, env `world`)

**What it does.**
1. Reads ViPE's output and fits the floor plane to static depth points: open3d `segment_plane(distance_threshold=0.02, ransac_n=3, num_iterations=1000)`.
2. Rotates so +Y points up, with the floor at y = 0.
3. Scales so the median head height equals the wearer's measured eye height.
4. Writes `world/cameras.json` (with `in_world_frame: true`), `world/depth.npz` and `world/world.json` in the handoff formats.

**Run:** `memreplay stage world --work $W` (TO WRITE).

**Check:** before rescaling, eye height should come out between 1.4 and 1.8 m.

**If it fails:** pick 3 floor points by hand in the ViPE viewer.

### S5 · Background (P1, env `world`)

**What it does.** Trains the room as a Gaussian splat from the same clip. Every pixel that S2 (or ViPE) marked as moving is left out of the loss, so people and props leave no smears. It caps the result at 300k splats and converts it to `.spz`.

**L0 shortcut first (about 2 minutes):** fuse the static depth points into one point cloud and save each point as a small splat. It looks rougher, but it gets something into the Quest tonight.

**Run** (gsplat **verified** from its docs; the mask loader and COLMAP writer are ours to write):
```bash
memreplay stage background --work $W             # TO WRITE (P1): writes $W/colmap: images, sparse/0, masks (white = static)
cd $SRC/gsplat/examples
python simple_trainer.py mcmc --data_dir $W/colmap --data_factor 1 --result_dir $W/gsplat \
  --strategy.cap-max 300000 --steps_scaler 0.5 --save_ply \
  --app_opt --pose_opt --disable_viewer --eval_steps -1 --no-normalize-world-space
splat-transform $W/gsplat/ply/point_cloud_14999.ply --filter-nan --decimate 300000 $W/gsplat/bg_300k.ply
splat-transform -w $W/gsplat/bg_300k.ply $W/world/bg.spz
```

**Patch gsplat** (in `datasets/colmap.py`, `Dataset.__getitem__`): load `colmap/masks/<stem>.png` and set `data["mask"] = torch.from_numpy(m > 127)`, where True means a static pixel that is kept. The `main` branch already drops masked pixels from the loss.

**Mask direction.** S2's `masks/dyn/` is **white = moving**. gsplat and Brush both want **white = static**, so `memreplay stage background` writes `colmap/masks/<stem>.png = 255 - masks/dyn/<idx>.png`. Copying `masks/dyn` across as-is would train only on the moving things.

**Step count.** `--steps_scaler 0.5` gives 15k steps and also scales gsplat's refinement schedule. Setting only `--max_steps` would keep refining until the very last step.

**COLMAP layout:**
- Images go in `colmap/images/`, cameras in `colmap/sparse/0/`.
- `images.txt` stores **world-to-camera** poses with the quaternion as `QW QX QY QZ`.
- Seed `points3D.txt` with about 200k fused static depth points.

**Watch out.**
- **Turn off `normalize_world_space`,** or the splat ends up in a different frame from everything else. Check the exact flag with `python simple_trainer.py mcmc --help | grep normalize`.
- **Other flag spellings** (`--max_steps` and so on) come from the benchmark scripts; confirm them with `--help`.
- **Orientation:** if the splat shows up upside down in the viewer, add `-r 180,0,0` to the convert step.
- **Splat-transform's `--decimate` must be the last action,** so decimate and convert in two separate calls.

**If it fails:** run Brush (`brush $W/colmap --max-splats 300000 --total-steps 15000 --export-path $W/brush`; reads `masks/` next to `images/`), or ship the L0 point splat.

### S6 · Ghosts (P1, env `world`)

**What it does.** For each person mask, takes the depth inside the (slightly shrunk) mask and drops pixels at depth edges, which are flying pixels. The rest becomes 20–30k colored splats in world coordinates per frame, at 10 Hz.

**Output:**
- `world/ghosts/<id>/<n>.spz`;
- an entry in `world/ghosts.json` with `visual.kind = "splat-sequence"` and `grabbable: false`.

**Run:** `memreplay stage ghosts --work $W` (TO WRITE).

**If it fails:** use 10k points and every second frame.

### S7 · Objects (P2, env `obj`)

**What it does.** For each object:
1. Picks its best frame (big mask × sharp × not covered by a hand).
2. Builds the full object in 3D with SAM 3D Objects, including sides we never saw.
3. Fixes its size against our depth, and builds a convex collision shape (≤64 vertices) and a mass (density × volume).

**Run** (SAM 3D API **verified** from the repo; run from `$SRC/sam-3d-objects`):
```python
import sys; sys.path.append("notebook")
from inference import Inference
inference = Inference("checkpoints/hf/pipeline.yaml", compile=False)
out = inference(image, mask, seed=42, pointmap=P)   # P: HxWx3 torch tensor from our depth, see below
out["gs"].save_ply(f"{W}/objects/{oid}/gs_raw.ply")
# out["rotation"] (quaternion w,x,y,z), out["translation"], out["scale"]: object -> camera
```

**Size fix:**
1. Render the asset's depth at the predicted pose.
2. scale = median(our depth) ÷ median(rendered depth), over visible object pixels.
3. A few ICP steps on rotation and position only, with scale locked.
4. Clamp to S1's size range.

**Collider:** `trimesh` convex hull of the splat centers, simplified to ≤64 vertices, saved as `hull.glb`.

**Splat:** splat-transform lives in the `world` env, so call it through `conda run`:
```bash
conda run -p $ENVS/world splat-transform $W/objects/<id>/gs_raw.ply --decimate 30000 $W/objects/<id>/gs_30k.ply
conda run -p $ENVS/world splat-transform -w $W/objects/<id>/gs_30k.ply $W/objects/<id>/gs.spz
```

**Watch out.**
- **Pointmap axes:** if you pass our depth as a pointmap, flip it from OpenCV axes to PyTorch3D axes by negating X and Y (from reading the code; unverified).
- **Separate env:** this env pins Python 3.11, CUDA 12.1 and torch 2.5.1, and must be built on the GPU pod.
- **GPU memory:** it needs at least 32 GB.

**If it fails:** use TRELLIS.2 plus our own fit, or the object's fused depth points with a box collider.

### S8 · Tracks (P2, env `seg`)

**What it does.** For each object:
1. CoTracker3 follows a grid of points on the object (with hands removed) through the clip.
2. Using P1's depth and cameras, each visible point becomes a 3D world point.
3. Each frame, a RANSAC Kabsch fit finds the rotation and position that best moves the reference points onto that frame's points (scale fixed, 2 cm inlier threshold, at least 6 inliers).
4. Smooth with Savitzky-Golay (window 7, order 2), sample at 10 Hz, and fill held frames by interpolation.

**Run** (CoTracker3 **verified** from the repo):
```python
import torch
cotracker = torch.hub.load("facebookresearch/co-tracker", "cotracker3_offline").cuda()
video = torch.from_numpy(frames).permute(0, 3, 1, 2)[None].float().cuda()     # (1, T, 3, H, W), 0..255
segm = torch.from_numpy(mask_t0).float()[None, None].cuda()                    # object mask at frame t0
tracks, vis = cotracker(video, grid_size=40, segm_mask=segm, grid_query_frame=t0, backward_tracking=True)
# tracks (1, T, N, 2) pixel x,y; vis (1, T, N) bool
```

**Watch out.**
- **Memory grows with clip length.** Run windows of about 200 frames with overlap, or use `cotracker3_online`.
- **Textureless objects can't be tracked,** so pick printed or patterned props.
- **Before P1's world cameras land,** run everything in camera coordinates.

**If it fails:** translation only (the median of the object's world points per frame), and as a last resort a static object.

### S9 · Merge (anyone, env `core`)

**What it does.** Combines `world/` and `objects/` into `memory.json` and checks it:
- **Stops** if the cameras aren't in the world frame or object IDs repeat.
- **Warns** if the background has more than 350k splats, or an object goes more than 5 cm below the floor.

**Run** (**done** and tested):
```bash
memreplay merge $W --title "Living room"
```

---

## 4. Set up Runpod (once)

### 4.1 Accounts and access (do these first; approvals take time)
- **P2:** request access on Hugging Face to `facebook/sam3.1`, `facebook/sam3` and `facebook/sam-3d-objects` (each is approved separately; SAM 3D is reviewed by hand). Then create an HF token. When SAM 3D is approved, run `bash setup.sh obj_weights`.
- **Anthropic API key** for S1.
- **Runpod account:** ask the Runpod booth about credits. Add your SSH **public** key under Account Settings → SSH public keys.

### 4.2 Create the storage and the pod
1. **Storage → New Network Volume:** Secure Cloud, a datacenter that has H100s, **200 GB**. This holds everything: environments, weights and work folders. It survives restarts and redeploys.
2. **Pods → Deploy:**
   - **GPU:** H100 (PCIe or SXM, 80 GB). Secure Cloud, because Community Cloud can't attach network volumes.
   - **Network volume:** attach yours. It can only be attached at deploy time.
   - **Image:** `runpod/pytorch:1.4.1-cu1281-torch280-ubuntu2204` (CUDA 12.8). If the template shows something else, enter this tag under Edit Template.
   - **Ports:** leave TCP 22 exposed (the default). You need it for `scp`/`rsync`.
3. **Connect:** on the pod page, open **Connect → Direct TCP Ports** for the IP and port, then run:
   ```bash
   ssh root@<ip> -p <port> -i ~/.ssh/id_ed25519
   ```
   The port changes on every restart. The proxy SSH address (`…@ssh.runpod.io`) can't do `scp` or `rsync`.

### 4.3 Put the repo and secrets on the volume
Make sure the latest commits are pushed to GitHub first; the pod clones whatever is on `main`.
```bash
apt-get update -qq && apt-get install -y -qq git tmux rsync    # the bare image may lack these
cd /workspace && git clone https://github.com/im-yifanluo/calhacks-13.git memory-replay
# private repo: create a GitHub token and use https://<token>@github.com/im-yifanluo/calhacks-13.git
ls memory-replay/pipeline/runpod/setup.sh                     # must exist; if not, main isn't pushed yet
# or copy it from your laptop instead:
# rsync -avP -e "ssh -p <port>" ./ root@<ip>:/workspace/memory-replay/ --exclude node_modules
cat > /workspace/secrets.sh <<'EOF'
export HF_TOKEN=hf_...
export ANTHROPIC_API_KEY=sk-ant-...
EOF
chmod 600 /workspace/secrets.sh
```

### 4.4 Install the environments
Each person uses their own tmux session, so installs keep going if SSH drops (reconnect with `tmux attach -t p1`):
```bash
bash /workspace/memory-replay/pipeline/runpod/on_start.sh            # system packages, incl. tmux
tmux new -s p1                                                       # P2: tmux new -s p2
bash /workspace/memory-replay/pipeline/runpod/setup.sh base          # ONE person only; wait until it finishes
bash /workspace/memory-replay/pipeline/runpod/setup.sh vipe world    # P1, after base
bash /workspace/memory-replay/pipeline/runpod/setup.sh seg obj       # P2, after base, at the same time as P1
```

| Env | Owner | For | Python / torch / CUDA |
|---|---|---|---|
| `core` | both | our `memreplay` CLI, Claude calls (S1, S9) | 3.12, no torch |
| `vipe` | P1 | ViPE (S3). Its Python packages live in `$SRC/vipe/.venv`; run with `uv run` | 3.12 / cu128 torch / 12.8 |
| `world` | P1 | gsplat, open3d, splat-transform (S0, S4, S5, S6) | 3.12 / 2.9.1 / 12.8 |
| `seg` | P2 | SAM 3.1, SAM 2.1, Grounding DINO, CoTracker3 (S2, S8) | 3.12 / 2.10.0 / 12.8 |
| `obj` | P2 | SAM 3D Objects (S7) | 3.11 / 2.5.1 / 12.1 |

- **Why so many environments:** the tools need different torch and CUDA versions, so they can't share one.
- **Rerunning setup:** each finished step leaves a marker (`$ENVS/<env>/.setup-<step>`), so after fixing a failure, rerun the same target and it continues where it stopped. Delete a marker to redo that step.
- **Install time:** expect 20–40 minutes per target, mostly CUDA builds (estimate).

### 4.5 After every pod restart
```bash
bash /workspace/memory-replay/pipeline/runpod/on_start.sh     # reinstalls ffmpeg, tmux, rsync (wiped on stop)
source /workspace/memory-replay/pipeline/runpod/env.sh        # paths, caches, keys, and the `use <env>` helper
use world                                                     # activate an env
```

---

## 5. Run one clip end to end

```bash
# 1. From your laptop: the test clip shot at kickoff (docs/PLAN.md section 5)
ssh -p <port> root@<ip> mkdir -p /workspace/work/livingroom
rsync -avP -e "ssh -p <port>" clip.mp4 root@<ip>:/workspace/work/livingroom/

# 2. On the pod, in tmux
source /workspace/memory-replay/pipeline/runpod/env.sh && W=$WORK/livingroom
```

| Order | Who | Env | Command | Time (estimate) |
|---|---|---|---|---|
| 1 | P1 | `world` | S0 (section 3) | 2 min |
| 2 | P2 | `core` | S1 Claude script | 1 min |
| 3a | P1 | `vipe` | S3 `run.py` with the S1 nouns | 5–15 min |
| 3b | P2 | `seg` | S2 SAM 3.1, one pass per noun | 5–15 min |
| 4 | P1 | `world` | S4 world frame → **send `world/` to P2** | 2 min |
| 5 | P1 | `world` | L0 point background + S6 ghosts → `memreplay merge` → **L0 to P3** | 10 min |
| 6a | P1 | `world` | S5 gsplat (needs S2 masks) | 15–20 min |
| 6b | P2 | `obj` + `seg` | S7 objects, then S8 tracks | 10–20 min |
| 7 | P1 (anyone can run it) | `core` | `memreplay merge $W` | 1 min |

**Get results to the viewer** (P3), with no bucket needed. Run this from the repo root on your laptop. It copies only what the viewer loads; frames, depth and checkpoints stay on the pod:
```bash
rsync -avP -e "ssh -p <port>" --include='memory.json' --include='world/' --include='world/bg.spz' \
  --include='world/ghosts/***' --include='objects/' --include='objects/*/' --include='objects/*/gs.spz' \
  --include='objects/*/hull.glb' --exclude='*' \
  root@<ip>:/workspace/work/livingroom/ apps/web/public/memories/livingroom/
# then open http://localhost:5173/?memory=/memories/livingroom/memory.json
```
`apps/web/public/memories/` is git-ignored, so none of this ends up in commits.

## 6. Tonight's go/no-go test (by Sat 1:00 AM)

The test answers one question: does ViPE give a usable camera path and depth on glasses footage? S4 isn't written yet, so judge by eye in ViPE's viewer.

**P1:**
1. Make frames with the "Tonight" commands in S0.
2. Run S3 with `streams.frame_end=30` first, to cache weights, then the full run.
3. Run the wide-angle preset as a cross-check: `uv run vipe infer $W/frames/small.mp4 -p wide_angle -o $W/vipe_wide`.
4. Open `uv run vipe visualize $W/vipe`, port-forwarded as in S3.

It passes if:
- **the floor points form one flat sheet,** not a bowl or a ramp;
- **the cameras sit 1.4–1.8 m above that sheet** (use the grid);
- **with two frames 3 s apart (30 positions) shown together, walls and furniture land on one surface,** not two shifted copies;
- **the `wide_angle` camera path roughly matches.**

If it fails, go down the S3 fallbacks in order.

**P2, as soon as P1's `frames/full/` exists:** test masks with SAM 2.1 and Grounding DINO on "box". Neither needs Hugging Face approval. Use SAM 3.1 instead only if access is already approved. Run in `use seg`:
```python
import glob, os, torch
from PIL import Image
from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
from sam2.build_sam import build_sam2_video_predictor

SRC, W = os.environ["SRC"], os.environ["WORK"] + "/livingroom"
img = Image.open(sorted(glob.glob(f"{W}/frames/full/*.jpg"))[0])
proc = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-tiny")
gd = AutoModelForZeroShotObjectDetection.from_pretrained("IDEA-Research/grounding-dino-tiny").cuda()
inputs = proc(images=img, text="a box.", return_tensors="pt").to("cuda")
with torch.no_grad():
    det = proc.post_process_grounded_object_detection(gd(**inputs), inputs.input_ids, target_sizes=[img.size[::-1]])[0]
assert len(det["boxes"]), "no box found in the first frame; try another noun or frame"
box = det["boxes"][0].cpu().numpy()                                     # x0, y0, x1, y1 in pixels

pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", f"{SRC}/sam2/checkpoints/sam2.1_hiera_large.pt")
with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
    state = pred.init_state(f"{W}/frames/full")
    pred.add_new_points_or_box(state, frame_idx=0, obj_id=1, box=box)
    hits = [int((logits > 0).any()) for _, _, logits in pred.propagate_in_video(state)]
print(f"box masked in {sum(hits)} of {len(hits)} frames")
```
It passes if the box is masked in most frames where it's visible. To see the masks, save a few `logits > 0` arrays as PNGs and look at them.

## 7. Costs and pod hygiene

| Option | Price | Notes |
|---|---|---|
| H100 PCIe, Secure Cloud | about $2.89/h | About $120 for the weekend if left on. |
| L40S | $1.09/h | Fine for everything except big ViPE or gsplat runs. SAM 3D needs ≥32 GB, which the L40S's 48 GB covers. `env.sh` builds CUDA code for A100, L40S and H100, so envs work on all three. SAM 3.1's flash-attn-3 is H100-only; on an L40S pass `use_fa3=False`. |

- **Stop the pod when nobody is running anything.** `/workspace` survives a stop; everything else (apt packages, running jobs) does not.
- **If a restart comes back with 0 GPUs,** the machine is full. Terminate and redeploy with the same network volume; nothing on the volume is lost.
- **A second pod for P2** on the same volume is possible. Whether two pods can mount it at the same time is unverified, so test it first, and have each person write only to their own folders.
- **Docker doesn't work inside a pod.** Everything is installed with conda, pip or uv.

## 8. Licenses (fine for a hackathon demo; check before any commercial use)

| Tool | License |
|---|---|
| ViPE | Apache 2.0. Don't use its UniK3D backend (BY-NC-SA). Its `default` preset depth models are fine. |
| MapAnything | Apache weights variant |
| SAM 3 / 3.1, SAM 3D Objects | SAM License (gated) |
| SAM 2.1 | Apache 2.0 |
| CoTracker3 | CC-BY-NC 4.0 |
| gsplat | Apache 2.0 |
| TRELLIS.2 | MIT (verify) |
