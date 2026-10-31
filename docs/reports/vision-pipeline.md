# Vision pipeline report: video → walkable 3D room → moving layer

CalHacks 13, October 24, 2026. The runbook is [pipeline/README.md](../../pipeline/README.md).

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
- **Day 2 evening, the demo footage (Ray-Ban Meta glasses, 9 clips, 7 s to 60 s, indoors and out)**: all nine convert
  end to end into walkable scenes with moving people ghosts; from the recorded camera they score 16–19 dB (best:
  the colonnade walk 2 at 19.3, the rotunda at 18.7 with a real sky, the speaker at 18.3). The judge panel's verdict:
  layout holds in every clip and camera alignment never slips; the two stage clips pass the bar, the five outdoor clips fail
  it on colour by 0.1–0.25 (a warm cast on walls and sandstone), the top thing to fix next, and the two crowded hall
  walks fail on layout too (people baked into the room as smears). The viewer now opens a
  memory in **follow mode** (ride the recorded walk, pause to roam). A parallel **real 4DGS** track reaches 30.5 dB
  on the speaker clip with sharp moving people but is not yet a VR scene (details in §3).
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

| Clip      | Scene                                            | Static file                           | Dynamic file                   | Hands-on                               |
| --------- | ------------------------------------------------ | ------------------------------------- | ------------------------------ | -------------------------------------- |
| `img8013` | Hotel room (bed, desk, kettle, bathroom), 42 s   | `memories/img8013/memory.static.json` | `memories/img8013/memory.json` | works, kind of                         |
| `img8014` | Room corner (TV, couch, lamp), 11 s              | `memories/img8014/memory.static.json` | `memories/img8014/memory.json` | works                                  |
| `img8015` | Hotel corridor (vacuums, towels), 73 s           | `memories/img8015/memory.static.json` | `memories/img8015/memory.json` | works, kind of                         |
| `img8016` | Hotel lobby (plants, front desk, 2 people), 34 s | `memories/img8016/memory.static.json` | `memories/img8016/memory.json` | works, kind of (half is lost tracking) |
| `img8017` | Night street walk (14 pedestrians), 2 min 22 s   | `memories/img8017/memory.static.json` | `memories/img8017/memory.json` | not checked by hand                    |

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

| clip                            | length | floor fit | cam height | room Gaussians (pruned) | props | ghosts | lost tracking         | PSNR | SSIM | colour | centre SSIM |
| ------------------------------- | ------ | --------- | ---------- | ----------------------- | ----- | ------ | --------------------- | ---- | ---- | ------ | ----------- |
| Hotel room (`img8013`)          | 42 s   | assumed   | 1.42 m     | 380,785 (107,967)       | 19    | 0      | none                  | 13.9 | 0.72 | 0.64   | 0.72        |
| Hotel room corner (`img8014`)   | 11 s   | found     | 1.61 m     | 378,725 (70,279)        | 4     | 0      | none                  | 20.5 | 0.87 | 0.83   | 0.90        |
| Hotel corridor (`img8015`)      | 73 s   | found     | 1.62 m     | 334,570 (164,296)       | 4     | 0      | 1.2 s                 | 16.4 | 0.62 | 0.79   | 0.59        |
| Hotel lobby (`img8016`)         | 34 s   | found     | 1.40 m     | 378,143 (120,777)       | 6     | 1      | 13.3 s in 4 stretches | 18.2 | 0.70 | 0.60   | 0.68        |
| Night walk downtown (`img8017`) | 142 s  | found     | 1.58 m     | 241,221 (258,779)       | 0     | 2      | none                  | 17.6 | 0.60 | 0.68   | 0.61        |

<!-- /RESULTS-TABLE -->

How the day's changes moved the numbers (PSNR / SSIM from the recorded camera, tracked rows):

| clip                 | morning (first run)        | clean retrain | + depth supervision + bake | + exposure replay + viewer gain (final) |
| -------------------- | -------------------------- | ------------- | -------------------------- | --------------------------------------- |
| Hotel room           | fog (floor fit on the bed) | 14.6 / 0.73   | 13.8 / 0.70                | 13.9 / 0.72                             |
| Room corner          | 19.0 / 0.88                | 20.3 / 0.89   | 20.2 / 0.88                | 20.5 / 0.87                             |
| Corridor             | ~11, streaked              | 11.2 / 0.50   | 15.9 / 0.60                | 16.4 / 0.62                             |
| Lobby (tracked half) | ~17                        | 17.9 / 0.72   | 18.1 / 0.70                | 18.2 / 0.70                             |
| Night walk           | not scored                 | 18.2 / 0.68   | 17.6 / 0.64                | 17.6 / 0.60                             |

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

### The demo footage: Ray-Ban Meta glasses, evening of Oct 24

Nine clips recorded with the glasses (portrait ~1500×2000, 30 fps, HLG; 7 s to 60 s): four indoors at the
hackathon (a speaker at a podium on a stage, the stage and the hall, two walks through the hall with the crowd)
and five outdoors at the Palace of Fine Arts (rotunda, colonnade walks, a garden, many people walking). What
changed for them: ViPE estimates the wide lens itself (59° × 74° at the normalized size), no undistortion step was
needed; the floor fit prefers the plane that puts the camera at the glasses' eye height (1.75 m; the stage top had
been taken for the floor); people standing on a stage or step are kept as ghosts (their "floating" test is now
against the room collider under them), mask bleed onto walls no longer stretches a ghost (points trimmed to 1 m
around the person); worn and carried things (lanyards, shoes, bags, phones, cameras) are no longer carved out as
props; the HLG→SDR curve was refitted (reference white had been 4× too bright); and with the Anthropic API key out
of credits from ~7 PM, noun lists and prop descriptions came from hand-written tables
(`objects/manual_specs.json`) instead of Claude.

What the glasses scenes look like from the recorded camera (grids in `apps/web/public/memories/<id>/compare.jpg`):

- **Stage, speaker at the podium (v59)**: the demo scene. The speaker stands as a moving point ghost at the podium in
  every sampled moment; bear, backdrop, stage and bag in place; the acrylic podium is only partly there; the far left
  of the hall smears. PSNR 18.3 / SSIM 0.75. The judges' "phantom tan box beside the podium" was the teddy's
  fallback primitive (its splat carve found 45 Gaussians): the teddy is now a fixture and stays in the room.
- **Stage and the hall (v71)**: same stage, then the camera turns to the crowded hall: the speaker ghost holds, the
  hall is recognisable but blurry, seated people become a textured mass, 11 walking people are ghosts.
- **Palace of Fine Arts, short (o3329)**: ground-level path, lawn, planters, sign and door right where they are; six
  people as ghosts including the companion a metre away and the man with headphones; the sunlit tree tops still
  wash into a yellow smear. 17.9 dB.
- **Rotunda and colonnade (o3328)**: the rotunda, colonnade, exhibition wall and doors are clearly the place, under a
  smooth blue sky (a dome of Gaussians about 100 m out) with warm stone and pavement; the close-up of the columns
  blurs; people far down the paths were missing until the ghost depth limit was raised from 8 m to 30 m. 18.7 dB,
  up from 17.6 (sky dome, identity viewer gain) and from a black-sky 11.2 in between.
- **Hall walks (v83, v106)**: the hall itself holds (roof trusses and light strips, banners, tables, chairs), the seated
  crowd becomes a textured mass and walkers pixel mosaics; v106 (60 s, the crowd overflowing ViPE's instance ids,
  so 2 s keyframes) is the weakest scene at 14.8 dB, with the companion's shoulder filling two of the six moments.
- **Colonnade walks (o3330, o3331) and the garden (o3332)**: the path, lawns, lamp posts, bench and colonnade line up
  in every moment and the walkers pass as ghosts; the sunlit stone comes out too orange and the near colonnade
  smears on the single forward pass. 18.4, 19.3 (the best outdoor score) and 17.4 dB.

Lessons from this footage: the capture viewport must match the clip's aspect (a 9:16 viewport on 3:4 footage
stretched every render 1.33× and cost 3 dB in every score, found by the judge panel); crowds overflow ViPE's 255
instance ids (capped at 250); sky needs its own handling outdoors: sky pixels are now kept in the loss and seeded
on a dome 150 m out (100 m after the rotunda's rescale), and the splat prune, which used to throw away everything
beyond 80 m or bigger than 1.5 m, had to learn about the far field (the rotunda rendered a _black_ sky at 11 dB
until it did: its sky is about 7,900 opaque Gaussians of 1–5 m at 94 m); and a per-clip viewer colour correction
that helped indoors made these scenes slightly worse, so it is off by default.

<!-- GLASSES-TABLE -->

Scores from the recorded camera (six moments per clip, render vs video; PSNR in dB; colour = histogram match;
centre = middle third), final pipeline of Oct 24, 9:30 PM PT. `pipeline/tools/results_table.py` regenerates this table.

| clip                                              | length | floor fit | scale | cam height | room Gaussians (pruned) | props | ghosts | lost tracking | PSNR   | SSIM  | colour | centre SSIM |
| ------------------------------------------------- | ------ | --------- | ----- | ---------- | ----------------------- | ----- | ------ | ------------- | ------ | ----- | ------ | ----------- |
| Stage: speaker at the podium (`v59`)              | 18 s   | found     | 1.41  | 1.74 m     | 415489 (84511)          | 0     | 3      | 0 s in 0      | 18.313 | 0.748 | 0.725  | 0.623       |
| Stage and the hall (`v71`)                        | 39 s   | found     | 1.0   | 1.51 m     | 408415 (88102)          | 3     | 11     | 0 s in 0      | 17.697 | 0.72  | 0.819  | 0.616       |
| Hackathon hall walk (`v83`)                       | 45 s   | found     | 1.0   | 1.68 m     | 403242 (96343)          | 12    | 31     | 0 s in 0      | 16.055 | 0.576 | 0.626  | 0.528       |
| Hackathon hall, long walk (`v106`)                | 60 s   | found     | 1.0   | 1.64 m     | 308010 (190815)         | 12    | 14     | 0 s in 0      | 14.783 | 0.537 | 0.644  | 0.517       |
| Palace of Fine Arts: short (`o3329`)              | 7 s    | found     | 1.0   | 1.84 m     | 465104 (33996)          | 1     | 7      | 0 s in 0      | 17.868 | 0.63  | 0.401  | 0.621       |
| Palace of Fine Arts: rotunda and people (`o3328`) | 43 s   | found     | 0.68  | 1.73 m     | 263874 (236126)         | 0     | 14     | 0 s in 0      | 18.698 | 0.69  | 0.598  | 0.676       |
| Palace of Fine Arts: colonnade walk (`o3330`)     | 60 s   | found     | 1.0   | 1.81 m     | 314620 (185380)         | 4     | 13     | 0 s in 0      | 18.357 | 0.677 | 0.431  | 0.67        |
| Palace of Fine Arts: colonnade walk 2 (`o3331`)   | 60 s   | found     | 1.0   | 1.85 m     | 296454 (203104)         | 2     | 14     | 0 s in 0      | 19.283 | 0.699 | 0.577  | 0.714       |
| Palace of Fine Arts: garden and people (`o3332`)  | 50 s   | found     | 1.0   | 1.87 m     | 362130 (137622)         | 11    | 5      | 0 s in 0      | 17.405 | 0.558 | 0.869  | 0.547       |

<!-- /GLASSES-TABLE -->

### Hands-on check (Oct 24, 3 PM PT)

Walked through in the web viewer: the **room corner** works; the **hotel lobby**, **corridor** and **hotel room**
work, kind of: you can walk them and recognise the place, with the smears, floaters and washed patches the judges
list below. The night walk was not checked by hand.

**9 PM PT, glasses scenes, in the viewer's new follow mode** (you ride the recorded walk at eye height and choose
where to look; Space pauses everything and frees you to walk anywhere; Play glides you back): the **colonnade walk**
(o3330) carries you along the path with the people ghosts walking past, and stepping off the path while paused
shows the colonnade from the lawn; the **rotunda** (o3328) has a smooth blue sky and warm stone where the earlier
render was blue-grey. Quest and phone are still untested.

### Independent judge panel

An Opus judge scored every clip's grid (layout, colour, moving things, each 1–5), listing every defect it saw and
whether it looked fixable in the pipeline; a second Opus model then re-judged the same grid as a skeptic, told to
catch generosity and harshness alike; a third wrote the summary. The bar we set: layout ≥ 3.5 and colour ≥ 3 on
average, no row below 2 on layout, lost-tracking rows scored apart. (`pipeline/tools/judge.js`, run through
Claude Code's Workflow tool; the full verdicts, defect lists and skeptic notes are in [judge/](judge/).)

<!-- JUDGE-TABLE -->

| clip        | layout | colour | moving things | verdict                                                    | the skeptic        |
| ----------- | ------ | ------ | ------------- | ---------------------------------------------------------- | ------------------ |
| Room corner | 4.0    | 3.0    | 4             | **passes**, at the bar                                     | agrees             |
| Lobby       | 3.6    | 2.8    | 4             | fails on colour; 3 of 6 rows lost tracking, fade justified | agrees             |
| Corridor    | 3.4    | 2.75   | 4             | fails, narrowly on both                                    | agrees             |
| Hotel room  | 3.2    | 2.7    | 4             | fails: bathroom rows 2.5, floaters, cast                   | agrees (3.0 / 2.5) |
| Night walk  | 2.9    | 2.8    | 3             | fails: ground near the camera is mush, cars missing        | agrees             |

<!-- /JUDGE-TABLE -->

#### Glasses scenes, final pipeline (Oct 24, 9 PM PT)

Same panel and bar (layout ≥ 3.5 and colour ≥ 3), run on the final renders (`judge/run4_glasses_final_*.{json,md}`).

<!-- GLASSES-JUDGE -->

| clip                                              | layout | colour | moving things | verdict                    | the skeptic          |
| ------------------------------------------------- | ------ | ------ | ------------- | -------------------------- | -------------------- |
| Stage: speaker at the podium (`v59`)              | 3.60   | 3.20   | 4.0           | **passes**, narrowly       | agrees               |
| Stage and the hall (`v71`)                        | 3.75   | 3.20   | 3.5           | **passes**, narrowly       | agrees               |
| Hackathon hall walk (`v83`)                       | 3.25   | 2.90   | 2.6           | fails on layout and colour | agrees               |
| Palace of Fine Arts: rotunda and people (`o3328`) | 3.60   | 2.90   | 3.0           | fails on colour            | agrees               |
| Palace of Fine Arts: short (`o3329`)              | 3.70   | 2.90   | 3.4           | fails on colour            | agrees               |
| Palace of Fine Arts: colonnade walk (`o3330`)     | 3.50   | 2.75   | 2.5           | fails on colour            | agrees               |
| Palace of Fine Arts: colonnade walk 2 (`o3331`)   | 3.50   | 2.80   | 3.5           | fails on colour            | corrected (stricter) |
| Palace of Fine Arts: garden and people (`o3332`)  | 3.40   | 2.80   | 3.0           | fails on layout and colour | agrees               |
| Hackathon hall, long walk (`v106`)                | 3.20   | 2.90   | 2.8           | fails on layout and colour | agrees               |

<!-- /GLASSES-JUDGE -->

The panel's summary, in substance: _geometry and camera alignment hold in every clip and layout passes in five of six;
only the two stage clips pass on both counts, and only just; the two crowded hall walks also miss on layout. Colour
decides the result_: grey walls come out peach,
the teddy and the sandstone saturated orange, tan brick salmon, the short clip with a cyan cast. After colour: people
baked into the static room as smears where they sat or passed (hall walk, colonnade), walkers missing or rendered as
sparse mosaics, floaters (sky blobs, flame-like smears on distant buildings, needle streaks on pavement), the phantom
tan box beside the podium. Inherent to the footage: the clear acrylic podium, fast pans, distant colonnades with no
parallax, textureless walls and thin things.

Their summary, verbatim in substance: _"From the recorded camera the geometry usually holds: the poses line up and
every indoor room is recognisable. The scenes fall short mainly on colour and splat noise, both pipeline problems
rather than footage limits."_ The defects they called fixable: the warm cast on whites (every clip), floaters and
stretched splats on walls and carpets, props carved out but not drawn, cars not treated as moving objects, the
night walk's pavement close-up not faded. Inherent to the footage: motion-blur streaks on carpet, overexposed
white tile, window reflections and lamp glow, night flare.

Compared with the panel's first pass on the morning's retrain (room corner 3.4 / 3.0, hotel room 3.0 / 2.6, corridor
2.3 / 1.7, night walk 3.0 / 2.8): the room corner went from a narrow fail to a pass, the corridor gained a full
point on layout and a point on colour (depth supervision), the hotel room and night walk moved little. The last
round of changes (the viewer gain in §4) targets the cast the panel still saw on every clip.

### Real 4DGS against the layered pipeline (Oct 24, evening)

While the layered pipeline ran, an independent agent trained true 4D Gaussian splatting on two glasses clips on a
second pod: 4DGaussians (hustvl, CVPR 2024: canonical Gaussians plus a HexPlane deformation field), built in about
10 minutes with small patches. Full report with method, settings and incidents: [4dgs.md](4dgs.md);
code: `pipeline/experiments/fourd/`; side-by-side image: [4dgs-vs-static-v59.jpg](images/4dgs-vs-static-v59.jpg) (video | ours |
4DGS, six moments of the speaker clip).

| v59 (speaker at the podium), 44 held-out frames, recorded camera                       | PSNR     | SSIM      | LPIPS     | people px | other px |
| -------------------------------------------------------------------------------------- | -------- | --------- | --------- | --------- | -------- |
| 4DGS, vanilla (run c)                                                                  | **30.5** | **0.934** | **0.163** | 25.1      | 31.1     |
| 4DGS, split room / people + random background (run e, retrained to completion 9:18 PM) | 29.2     | 0.913     | 0.213     | 25.9      | 29.5     |
| Layered pipeline, static room (`baked.ply`)                                            | 18.2     | 0.794     | 0.338     | 9.1       | 20.0     |

v71 (stage, then a crowded hall), 97 held-out cameras: 4DGS 28.7 / 0.905 / 0.218 against 18.0 / 0.777 / 0.389 for
the static room; on people pixels 25.7 against 9.5 dB.

What it means:

- **From the recorded camera, real 4DGS wins by a wide margin.** People are sharp, solid splats that move as in the
  video, and it needs no segmentation or tracking at all. Our people are point ghosts, hence 9 dB on people pixels.
- **Vanilla 4DGS is not a VR scene.** Every Gaussian may move, so the deformation field absorbs camera-pose error and
  the whole room wobbles (background Gaussians drift a median 7 cm; invisible from the recorded camera, a shimmer
  from anywhere else). It trains over white, so bright walls come out see-through (21 dB instead of 30.5 on a dark
  background). The export is 880 MB for 17 s. Nothing in it is an object, so nothing can be grabbed or thrown.
- **The split variant fixes three of the four**: only Gaussians seeded on people deform, training uses a random
  background. Retrained to completion (33 min on one H200): the room is exactly static (median motion 0.0 cm, p90
  2.2 cm), the export is opaque, and the payload is `static.spz` (3.4 MB) plus 0.53 MB per 10 Hz frame (93 MB for
  v59), for 1.3 dB less than vanilla. On the pod: `/workspace/work/v59/4dgs/split/` (`static.spz`, `frames_dyn/`,
  `frames_dyn/frames.json`).
- **Caveat on the numbers**: held-out frames sit between training frames on the same path, which favours 4DGS, and
  nobody has looked at either from a new viewpoint in VR. The two methods were trained on different tone-mappings of
  the same clip (the colour fix landed between them), so the image's raw per-row PSNRs are not comparable; after a
  global colour match 4DGS leads 24.1 to 20.6 dB.
- **Cost**: 31–44 min on one H200 per clip (17 min for our static room), 3 GB of PLY plus 0.9 GB of spz per clip,
  which is what filled the volume.
- **Where each fits**: 4DGS for reliving the moment from where you stood (the viewer's follow-the-walk mode), the
  layered scene for walking around with physics and props. The split export (one static splat plus a people splat
  swapped every 100 ms) is the version worth loading in the viewer; not done tonight.

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

- **Colour of the input (fixed Oct 24 evening)**: the HDR → SDR conversion in S1 made every clip too bright and
  flat with a pale sky: it put HLG reference white at 85 % brightness, about 4× too high. Refitted to how macOS/iOS
  render the same frames (16 frames from the iPhone samples, Ray-Ban Meta exports and outdoor clips): proper HLG
  inverse OETF, system gamma 0.85, full signal → SDR white, soft shoulder. Error against Apple's rendering went
  from 36 to about 1 level of 255 ([before/after](images/colour-fix.jpg)). Every scene in §3 was trained on the old,
  washed-out conversion, so their colours (and the viewer-gain fits) are relative to it; re-run S1 onward for any
  clip whose colours matter.
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

**Glasses footage, evening (Oct 24)**

- **Black sky on the rotunda (found 8:25 PM)**: the sky-dome retrain scored 11.2 dB against 17.6 before. The dome had
  worked (7,900 opaque Gaussians 94 m out), but `layers` pruned everything beyond 80 m or bigger than 1.5 m, rules
  written for floaters indoors. Fix: beyond 60 m the size limit grows with distance (0.06 m per metre), the needle and
  haze rules are off, and only faint far Gaussians (opacity < 0.1) go. Re-layered from the trained splats, no retrain.
- **The shared volume filled up (8:20 PM)**: the 4DGS track exported 3 GB of per-time PLYs per run; at 100 % every
  write on both pods failed and the three trainings in flight (o3331, o3332, v106) and their queue workers died
  silently (their logs could not even record the error). Restarted at 8:37 PM after the agent freed 25 GB; exports
  are spz-only from here, and the agent keeps 15 GB free.
- **Phantom box in the demo scene**: a prop whose carve finds too few Gaussians falls back to a primitive drawn in
  front of the object still in the room; for the giant teddy that was an opaque tan box. Fixed by data (the teddy is
  a fixture in `manual_specs.json`); the general rule, drop or hide such props, is in §5.
- **Decoders disagree on the tone-mapped clips**: the 4DGS agent found the pod's OpenCV and ffmpeg 16 levels apart
  on the same frame (the clips still carry HLG/BT.2020 tags after the LUT). Measured at the end of the night on the
  rotunda, frame 312: the training JPEG the pod's OpenCV produced averages RGB 111/114/115, the laptop's ffmpeg
  (what `compare` and the judges see) 106/109/110, the laptop's OpenCV 107/110/111: a uniform +4.5-level offset
  in training, worth about 0.1 dB, not the warm cast. Fix next: decode frames with one tool everywhere (ffmpeg,
  which S1 already uses) and strip the HLG tags after tone mapping.

## 5. What to improve next (in order of value)

1. **Colour, in the viewer, once for every scene.** The bake already matches the trainer's own renders to the frames
   (per-channel gain within 2–5 % of 1), yet what the viewer shows is warmer and brighter: the gap is in Spark's
   compositing of the same Gaussians, and it is what the judges mark down on every outdoor clip. Measure it once (a
   synthetic colour-chart splat rendered by gsplat and by Spark) and correct it in the viewer, instead of the per-clip
   affine fit tried today, which flattened contrast and cost 0.3–1.5 dB.
2. **People who sit or linger, and props that fail to carve** (a prop with too few carved Gaussians should stay in the room, not become a box). ViPE's people masks (dilated 12 px) keep walkers out of the room, but people who sit
   or pass slowly get baked in as smears (hall walk, colonnade). Mask by motion as well as by class, or drop frames
   where a person covers the same pixels for seconds; and give ghosts denser points on the upper body.
3. **Record a clip made for this**: walk sideways while panning, phone at one height, someone tossing a ball and
   walking through. Then test real Ray-Ban Meta footage (ultrawide: undistort first; ViPE's depth assumes a pinhole).
4. **Trained people** (the real "4D" step; the 4DGS track above shows the payoff, 25 dB on people pixels against 9):
   freeze the static room, then train moving Gaussians only on the people masks, with a few shared motion bases per person, supervised by the frames, ViPE's depth and 2D point tracks
   (CoTracker3, `setup.sh extras`). Methods: Shape of Motion, MoSca, RiGS (static/rigid/transient Gaussians; code
   available). Or fit an animatable body avatar for a full 360° person (a single camera never sees their back).
   Budget ~0.5–2 GPU-hours per clip; keep moving Gaussians ≲ 100–200k for the Quest.
5. **Rotating props**: track points on each prop (CoTracker3), lift them with depth, fit a rotation per frame
   (Kabsch). Props then spin when thrown in the recording, not only slide.
6. **Better camera paths** for hard clips: refine ViPE's poses with bundle adjustment on our frames (COLMAP/GLOMAP),
   or try MegaSaM / MapAnything (the runbook's fallbacks); the splat's pose refinement already helps a little.
7. **Sharper rooms**: 30k steps, more frames, depth supervision from ViPE; Spark's LoD for big scenes like the street.
8. **Run the worker live** against SpacetimeDB and the bucket (written and unit-checked, not yet run end to end).

## 6. Costs and time

- Runpod H100 at about $4/h: $25 of credit covered setup, five ViPE runs, five static rooms and two earlier splat
  rounds (≈ 5 h). Day 2: a 2× H100 pod ($8/h) retrained all five rooms three times while the floor fit and the
  pose-refinement setting were sorted out (≈ 1.5 h, ≈ $12).
- ViPE: about 2 frames/s on the H100 (11 s clip: 3.7 min; 2½ min clip: 34 min).
- Oct 24 evening (the demo footage): pod A (2× H100, $7.99/h) from 5:30 PM and pod B (2× H200, $10.59/h, the 4DGS
  track plus one pipeline worker) from 6:40 PM, both still running at 9:30 PM: about $70 for nine glasses scenes
  (each retrained two to three times as the colour fix, the sky dome and the prune changes landed), two 4DGS runs
  and the split retrain. One glasses clip: ViPE 3–8 min, room 17–20 min on a shared GPU, layers and merges 1 min.
- Static room: 7–8 min per clip on one H100 (20k steps at ~50 it/s, 400 frames, 500k Gaussians); two rooms train
  side by side on two GPUs. Props layer + pose export + both memory files + verify: about 2 min.
- S3–S5 on the pod's CPUs: 1–4 min per clip; all five in parallel in under 3 min.
- Scoring a clip against its video (6 renders + grid): about 1 min on the laptop.
