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
- **What still limits quality**: ViPE's camera path wobbles or glitches on some clips (worst: the lobby, a third of
  its frames), its depth scale wobbles ±10 % frame to frame on close-up clips, and people are only points, not trained
  splats. None of the 5 clips has a thrown object, so throws are tested only on the synthetic scene.

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
      ─ S6 STATIC ROOM: gsplat on all frames, only people masked, poses refined   ──► memory.static.json
      ─ S6b LAYERS: carve each prop's Gaussians out of the room (multi-view mask vote) ─► room + prop splats
      ─ S7 merge  ──► memory.json (room + props + ghosts + head path + audio)
```

**Static layer** (S6 `--static`): gsplat MCMC, about 20k steps, up to 400 of the sharpest frames, up to 500k
Gaussians (Spark's default budget on Quest), seeded from the room points, with people and hands masked out of the loss
and per-frame exposure and camera-pose refinement on. Every 12th frame is held out to measure PSNR.

**Dynamic layer**:
- **Props** (S6b): first the static splat's own floor is found near the walked path and the splat is shifted so it
  sits exactly on y = 0 (the lobby's was 11 cm low). Then each prop is carved out: a Gaussian belongs to the prop if it
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

(Filled in below from `memreplay verify` and gsplat's held-out evaluation; per-clip numbers live in
`<work>/verify/report.json` and `<work>/world/world.json` on the pod.)

<!-- RESULTS -->

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
- **Tracking glitches**: ViPE lost the lobby path near a close, dark wall (325 of 1015 frames jump > 15 cm). Fix:
  detect and leave those frames out of the geometry; smooth the head path through them.
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
  sides of every view are blurry or empty. Pan wider when recording.

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
  rounds (≈ 5 h).
- ViPE: about 2 frames/s on the H100 (11 s clip: 3.7 min; 2½ min clip: 34 min).
- Static room: about 9 min per clip (20k steps at ~40 it/s); props layer: under a minute.
- S3–S5 on the pod's CPUs: 1–4 min per clip.
