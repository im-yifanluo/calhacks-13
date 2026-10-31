# Real 4D Gaussian splatting vs. the static room + layers pipeline

Track: an independent attempt at true 4D Gaussian splatting (4DGS) on the Ray-Ban Meta glasses clips, run in parallel with the main pipeline so the two can be compared. Written Sat Oct 24, about 9 PM PT. Code: `pipeline/experiments/fourd/`. Work files on the pod: `/workspace/4dgs/A/`. Log: `/workspace/logs/4dgs.log`.

## Short version

- **4DGaussians works on our footage.** On v59 (a speaker at a podium, 17.6 s), it reproduces the video from the recorded camera at **30.5 dB PSNR, SSIM 0.934, LPIPS 0.163**. That is the average over 44 held-out frames (every 12th frame, never trained on). On the people pixels it scores 25.1 dB.
- **The main pipeline's static room, scored at the same 44 cameras, gets 18.2–19.0 dB** (SSIM 0.794). On the people pixels it gets 8.6–9.1 dB, because the room splat has no people in it; in the viewer they are point-cloud ghosts.
- **4DGS cost:** 31–44 minutes of training on one H200, plus about 5 minutes to render, score and export.
- **The 4DGS export plays back in the viewer's format**, in the world frame: 177 per-time splats at 10 Hz (`t_%04d.spz`, about 295k Gaussians and 5 MB each, 880 MB in total).
- **Vanilla 4DGaussians (run c) is not a drop-in replacement, for four reasons:**
  1. **The whole room wobbles.** Every Gaussian is allowed to move, and the deformation field soaks up camera-pose error. Background Gaussians drift by a median 7 cm over the clip, about as much as the people do. From the recorded camera you cannot see this. In VR, from a new viewpoint, the room would shimmer.
  2. **Bright walls are partly transparent.** 4DGaussians trains on a white background, so bright surfaces are learned see-through over white. On a black viewer background the same export scores 21.0 dB instead of 30.5 dB.
  3. **The files are big:** 880 MB for 17 s, against about 7 MB for the static room.
  4. **There is no separation into objects**, so nothing in the 4D splat can be grabbed or thrown.
- **My split variant (run e, final) fixes problems 1 to 3.** Only Gaussians seeded on people deform, and training uses a random background. I retrained it to completion on the current clip, with the main pipeline's refined poses and exposure.
  - Held-out: **29.2 dB, SSIM 0.913, LPIPS 0.213**; people pixels 25.9 dB, other pixels 29.5 dB. Scored in video space, against OpenCV frames of the current clip.
  - The room does not move (median 0.0 cm, p90 2.2 cm), and the export is opaque.
  - Payload: `static.spz` 3.4 MB plus 0.53 MB per 10 Hz frame, 93 MB for v59.
  - Training took 33 min on one H200.
- **v71** (39 s, stage then a crowded hall): 4DGS **28.7 dB / 0.905 / 0.218** against **18.0 dB / 0.777 / 0.389** for the static room at the same 97 held-out cameras. On people pixels: 25.7 vs 9.5 dB.
- **The whole-frame PSNRs come from different frames.** v59's `input/clip.mp4` was re-normalized at 02:30Z with a darker tone map, after my runs had trained. Each method is scored against the frames it trained on. For a cross-check, the comparison image also reports PSNR after a global colour match.

## What was built

- **Method: 4DGaussians** (hustvl, CVPR 2024): https://github.com/hustvl/4DGaussians.
  - Canonical 3D Gaussians plus a HexPlane (k-planes) space–time feature field with small MLP heads. For any time t, the heads give each Gaussian a position, scale and rotation offset. I also enabled colour offsets, for stage lights and auto-exposure.
  - I picked it because it trains in tens of minutes, renders at any time, and needs only posed frames and an initial point cloud. It built on the first try with small patches, so no fallback was needed.
- **Build:**
  - Python env: venv `/workspace/envs/4dgs` on top of the world env (torch 2.9.1+cu128).
  - CUDA extensions for sm_90: `simple-knn` and `depth-diff-gaussian-rasterization`. They needed `<cfloat>` / `<cstdint>` includes to compile with gcc 14.
  - `mmcv` replaced by `mmengine`'s Config.
  - All patches are in `pipeline/fourd/patch_4dgaussians.py`.
- **Data** (`pipeline/fourd/convert.py`):
  - Frames: every frame of `input/clip.mp4` at 962x1280. v59: 485 train, 44 test (frame idx % 12 == 6).
  - Time: frame idx / last idx.
  - Cameras: `world/frames.npz` (the final world frame, scale 1.4055).
    - That file's c2w carries the metric scale inside its rotation block (det = s³). I divide it out.
    - My first run (a) used the rotation block as is. The renderer's view space was then scaled by s², which stays consistent in image space but makes the Gaussians s times too large.
  - Init cloud: ~120k points backprojected from ViPE depth on every 6th frame, people included.
  - HexPlane box: a robust 0.5–99.5 % box of the near points.
- **Training:**
  - Settings: the HyperNeRF config of 4DGaussians, i.e. 3k static "coarse" iterations then 14k deformation iterations at batch 2, with a temporal grid of 150 cells. I added multires [1,2,4,8], colour deformation and an SSIM weight of 0.1.
  - Run a: 34 min on a dedicated H200 (coarse at ~20 it/s, fine at ~8.6 it/s).
  - Run c: 44 min on an H200 shared with the main pipeline's training worker.
- **Export** (`pipeline/fourd/post.py`):
  - Evaluates each Gaussian at 10 Hz.
  - Bakes the degree-3 SH colour seen from the recorded camera at that time into `f_dc`.
  - Writes `t_%04d.ply` with x,y,z,f_dc_0..2,opacity,scale_0..2,rot_0..3 (≤ 300k Gaussians), then runs `splat-transform -w` to make the `.spz` files.
  - Check: rendering the exported PLYs with gsplat at the held-out cameras reproduces the native renderer exactly (30.51 dB vs 30.51 dB, on the white training background).

## Results, v59 (44 held-out frames, 962x1280)

|                                                                                        | PSNR      | SSIM      | LPIPS (alex) | PSNR people px | PSNR non-people px |
| -------------------------------------------------------------------------------------- | --------- | --------- | ------------ | -------------- | ------------------ |
| **4DGS run c** (final world frame), native renderer                                    | **30.51** | **0.934** | **0.163**    | **25.1**       | **31.1**           |
| 4DGS run c, exported 10 Hz splats, white background                                    | 30.51     | 0.934     | 0.163        | 25.1           | 31.1               |
| 4DGS run c, exported 10 Hz splats, black background                                    | 21.04     | 0.896     | 0.194        | 23.4           | 21.0               |
| 4DGS run a (superseded frame, scaled-rotation cameras)                                 | 30.37     | 0.934     | 0.163        | 24.9           | 30.9               |
| Main static room, `gsplat_static/baked.ply` (what `bg_static.spz` holds), same cameras | 18.24     | 0.794     | 0.338        | 9.1            | 20.0               |
| Main static room, `gsplat_static/ply/point_cloud_20099.ply`, same cameras              | 18.96     | 0.794     | 0.307        | 8.6            | 21.7               |
| Main static room, gsplat's own held-out eval (`val_step20099.json`, different frames)  | 16.01     | 0.783     | 0.293        |                |                    |

Each method is scored against the frames it trained on: 4DGS against the clip as decoded at 02:00Z, the static room against the clip after the 02:30Z re-normalization. Run e (split) and v71 results follow below.

**How much the 4DGS deformation moves things** (`motion.json`): the largest distance of each visible Gaussian from its time-averaged position, over the 10 Hz samples.

| run | all, median | all, p90 | on a person (mid-clip), median | not on a person, median |
| --- | ----------- | -------- | ------------------------------ | ----------------------- |
| a   | 8.8 cm      | 16.6 cm  | 9.8 cm                         | 8.7 cm                  |
| c   | 7.1 cm      | 14.7 cm  | 9.2 cm                         | 6.9 cm                  |

## Comparison image (first version, run c; the docs image is now run e, see above)

- **Columns:**
  1. The video frame (`ffmpeg -ss t` on the current `input/clip.mp4`).
  2. The main pipeline's shot (`pipeline/tools/shots/v59`).
  3. 4DGS run c, rendered from the `world/cameras.json` keyframe nearest t.
- **Image size:** everything is resized to 450x600.
- **"cm" in the labels:** PSNR after a least-squares global colour map onto the frame (3x3 matrix plus bias). It removes the tone-map difference: the 4DGS model was trained on the pre-02:30Z, brighter version of the clip, and the two decodes of the same frame differ by 13.8 dB on their own. A non-linear tone change is only partly undone by a 3x3 map, so the 4DGS column is still somewhat penalized.

| t (s)    | keyframe idx | main, PSNR | 4DGS, PSNR | main, colour-matched | 4DGS, colour-matched |
| -------- | ------------ | ---------- | ---------- | -------------------- | -------------------- |
| 1.5      | 45           | 18.6       | 13.7       | 21.3                 | 24.2                 |
| 4.4      | 132          | 18.5       | 13.2       | 21.4                 | 22.9                 |
| 7.3      | 219          | 18.3       | 13.2       | 20.3                 | 24.5                 |
| 10.3     | 309          | 18.9       | 13.6       | 21.5                 | 24.5                 |
| 13.2     | 396          | 17.6       | 13.9       | 19.4                 | 25.6                 |
| 16.2     | 486          | 18.3       | 13.2       | 19.6                 | 23.1                 |
| **mean** |              | **18.4**   | **13.5**   | **20.6**             | **24.1**             |

- **Raw PSNR favours the main pipeline only because of the tone map.** Its colours are calibrated against the current clip, while 4DGS reproduces the earlier, brighter decode.

**Scoring caveat: two decoders.** Training frames come from OpenCV (`memreplay.vipe_io.Frames`), while `memreplay/compare.py` (`frame_at`) gets its reference frame from ffmpeg.

- **What I measured on pod B** (OpenCV 5.0; ffmpeg 6.1.1 and 9.0.2 give identical results), current clips:

  | clip, frame | OpenCV mean | ffmpeg mean | mean abs difference |
  | ----------- | ----------- | ----------- | ------------------- |
  | v59, 45     | 116.0       | 101.2       | 16.8 levels         |
  | v59, 309    | 119.3       | 104.2       | 17.2 levels         |
  | o3328, 300  | 114.4       | 109.8       | 15.9 levels         |

- **A 2.1-level difference measured elsewhere for o3328 frame 300 must come from a different decoder pair.**
- **Both streams are tagged HLG/BT.2020** (`color_transfer=arib-std-b67`, `color_primaries=bt2020`), although after the LUT they hold SDR. `normalize.py` passes `-color_trc bt709` etc., but the tags do not end up in the stream. Decoders that look at the tags may convert differently.
- **On pod B the caveat is not minor.** The fix: score against the same decoder used for training, and write correct SDR tags at normalize.
- **Visually, 4DGS wins clearly:** the speaker is solid and sharp (face, lanyard, hands), and the podium, banner and teddy are crisp.
- **In the main render**, the speaker is a sparse coloured point ghost and the room is blurrier.

## What 4DGS gets right that the layered approach cannot

- **People are real splats that move as in the video.** Faces, clothes and limbs are sharp and correctly lit, with no billboard or point-ghost look. On v59, people pixels score 25 dB against 9 dB.
- **One model explains everything that changes over time:** people, stage lighting and exposure drift. No segmentation, layer assignment or per-person tracking is needed, and none of it can fail.
- **Replay from the wearer's view looks like the video,** about 30 dB on held-out frames. The static room cannot reach that even on background pixels (20–22 dB), because it cannot absorb small per-frame pose errors or exposure changes.

## What the layered approach does that 4DGS (as run here) cannot

- **The room stays put.** A static splat is rock solid from any viewpoint in VR. 4DGaussians moves background Gaussians by a median 7 cm, to absorb pose and exposure errors, so off the recorded path the room shimmers. My held-out frames sit between training frames on the same path, which favours 4DGS. Novel-view quality in VR is untested, and probably worse than these numbers suggest.
- **Objects and physics:** grabbable objects with colliders, a floor, a room collider. The 4D model is one undivided cloud, so you cannot grab and throw an object out of it.
- **Size and streaming:** about 7 MB for the room, plus small ghost sequences and object splats. Vanilla 4DGS is 880 MB per 17 s at 10 Hz. The split (run e) brings it to 3.4 MB plus 93 MB, still about 14 times the layered payload.
- **Opaque geometry:** 4DGS as shipped learns bright walls as semi-transparent over its white training background, which drops the export to 21 dB on black. The static pipeline does not have this problem. Training on a random background (run e) fixes it.
- **Robustness on long, wide clips:** see v71 below.

## Cost per clip (one H200)

- **4DGS:**
  - Conversion: about 2 min of CPU work (ViPE depth reads plus PNG writes).
  - Training: 31–34 min alone on a GPU, or about 44 min when the GPU is shared.
  - Post: eval 15 s, two videos about 3–5 min, export about 1 min. Spz conversion: 20 s with 32 parallel jobs.
  - Disk: about 3 GB of PLY plus 0.9 GB of spz per 17 s clip.
- **Static pipeline:** gsplat MCMC training at 0.67 of the steps. The main session reports about 17 min per glasses clip on a shared GPU, and the output is about 7 MB.

## Run e: static/dynamic split + random background (v59, final)

**Changes from run c** (patches in `patch_4dgaussians.py`, enabled by `FOURD_DYN_FLAG=1 FOURD_RANDBG=1`):

- **Only people deform.** Init points backprojected from ViPE "person" pixels are flagged dynamic: 8.8k of 126k points, with the mask dilated by 6 px and sampled twice as densely. Only flagged Gaussians, and the children densification makes from them, go through the deformation field; the room is an ordinary static 3DGS. This uses 4DGaussians' own `_deformation_table`, which upstream carries through densification and pruning but never uses.
- **Random background colour per training view.** The model can no longer hide bright walls as "transparent over white".
- **Inputs match the main pipeline:**
  - Frames: the current tone-mapped clip (`convert.py --refined --exposure`, data `A/data/v59e`).
  - Poses: the main pipeline's pose refinement (the `cameras.json` vs `cameras.vipe.json` delta of the nearest keyframe, applied to every frame).
  - Colour: training targets exposure-normalized as x = (y − b) / g from `world/exposure.json`. The export is therefore in the static room's colour space, and the viewer's wearer view re-exposes it with each keyframe's `e`.
- **Training:** 3k coarse + 14k fine iterations, 33 min alone on pod B GPU 0 (03:42–04:16Z). Spz-only export with `post.py --keep_ply 0`.
- **History:** a first run e on the old frames died at fine iteration ~10.3k when the disk filled. Its 7k checkpoint scored 25.99 / 0.886 / 0.245.

| v59, 44 held-out frames, video space (render re-exposed; GT = OpenCV frames of the current clip) | PSNR      | SSIM      | LPIPS     | people px | other px |
| ------------------------------------------------------------------------------------------------ | --------- | --------- | --------- | --------- | -------- |
| **run e, final**                                                                                 | **29.20** | **0.913** | **0.213** | **25.9**  | **29.5** |
| run c (vanilla; old frames; white background)                                                    | 30.51     | 0.934     | 0.163     | 25.1      | 31.1     |
| run c, exported splats, black background                                                         | 21.04     | 0.896     | 0.194     | 23.4      | 21.0     |
| main static room, `baked.ply`, same cameras                                                      | 18.24     | 0.794     | 0.338     | 9.1       | 20.0     |

- **Room motion** (`motion.json`): non-person Gaussians median 0.0 cm, p90 2.2 cm. Person Gaussians median 6.7 cm, p90 15.8 cm.
- **Size:** 31.5k dynamic and 199.7k static Gaussians.
- **Payload:**
  - `static.spz`: 3.39 MB.
  - `frames_dyn/t_0000..0176.spz`: 177 files of about 0.53 MB, 93 MB in total.
  - For comparison, all-Gaussians-per-frame spz would be 693 MB (kept in `/workspace/4dgs/A/out/v59e_e/frames/`).
- **Opaque:** trained on random backgrounds, so it renders the same on any viewer background.
- **Comparison image** (`images/4dgs-vs-static-v59.jpg` is now run e, re-exposed with `exposure.json` and rendered on black). Means over the six rows:

  | reference                                         | main pipeline | 4DGS run e |
  | ------------------------------------------------- | ------------- | ---------- |
  | ffmpeg `-ss` frame                                | 18.4          | 21.3       |
  | ffmpeg frame, colour-matched                      | 20.6          | 27.6       |
  | OpenCV frame (the decode both methods trained on) | 19.4          | 31.8       |

## v71 (39 s, stage then a crowded hall)

**Setup:**

- Frames: every 2nd frame, 582 in total. 485 train, 97 held-out (idx % 12 == 6).
- Training: 3k coarse + 18k fine iterations, temporal grid of 300 cells.
- Time: 60 min on GPU 0, which it shared with the v59 split runs.
- Tone: v71 was converted after its clip was re-normalized, so both methods trained on the same frames and the comparison is direct.

| v71, 97 held-out frames                                    | PSNR      | SSIM      | LPIPS     | PSNR people px | PSNR non-people px |
| ---------------------------------------------------------- | --------- | --------- | --------- | -------------- | ------------------ |
| **4DGS** (native renderer)                                 | **28.70** | **0.905** | **0.218** | **25.7**       | **29.0**           |
| Main static room, `gsplat_static/baked.ply`, same cameras  | 17.97     | 0.777     | 0.389     | 9.5            | 21.1               |
| Main static room, `point_cloud_20099.ply`, same cameras    | 17.93     | 0.778     | 0.388     | 9.5            | 20.9               |
| Main static room, gsplat's own eval (`val_step20099.json`) | 15.06     | 0.742     | 0.358     |                |                    |

- **The hall is crowded, and the gap on people pixels (25.7 vs 9.5 dB) is the biggest 4DGS win.** 4DGS reproduces the crowd moving through the hall; the static room has no people in it.
- **v71 export:** 389 per-time splats at 10 Hz in `/workspace/4dgs/A/out/v71_a/frames/`, spz only. I deleted the PLYs to save disk space; see the warning below. This is the vanilla model (white background, everything deforms), so it has the same wobble and transparency caveats as v59 run c.

## What is still broken or untested

- **Disk incident:** at ~03:20Z the 94 GB /workspace volume hit its quota, partly because of my per-time PLY exports (3 GB per run).
  - What it broke: it killed run e mid-training, and possibly main-pipeline writes in that window. GPU 1's job was gone at the same time.
  - What I did: I deleted my superseded exports, so the volume is now at 72/94 GB, and told the coordinator.
  - From now on: keep only spz (`post.py --keep_ply 0 --dyn_out 0`).
- **Room wobble** (7 cm median) in vanilla 4DGaussians: fixed by the split (run e). The v71 export is still vanilla.
- **Transparency from the white background:** fixed by the random-background training in run e. Runs a and c, and v71, were trained before the fix.
- **Run e is retrained to completion** (final numbers above). It has still not been viewed in the viewer or on Quest.
- **Tone mismatch:** v59's clip was re-normalized after training. A retrain on the current clip would make the raw PSNRs comparable.
- **Nothing has run in the viewer or on Quest:** I produced files only. 177 x 5 MB spz is too much to stream to Quest for one clip.
- **The exported colour is baked for the recorded camera at each time,** so view-dependent effects are frozen. Fine for replay, slightly wrong from other viewpoints.
- **Run a** was trained in the superseded world frame with cameras that carried scale in their rotation. Exporting it through a fitted similarity (2.6 cm median camera residual) loses about 9 dB, so it is not used for the deliverables.

## Next steps

1. Use the split model (run e) as the default: `static.spz` (3.4 MB) loaded once, plus dynamic people Gaussians per 10 Hz frame (0.53 MB each). Stream only the dynamic part.
2. Fix the stream colour tags at normalize, and score with the decoder used for training.
3. Add a regularizer on deformation magnitude for Gaussians not on people, plus ViPE depth supervision, to reduce floaters off the recorded path.
4. Try it in the viewer (Spark): load `static.spz` once and swap `frames_dyn/t_%04d.spz` per 100 ms.

## Files

- **On the pod, v59 run c:** `/workspace/work/v59/4dgs/`
  - `renders/`: GT | render for the 44 held-out frames.
  - `metrics.json`: includes the static-pipeline scores at the same cameras.
  - `video.mp4`: GT | 4DGS along the recorded path, 529 frames.
  - `video_fixedcam.mp4`: camera frozen mid-clip while time plays.
  - `motion.json`
  - `compare_c.jpg`, `compare_c.json`
  - `frames/`: `t_0000..0176.spz` plus `frames.json`. All Gaussians per 10 Hz frame, in the world frame, 5.0 MB each and 0.88 GB in total. The PLYs were deleted for disk space.
- **On the pod, v59 run e (final split):** `/workspace/work/v59/4dgs/split/`
  - `static.spz`: 3.4 MB.
  - `frames_dyn/t_0000..0176.spz`: 93 MB in total.
  - `frames_dyn/frames.json`
  - `metrics.json`, `motion.json`, `renders/`, `compare_e.jpg`, `compare_e.json`.
- **v59 run c spz:** `frames/t_*.spz`. Its PLYs were deleted for disk space.
- **On the pod, v71:** `/workspace/work/v71/4dgs/`
  - `metrics.json`, `renders/`, `video.mp4`, `video_fixedcam.mp4`.
  - `frames/t_0000..0387.spz` plus `frames.json` (1.9 GB, PLYs not kept).
- **Elsewhere on the pod:**
  - Models: `/workspace/4dgs/A/runs/{v59/c, v59d/e, v71/a}`. Run a is in `/workspace/4dgs/runs/v59/a`.
  - Datasets: `/workspace/4dgs/A/data/`.
  - Scores and logs: `/workspace/4dgs/A/out/`.
- **Code:** `pipeline/experiments/fourd/`:
  - `convert.py`
  - `train.sh`
  - `post.py` (eval, videos, export)
  - `post.sh`
  - `static_eval.py` (scores any splat PLY or an exported sequence at the held-out cameras)
  - `compare.py` (the comparison image)
  - `motion.py`
  - `fit_world.py`
  - `patch_4dgaussians.py`
  - `configs/`
