# Vision pipeline report: video → walkable 3D room → moving layer

Oct 24, CalHacks 13. Built on branch `pipe/vision`; runbook in [pipeline/README.md](../pipeline/README.md).

## TL;DR

- **Works today, for all 5 sample clips** (iPhone 14 Pro Max, `data/samples`): each becomes
  - `memory.static.json`: **the room alone as a Gaussian splat, at real scale with a level floor**, to walk through
    on the Quest (left stick walks, right stick turns). This is the thing to demo first.
  - `memory.json`: the same room **plus the dynamic layer**: people as moving point "ghosts", the small props as
    their own splats you can grab and throw (simple-shape colliders, masses from Claude), the head path, the audio.
- **The approach is layered, not "4D everything"**: one static room trained on every frame, with only the moving
  things on top. The room gets every frame's view, so it is the sharpest part; the layers reuse its camera path and
  world frame.
- **How well it matches the video** (§3): from the recorded camera, the room corner is the same scene at a glance
  (PSNR 20, SSIM 0.88); the night walk, lobby (where tracking held) and hotel room are recognisably the same place
  with blur and colour shifts; the corridor is the weakest (streaks along the walk, much improved by depth
  supervision). An independent judge panel scored every clip; the per-clip verdicts and defects are in §3.
- **What still limits quality**: ViPE's camera path wobbles or glitches on some clips (worst: the lobby, a third of
  its frames, blacked out in the viewer), forward walks give little parallax (corridor), close-ups of white surfaces
  never get enough views (bathroom), the phone's auto-exposure changes frame to frame (now replayed in wearer's
  view), and people are only points, not trained splats. None of the 5 clips has a thrown object, so throws are
  tested only on the synthetic scene.
- **Day 2 in one line**: two silent failures found and fixed (the floor fit took a bed for the floor; removing the
  appearance model made every training collapse), depth supervision from ViPE added, colours calibrated against
  the frames, guided exploration and the render-vs-video scoring built, five rooms retrained four times.

## 1. Use it right now

**On the Quest (static walk-through).** The memories are in `apps/web/public/memories/<clip>/` (git-ignored; copy
them over with `memreplay publish` or the rsync line in the runbook).
```bash
LOCAL_HTTP=1 npm run dev
adb reverse tcp:5173 tcp:5173
```
Quest Browser → `http://localhost:5173/?memory=/memories/img8016/memory.static.json` → **Enter VR**. One-time headset
setup: root README, Part 3.

| Clip | Scene | Static file | Dynamic file |
|---|---|---|---|
| `img8013` | Hotel room (bed, desk, kettle, bathroom), 42 s | `memories/img8013/memory.static.json` | `memories/img8013/memory.json` |
| `img8014` | Room corner (TV, couch, lamp), 11 s | `memories/img8014/memory.static.json` | `memories/img8014/memory.json` |
| `img8015` | Hotel corridor (vacuums, towels), 73 s | `memories/img8015/memory.static.json` | `memories/img8015/memory.json` |
| `img8016` | Hotel lobby (plants, front desk, 2 people), 34 s | `memories/img8016/memory.static.json` | `memories/img8016/memory.json` |
| `img8017` | Night street walk (14 pedestrians), 2 min 22 s | `memories/img8017/memory.static.json` | `memories/img8017/memory.json` |

**On a laptop**: same URLs at `http://127.0.0.1:5173/...`; tick **Wearer's view** to watch from the recorded head
path, **Colliders** to see the physics shapes. In `memory.json`, pause (Space), then drag a prop to throw it.

**A new clip** (pod, setup in the runbook): `memreplay run $WORK/<id> --title "..." --eye-height 1.35` does every
step and writes both files; `memreplay verify` measures it; `memreplay publish ... --to <dir>|s3` ships it.

## 2. What the pipeline does

```
video ─ S1 normalize (HDR→SDR LUT, 30 fps, 1280 px) ─ S1 nouns (Claude lists the props)
      ─ S2 ViPE: camera path, lens, metric depth per pixel, object/person masks
      ─ S3 world frame: up, floor, glitch frames, re-levelling, scale  ──► every frame's pose in meters, floor at 0
      ─ S5 select: which masked things are props (Claude: shape, size, mass, free-standing?)
      ─ S4 room points + collider + people ghosts
      ─ S5 tracks: 10 Hz positions + velocity for each prop
      ─ S6 STATIC ROOM: gsplat on all frames, only people masked, ViPE depth as supervision ──► memory.static.json
      ─ S6c BAKE: colours at the mean exposure, calibrated against the frames; each frame's own exposure saved
      ─ S6b LAYERS: prune floaters/needles, carve each prop's Gaussians out of the room ─► room + prop splats
      ─ S7 merge  ──► memory.json (room + props + ghosts + head path + exposure + lost-tracking gaps + audio)
      ─ compare: render from the recorded camera, score against the video; judge panel
```

**Static layer** (S6 `--static`): gsplat MCMC, about 20k steps, up to 400 of the sharpest frames, up to 500k
Gaussians (Spark's default budget on Quest), with people and hands masked out of the loss, the per-image appearance
model on (without it the training collapses, §4), and **depth supervision**: ~140k points sampled from ViPE's depth
maps seed the Gaussians and give gsplat's depth loss a target in every frame, which stops Gaussians stretching along
the walking direction. Every 12th frame is held out to measure PSNR. **Bake** (S6c): the appearance model is
evaluated at the mean embedding, then a per-channel gain and bias is fitted so gsplat's renders match the training
frames on average, and each frame's own gain/bias is stored on its camera keyframe (`e`) so the viewer can replay the
phone's auto-exposure in wearer's view.

**Dynamic layer**:
- **Props** (S6b): first the room is pruned: Gaussians within 0.5 m of the walked path, giants, needles (one axis
  more than 8× the next and longer than 12 cm), big faint blobs, and anything fewer than two frames ever saw. (An
  earlier floor snap that moved the whole splat onto y = 0 is off: it was reading a couch or bed as the floor and
  moved rooms by up to 0.35 m.) Then each prop is carved out: a Gaussian belongs to the prop if it
  lands on the prop's mask in ≥ 70 % of the ≥ 3 frames that see it; if that finds too little, everything inside the
  prop's box (20 % larger, above the surface it rests on) is taken. Those Gaussians become the prop's own `.spz`
  (object-local coordinates) and leave the room, so picking a prop up leaves no copy behind. The prop moves along its
  track; physics uses its sphere/box/cylinder. Props with fewer than 50 Gaussians keep a tinted shape.
- **People**: per-keyframe colored points (`points-sequence`, ≤ 12k points per person per frame), not grabbable.
- **Head path**: the wearer's camera at 10 Hz (Wearer's view).

**"4D training" today means**: the room is trained once (3D, static); time lives in the layers (prop tracks, ghost
frames, head path), which are measured from the video rather than trained. §5 is how to make the moving parts trained
splats too.

## 3. Results

All five clips go through the whole pipeline and load in the viewer (free, guided and wearer's view; dynamic and
static files). The numbers below are from the recorded camera, at the video's field of view, over six moments
spread through each clip (`memreplay compare`, §4 "Measuring"); rows where tracking was lost are excluded from the
means and listed separately. "Room Gaussians" is what is left after pruning floaters, giants and needles from the
500k trained; "props" are the carved-out grabbable objects; "ghosts" are people shown as point clouds.

<!-- RESULTS-TABLE -->
| clip | length | floor fit | cam height | room Gaussians (pruned) | props | ghosts | lost tracking | PSNR | SSIM | colour | centre SSIM |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Hotel room (`img8013`) | 42 s | assumed | 1.42 m | 380,785 (107,967) | 19 | 0 | none | 13.9 | 0.72 | 0.64 | 0.72 |
| Hotel room corner (`img8014`) | 11 s | found | 1.61 m | 378,725 (70,279) | 4 | 0 | none | 20.5 | 0.87 | 0.83 | 0.90 |
| Hotel corridor (`img8015`) | 73 s | found | 1.62 m | 334,570 (164,296) | 4 | 0 | 1.2 s | 16.4 | 0.62 | 0.79 | 0.59 |
| Hotel lobby (`img8016`) | 34 s | found | 1.40 m | 378,143 (120,777) | 6 | 1 | 13.3 s in 4 stretches | 18.2 | 0.70 | 0.60 | 0.68 |
| Night walk downtown (`img8017`) | 142 s | found | 1.58 m | 241,221 (258,779) | 0 | 2 | none | 17.6 | 0.60 | 0.68 | 0.61 |
<!-- /RESULTS-TABLE -->

How the day's changes moved the numbers (PSNR / SSIM from the recorded camera, tracked rows):

| clip | morning (first run) | clean retrain | + depth supervision + bake | + exposure replay + viewer gain (final) |
|---|---|---|---|---|
| Hotel room | fog (floor fit on the bed) | 14.6 / 0.73 | 13.8 / 0.70 | 13.9 / 0.72 |
| Room corner | 19.0 / 0.88 | 20.3 / 0.89 | 20.2 / 0.88 | 20.5 / 0.87 |
| Corridor | ~11, streaked | 11.2 / 0.50 | 15.9 / 0.60 | 16.4 / 0.62 |
| Lobby (tracked half) | ~17 | 17.9 / 0.72 | 18.1 / 0.70 | 18.2 / 0.70 |
| Night walk | not scored | 18.2 / 0.68 | 17.6 / 0.64 | 17.6 / 0.60 |

Depth supervision is what rescued the corridor (+5 dB); it did nothing for the short room corner and cost the night
walk a little (its ViPE depth is noisy at street distances). Exposure replay adds 0.3–0.5 dB where the camera's
exposure moved, and makes the lamp rows of the room corner clip to white exactly as the video does. The viewer gain
(the last change) left PSNR and SSIM where they were and raised the colour-histogram match a little on four clips
(room corner 0.75 → 0.83); it was not re-judged.

What the grids show (`apps/web/public/memories/<id>/compare.jpg`, also linked from the status page):
- **Room corner**: the same scene at a glance: TV, couch, pillow, papers, lamp in place; the bright wall around the
  lamp is washed out and the far edges blur. Best clip.
- **Night walk**: crosswalks, shop fronts, buildings and cars in the right places over 140 s of street; blur where
  cars were moving and in the last close-up of the ground. Two pedestrians survive as ghosts.
- **Lobby**: the first half (red chairs, bar, escalator) matches well; the second half is the stretch where ViPE
  lost the camera path near a dark wall, and the viewer blacks it out on purpose (the recording is unusable there).
- **Hotel room**: desk, bed, window, couch and bathroom are all recognisable from the recorded camera, but smeared
  along the walking direction (the forward-motion artifact), and the bathroom is the weakest part.
- **Corridor**: layout right (doors, exit sign, carpet, cart) but the Gaussians streak from the vanishing point:
  forward motion with no depth constraint, plus ViPE's path along texture-poor walls. The clip that needs the depth
  supervision described in §4.

### Independent judge panel

An Opus judge scored every clip's grid (layout, colour, moving things, each 1–5), listing every defect it saw and
whether it looked fixable in the pipeline; a second Opus model then re-judged the same grid as a skeptic, told to
catch generosity and harshness alike; a third wrote the summary. The bar we set: layout ≥ 3.5 and colour ≥ 3 on
average, no row below 2 on layout, lost-tracking rows scored apart. (`pipeline/tools/judge.js`, run through
Claude Code's Workflow tool; the full verdicts, defect lists and skeptic notes are in `docs/judge/`.)

<!-- JUDGE-TABLE -->
| clip | layout | colour | moving things | verdict | the skeptic |
|---|---|---|---|---|---|
| Room corner | 4.0 | 3.0 | 4 | **passes**, at the bar | agrees |
| Lobby | 3.6 | 2.8 | 4 | fails on colour; 3 of 6 rows lost tracking, fade justified | agrees |
| Corridor | 3.4 | 2.75 | 4 | fails, narrowly on both | agrees |
| Hotel room | 3.2 | 2.7 | 4 | fails: bathroom rows 2.5, floaters, cast | agrees (3.0 / 2.5) |
| Night walk | 2.9 | 2.8 | 3 | fails: ground near the camera is mush, cars missing | agrees |
<!-- /JUDGE-TABLE -->

Their summary, verbatim in substance: *"From the recorded camera the geometry usually holds: the poses line up and
every indoor room is recognisable. The scenes fall short mainly on colour and splat noise, both pipeline problems
rather than footage limits."* The defects they called fixable: the warm cast on whites (every clip), floaters and
stretched splats on walls and carpets, props carved out but not drawn, cars not treated as moving objects, the
night walk's pavement close-up not faded. Inherent to the footage: motion-blur streaks on carpet, overexposed
white tile, window reflections and lamp glow, night flare.

Compared with the panel's first pass on the morning's retrain (room corner 3.4 / 3.0, hotel room 3.0 / 2.6, corridor
2.3 / 1.7, night walk 3.0 / 2.8): the room corner went from a narrow fail to a pass, the corridor gained a full
point on layout and a point on colour (depth supervision), the hotel room and night walk moved little. The last
round of changes (the viewer gain in §4) targets the cast the panel still saw on every clip.

## 4. What went wrong, and what we did

In the order we hit it. Every fix is in the code and the runbook.

**Setup (pod)**
- **CUDA mismatch**: `cuda-toolkit` from NVIDIA's channel lost to conda-forge's newest (13.4 + gcc 15) while torch is
  12.8 → gsplat refused to build. Fix: pin `cuda-version=12.8` and check nvcc.
- **ViPE built against the image's Debian Python** would fail (split `pyconfig.h`). Fix: uv's own Python
  (`UV_PYTHON_PREFERENCE=only-managed`). Found by a source review before running.
- **gsplat took over 2 hours to build**: three world-space batch rasterizer files (unused by us) compile extremely
  slowly with CUDA 12.8 for three GPU types; the rest takes ~20 min with ninja (without ninja: one file at a time).
  Next time: `TORCH_CUDA_ARCH_LIST="9.0"` on an H100-only pod.
- `pip install -e pipeline` failed (two top-level folders); the Linux OpenCV wheel has no EXR codec (ViPE's depth);
  the NFS volume refuses chown. All fixed or worked around.

**Footage**
- **iPhone HDR** (HLG, BT.2020, 10-bit): plain decoding gives washed-out colours. Fix: a generated HLG→SDR 3D LUT.
- **Long, mostly static walkthroughs**: great for the room, but there are no throws and few people, so the moving
  layer is thin on these clips.

**Geometry**
- **Floor and "up"**: averaging the cameras' up direction was 22–30° off when the phone pointed down at a couch. Fix:
  up from the cameras' right axes (a hand-held phone barely rolls), then the best horizontal plane.
- **"Sky" indoors**: ViPE's sky prompt fires on overexposed walls and lamps, which punched holes in the room. Fix: "sky"
  closer than 20 m counts as room.
- **Stacked floors**: the camera path drifts up and down over long walks (lobby: 0.8–1.8 m), so the floor came out as
  several layers. Fix: re-level every frame against the floor seen below it. That then **sank frames looking down at a
  couch** (the seat looked like floor; the paper on it jumped 0.4 m). Fix: ignore floor samples that put the camera
  > 0.2 m off its usual height or > 0.3 m off the floor plane. (A code review found the same bug independently.)
- **The bed as the floor** (hotel room, found on the second day): the best-supported horizontal plane was the bed, 18°
  off the camera-based up, so the room was scaled 2× and the re-levelling then moved frames by up to 0.78 m; the
  trained room was a blur. Fix: a floor must have almost nothing below it (≤ 10 % of all points more than 0.1 m
  below, or ≤ 25 % if it agrees with the camera up within 12°); otherwise no floor is trusted and the camera is
  assumed at the expected height, which is what the hotel room gets (its floor is barely in view). The levelling gate
  now compares each floor sample with the height the floor fit gave, not with the samples' own median (which followed
  the bed). RANSAC also looks for 10 planes instead of 6.
- **Tracking glitches**: ViPE lost the lobby path near a close, dark wall (325 of 1015 frames jump > 15 cm). Fix:
  detect and leave those frames out of the geometry; smooth the head path through them.
- **Pose refinement in the splat trainer**: gsplat's camera refinement at its default rate moves cameras by ~2 mm (so
  it does nothing); at 100× the rate it moved the training cameras by 4 cm / 1° and the held-out cameras no longer
  matched (room corner PSNR 19 → 8). Left at the default; path drift is handled by the levelling above instead.
  Baking those jittered cameras into `cameras.json` and retraining on them also ruined the next run, so the
  refinement now always starts from ViPE's cameras (`cameras.vipe.json`).
- **The viewer renders brighter and warmer than gsplat**: the same exported splat comes out 15–40 levels brighter
  in the midtones (red most) in Spark than in gsplat's rasterizer, while a synthetic flat grey splat renders exactly
  right, so it is a compositing difference on real, semi-transparent scenes rather than a colour-space bug (the SPZ
  and PLY paths agree; Spark's own sRGB handling was checked). Rather than chase it, the bake also applies a
  per-clip gain/bias fitted from the viewer's own renders to the frames (`pipeline/tools/viewer_gain.py`, written
  to `world/viewer_gain.json`): 0.96–0.99 on the rooms, 0.90 on the corridor's red, 0.73–0.83 on the night walk.
- **Training collapse without `--app_opt`**: dropping gsplat's per-image appearance embedding (its colour correction is
  lost at export, so it looked like a free simplification) made the MCMC training diverge on these auto-exposed
  phone clips: the loss climbs after ~20 % of the steps and 85 % of the Gaussians end with opacity < 0.002 (room
  corner: 13k usable Gaussians instead of 390k; the room renders as fog). Restored. The exported colours are then a
  little averaged across frames, which the comparison grids show as small colour shifts, not as blur.
- **Depth-scale wobble**: on close-up clips each frame's depth is ±10 % off its neighbours. We tried rescaling every
  frame against a shared map, and pairwise between nearby frames; **both made reprojection worse** (room corner
  11 → 17–20) because pose errors leak into the ratios. Switched off (`world.ALIGN_DEPTH`).

**The splat vs the measured geometry**
- The trained room looks right from the recorded viewpoints (§3), but its Gaussians don't sit on the measured surfaces:
  in the lobby only 8 % of its opaque Gaussians are within 5 cm of the room points (median 37 cm), and its floor was
  11 cm low and 0.5 m thick. A splat only has to look right from the training views; ViPE's pose wobble makes that
  easier to satisfy with floating Gaussians. Consequences: the floor snap above, and the props layer's mask vote
  rarely succeeds, so most props are carved by box. Fix: depth supervision from ViPE and better poses (§5).
- **Untrained edges**: the phone filmed in portrait (36° wide); the viewer, and the Quest even more, shows ~100°, so the
  sides of every view are blurry or empty. Pan wider when recording. In the viewer this is now handled by **guided
  exploration** (`?mode=guided`, or the "Guided path" toggle): the recorded path is drawn on the floor, the head is
  kept inside a 0.75 m corridor around it, and the view fogs out as the gaze turns past what the camera ever saw;
  stretches where tracking was lost (`timeline.gaps`) fade to black. Free mode (`?mode=free`) shows the path only.

**Measuring "does it match the video"**
- `memreplay compare` scores viewer renders against the video frames (PSNR, SSIM, colour-histogram match, whole frame
  and centre third) and writes a grid (original | render | difference) per clip. Renders come from the recorded
  camera at the video's field of view, captured headless (`pipeline/tools/capture.js`, Chrome + Metal, 450×800); the
  headless renders score the same as the ones taken by hand in a browser (room corner: 19.3 vs 19.0 dB), so the
  numbers are repeatable. gsplat's own held-out PSNR is **not** a substitute: it compares against un-refined cameras
  and drops to 8 dB when the trainer moves cameras, while the room still matches the video.

**Objects**
- **Identity hops**: ViPE's tracker moves an id between look-alike objects (one "sign" spanned 8 m). Fix: split ids at
  physically impossible jumps, then rejoin pieces that sit in the same place.
- **Fixtures as props**: exit signs, a wall painting, hooks, a mirror. Fix: Claude also answers "free-standing or
  mounted?" given the measured height above the floor; mounted things stay in the room.
- **Off-centre props**: views cut by the image edge pull the centre sideways. Fix: static props use whole views only.
- **Code review** (19 agents, findings checked by a skeptic each): 16 confirmed issues, all fixed, e.g. fast throws
  split into two objects, gap filling drew fake arcs for carried objects, the last batch of room points was dropped,
  wall columns were blurred out of the collider, the worker would hang a job on a stage error.

## 5. What to improve next (in order of value)

1. **Record a clip made for this**: walk sideways while panning, phone at one height, someone tossing a ball and
   walking through. Then test real Ray-Ban Meta footage (ultrawide: undistort first; ViPE's depth assumes a pinhole).
2. **Trained people** (the real "4D" step): freeze the static room, then train moving Gaussians only on the people
   masks, with a few shared motion bases per person, supervised by the frames, ViPE's depth and 2D point tracks
   (CoTracker3, `setup.sh extras`). Methods: Shape of Motion, MoSca, RiGS (static/rigid/transient Gaussians; code
   available). Or fit an animatable body avatar for a full 360° person (a single camera never sees their back).
   Budget ~0.5–2 GPU-hours per clip; keep moving Gaussians ≲ 100–200k for the Quest.
3. **Rotating props**: track points on each prop (CoTracker3), lift them with depth, fit a rotation per frame
   (Kabsch). Props then spin when thrown in the recording, not only slide.
4. **Better camera paths** for hard clips: refine ViPE's poses with bundle adjustment on our frames (COLMAP/GLOMAP),
   or try MegaSaM / MapAnything (the runbook's fallbacks); the splat's pose refinement already helps a little.
5. **Sharper rooms**: 30k steps, more frames, depth supervision from ViPE; Spark's LoD for big scenes like the street.
6. **Run the worker live** against SpacetimeDB and the bucket (written and unit-checked, not yet run end to end).

## 6. Costs and time

- Runpod H100 at about $4/h: $25 of credit covered setup, five ViPE runs, five static rooms and two earlier splat
  rounds (≈ 5 h). Day 2: a 2× H100 pod ($8/h) retrained all five rooms three times while the floor fit and the
  pose-refinement setting were sorted out (≈ 1.5 h, ≈ $12).
- ViPE: about 2 frames/s on the H100 (11 s clip: 3.7 min; 2½ min clip: 34 min).
- Static room: 7–8 min per clip on one H100 (20k steps at ~50 it/s, 400 frames, 500k Gaussians); two rooms train
  side by side on two GPUs. Props layer + pose export + both memory files + verify: about 2 min.
- S3–S5 on the pod's CPUs: 1–4 min per clip; all five in parallel in under 3 min.
- Scoring a clip against its video (6 renders + grid): about 1 min on the laptop.
