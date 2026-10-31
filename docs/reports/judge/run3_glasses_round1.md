# Judge panel, glasses footage, round 1 (before the capture-aspect fix)

# Judging report: video → 3D scenes

Scores are layout / colour / dynamic, out of 5. To pass, layout must be at least 3.5 and colour at least 3.

- **o3329, Palace of Fine Arts: short:** 3.25 / 2.7 / 3.2. Does not match.
- **v71, Stage and the hall:** 3.0 / 3.0 / 2.5. Does not match.
- **o3328, Palace of Fine Arts: rotunda and people:** 3.25 / 2.5 / 1.5. Does not match.

No clip lost tracking, so no fades were needed.

## Fixable in the pipeline

1. **Fix the aspect bug in the comparison first.** In every row the render looks about 1.33× too wide, while vertical positions are correct. On o3328 the cause is `compare.py` `frame_at()`, which squeezes the 3:4 video into the 9:16 screenshot. The other two clips show the same ratio, so the cause is probably the same. Because of this bug, objects at the edges look "missing", and layout, PSNR and SSIM are scored too low. Crop the video to 9:16 or capture at 3:4, then score again.
2. **Colour casts.** o3329 is blue/cyan throughout. v71 tints white walls peach and turns the tan teddy bear bright orange. o3328 renders tan stone salmon pink and the sky cyan. The baked colours need white balancing.
3. **People.** In o3328 most of the walkers in view have no ghost at all. In the other clips the ghosts are sparse dot clouds. Passers-by and the wearer's hand are baked into the static scene as streaks and blobs (o3329; v71 at 29.1 s). Mask them out of static training and make the ghosts denser.
4. **Sky and floaters.** o3329 has a fire-coloured smear over the sky and facade, o3328 has dark streaks across the sky, and v71 has stray blobs near the camera. Add a sky mask and prune floaters.

## Inherent to the footage

- Streaky ground and floors, caused by low texture, motion blur, and floor near the camera that is seen from few views.
- Distant sky and colonnade seen only briefly, blown-out skylights, a transparent acrylic podium, and a very close passer-by blurred by motion.

## Verdict

Not yet. Every row is clearly the right place and tracking holds throughout. Still, none of the three scenes largely matches its video from the recorded camera. Layout is below 3.5 in every clip, and colour is at or below its bar. Part of the layout gap comes from the comparison bug, not from the scenes. Fix the aspect handling and colour calibration, then score again. o3329 is closest to passing.


## Per-clip verdicts


### Palace of Fine Arts: short (`o3329`)

Judge: layout 3.5, colour 2.7, moving things 3.3, largely matches: False. Skeptic agrees: False (corrected 3.25/2.7/3.2)

Per-row scores (layout/colour/dynamic): 0.6 s 3/2.5/3, 1.7 s 3/2.5/3, 2.8 s 4/3/4, 4.0 s 3/2/3, 5.1 s 4/3/3, 6.2 s 4/3.5/4, giving averages of 3.5 / 2.7 / 3.3. No rows are marked tracking lost and none needs fading, since all rows are roughly aligned, so lost_rows_score 0 means not applicable. The ground-level scene is recognisably right in every row: path, lawn, mulch beds, lamppost, green door, bench and wall, with people present in roughly the right places. The 6.2 s person is especially good. The biggest problem is systematic and fixable: the render is stretched about 1.3x horizontally but not vertically compared with the video. That is almost certainly an intrinsics or aspect mismatch (fx ≈ 4/3 too large), and it shifts and resizes everything and crops edge content (the 5.1 s foreground person, the 6.2 s sign and the man behind the bench). There is also a global blue/cyan cast. On top of that: a fire-coloured sky and facade smear at 0.6 and 1.7 s, motion streaks from people baked into the path, the wearer's hand baked in as a pink blob at 2.8 s, and a rainbow-smeared close-up person at 4.0 s. Layout only just reaches 3.5 and colour fails its threshold (2.7 < 3), so the verdict is false. Fixing the intrinsics and colour calibration would likely lift this clip over the bar.

Defects:

- 6.2 s: Every row is stretched sideways by about 1.3x (close to 4/3) compared with the video, while vertical positions match. At 6.2 s the green door is 93 px wide in the render against 70 px in the video, and its top and bottom sit at the same y. The person, bench and lamppost are all pushed outward from the centre by the same factor, so the render shows only the middle ~75% of the video's width. This looks like an intrinsics or aspect mismatch, for example an fx meant for a 3:4 sensor frame used on a 9:16 video. (yes: camera intrinsics or render aspect in the pipeline/eval)
- 5.1 s: Every row has a blue/cyan cast: pavement looks blue-grey where the video shows neutral grey, and at 6.2 s the white T-shirt comes out light cyan. This is the main reason the hist metric is low on otherwise good rows (0.215 at 5.1 s). (yes: colour calibration / white balance of baked colours)
- 0.6 s: The top-right sky and the Palace rotunda facade are replaced by a large orange/yellow/white fire-like smear next to a cyan patch, where the video has blue sky and a beige building. The left-side trees and columns are dark, blurry smears. The Corinthian column at the right edge is missing because the stretch pushes it out of frame. (partly: sky/background handling and floater pruning; distant sky is inherently weak from 7 s of footage)
- 0.6 s: People walking on the left of the path show as dot ghosts squeezed toward the left, plus a blue/magenta motion streak baked into the static path at mid-left. The transient people were not fully removed from the static splat. (yes: mask people out of static training / prune transient splats)
- 1.7 s: The same orange/yellow blob fills the sky and building area at upper right. The family shows as dotted ghosts in roughly the right place but squeezed left. A whitish smear in the centre of the path marks where people walked. (partly: sky handling and transient masking)
- 2.8 s: The lawn is over-saturated blue-green and lacks the warm yellow-green sunlight of the video. A pink/magenta blob sits at bottom-left where the wearer's own hand appears, so the hand was baked in as a floater. The drain grate is pushed to the right edge by the stretch. The columns at the top are blurry. (yes: mask the wearer's hand, colour calibration, intrinsics)
- 4 s: The close-up person (black hoodie, beige trousers, white shoes) is a translucent smeared figure: the hoodie is teal, the trousers are almost transparent and the shoes are ghost outlines. The second person's blue jeans on the left come out as an iridescent rainbow smear over the left half of the frame. (partly: better dynamic-person handling and pruning; the very close, fast, motion-blurred subject is partly inherent to the footage)
- 5.1 s: The foreground person in jeans at the right edge is almost entirely missing (only a sliver of one shoe at bottom-right), and the object or person at the left edge is gone; both are cropped off by the horizontal stretch. Only one of the two distant walkers is visible. (yes: fixing the intrinsics stretch would bring them back into frame)
- 6.2 s: The man in sunglasses behind the bench and the white sign at the left edge are cropped out by the stretch. The wall is too pink/orange, the T-shirt is cyan, and there is slight smearing at the hands and phone. Otherwise geometry and the person are very good, and the lamp even glows. (yes: intrinsics and colour calibration)


Skeptic:

I agree with the verdict (false), the colour score (2.7), the diagnosis of a horizontal stretch from intrinsics, and almost every defect. I disagree on layout. The first judge gave 4 to the 2.8 s, 5.1 s and 6.2 s rows, but the rubric reserves 4 for "small blur or colour shifts". I measured the stretch in two rows and it is consistent:
- At 6.2 s the door is about 68 px wide in the video and 91 px in the render, and the lamppost and bench sit 1.27–1.31x further from the centre.
- At 5.1 s the lamppost is +87 px from the centre in the video and +113 px in the render, and the sign is +15 px against +20 px.
- Vertical positions match in both rows (door top and bottom, sign top, lamppost base).

That 1.3x sideways distortion pushes people and objects out of frame, so it is an obvious layout error, not a small one. Those rows deserve 3.5, which brings layout to 3.25. Layout then also misses the 3.5 bar, not just colour. Dynamic is slightly generous: the close person at 4.0 s is half-transparent, so I give 2.5 rather than 3, and the overall is 3.2 rather than 3.3. The first judge also missed a few defects: a black smudge on the sign at 5.1 s, a bike wheel missing at the left edge at 5.1 s, smeared columns and a yellow corner smear at 2.8 s, and a see-through ghost strip beside the person at 6.2 s.


### Stage and the hall (`v71`)

Judge: layout 3.2, colour 3, moving things 3, largely matches: False. Skeptic agrees: False (corrected 3/3/2.5)

The scene is recognisable throughout, but it does not very largely match the video. Layout scores by row: 3.2 s = 3, 9.7 s = 3.5, 16.2 s = 3.5, 22.6 s = 2.5, 29.1 s = 3, 35.6 s = 3.5. That averages about 3.2, below the 3.5 bar. Colour is about 3 in every row, so it only just meets its bar.

**What works**
- The stage backdrop with readable 'Cal HACKS' and 'HACKS 13.0' text, the podium position, the hanging banners and the hall are in the right places.
- The ceiling light rows and pillars in the hall (29.1 s and 35.6 s) line up well.
- The crowd and tables are present, though blurred.
- The speaker ghost is present at the correct spot in all six rows.

**Systematic problems**
- **Colour cast:** white walls and ceilings are tinted warm beige or peach in most rows.
- **Bear prop:** it is baked saturated orange instead of tan, mis-sized at 3.2 s and missing at 16.2 s. An orange floater with no counterpart in the video appears at 22.6 s.
- **Near-camera geometry:** the floor and stage front are smeared streaks in every row, and small objects such as the plastic bags are lost.
- **Misalignment:** horizontal offsets of about 10% at 9.7 s and 16.2 s, and about 40 px at 29.1 s.
- **Worst rows:**
  - 22.6 s: the backdrop panel and star on the right are replaced by a beige smear.
  - 29.1 s: the person's body is baked into the static hall as a white and dark smear behind the sparse ghost (centre SSIM 0.31).

**Metrics:** mean PSNR 14.1, SSIM 0.56, histogram match 0.82; centre third SSIM 0.47.

**Dynamic (3):** ghosts appear where the video has people. The bear prop is misplaced or missing at 16.2 s and 22.6 s, and a person is baked into the static room at 29.1 s.

**Verdict:** largely_matches = false, because layout averages about 3.2 against the 3.5 required. No row is below 2 on layout.

**Tracking lost:** no rows are flagged. Every row stays roughly aligned, so no fade is needed and the lack of one is justified. lost_rows_score = 0 means not applicable.

**Most fixable in the pipeline:** colour calibration of white surfaces and the carved prop, pruning floaters near the camera, masking people out of the static room, and pose alignment. **Largely inherent to the footage:** the transparent acrylic podium, blown skylights, and blur in the crowd of many small moving people.

Defects:

- 3.2 s: The teddy bear behind the speaker renders as a large, very saturated orange smear, stretched to the right (about x 130–400 against 160–350 in the video). The real bear is tan or beige. (fixable: colour calibration or baking of the carved prop splat, and its placement or scale)
- 3.2 s: The plastic bags and handbag in the lower left are missing; only a faint grey smear remains. The stage floor and the black front drop in the bottom 40% are streaky blur. (partly: the near-camera floor is under-observed (partly inherent); pruning and depth supervision near the camera could help)
- 3.2 s: The white wall and ceiling at upper left are a warm beige with a dark grey wedge across the top centre, where the video shows a light grey wall and ceiling. (fixable: colour and exposure calibration of low-texture white surfaces)
- 9.7 s: The upper 35% (ceiling and wall) has a warm beige or peach horizontal band and grey smears that are not in the video. (fixable: colour and appearance calibration)
- 9.7 s: The teddy bear on the right is saturated orange instead of tan, sits slightly too high, and its paw is missing. The backdrop's left edge is about 45 px too far left while the 'HACKS' text is about 20 px too far right, so the scale does not match. (fixable: prop colour and placement; the slight scale or alignment error comes from pose or intrinsics)
- 9.7 s: A bright floater blob sits at the bottom centre (around y 760) on the black stage front, and the front drop is grey and smeared. (fixable: pruning of floaters)
- 16.2 s: The bear paw in the lower right, clearly visible in the video, is almost entirely missing: only a sliver shows at the right edge. (fixable: carving or placement of the prop)
- 16.2 s: The white upper wall is a peach or beige smear. The 'Cal H' backdrop text is shifted about 45 px (10%) to the right. The speaker tower at the far left is barely visible. (fixable: colour calibration and pose alignment)
- 22.6 s: Worst layout row. The backdrop panel with the star on the right (the right 20% of the video frame) is replaced by a pale beige smear plus a narrow blue strip, and the star is missing. (partly: near-camera geometry seen from few views; alignment and depth may help)
- 22.6 s: An orange floater blob at the bottom edge (around x 90–150, y 690–800) has no counterpart in the video. It is likely the bear prop or a floater near the camera. (fixable: pruning, or prop placement and visibility)
- 22.6 s: The acrylic podium on the left is nearly invisible, and the floor and equipment cases are heavily blurred. (podium: inherent (transparent acrylic); floor blur: partly fixable)
- 29.1 s: Worst row overall (centre SSIM 0.31, centre PSNR 10.9). Behind the foreground person's ghost, a white vertical smear and a dark blob show the person's shirt and body baked into the static splat in the middle of the hall. (fixable: person masking or carving out of the static room)
- 29.1 s: The bright skylight and arch area at upper left renders as pinkish, blown-out smears, and the far doorway in the centre is dark orange. (partly inherent (blown highlights in the footage); colour calibration could help)
- 29.1 s: The plastic bag on the right is shifted about 40 px to the right. The crowd and tables are recognisable but blurred, and the foreground person's ghost is very sparse and barely reads as the large dark-sweater figure. (alignment: fixable; ghost density: fixable; crowd blur: largely inherent (many small moving people))
- 35.6 s: The upper-left white wall is a peach or beige blotchy smear with dark patches. The bear in the lower left is only partly present (orange fragment). The black monitor wedge is shifted slightly right. (fixable: colour calibration and prop placement)


Skeptic:

I agree with the verdict: largely_matches = false. The colour score of 3 and the absence of tracking-lost rows also check out. I disagree on two points: the layout and dynamic scores are a little generous, and the diagnosis of the defects is substantially wrong.

The biggest problem in every row is one systematic camera error that the first judge missed. The render is stretched horizontally about 1.33 times around the frame centre, while the vertical position is correct. I measured this five ways:
- 29.1 s: the spacing between ceiling lights is about 71 px in the video and about 95 px in the render.
- 9.7 s: the backdrop's left edge is at x 95 in the video and x 50 in the render, while 'HACKS' moves from about 325 to about 355.
- 3.2 s: the hanging banners spread out by about 1.35×.
- 35.6 s: the podium is 135 px wide in the video and 175 px in the render.
- 22.6 s: the speaker tower moves from x 90 to x 40.

A 1.33 ratio is exactly 4:3 against 16:9. That suggests the render camera's horizontal focal length or aspect ratio is wrong, either in the pipeline's camera intrinsics or in how the comparison harness renders.

Several defects the first judge blamed on prop carving or placement are explained by this stretch alone:
- the bear 'stretched to x 130–400' at 3.2 s (exactly 160–350 × 1.33);
- the missing bear paw at 9.7 s and 16.2 s (pushed out of frame);
- the missing star and the 'narrow blue strip' at 22.6 s (the panel starts at video x 360, which maps to 405, so the star leaves the frame);
- the 'Cal H' text shifted 45 px at 16.2 s;
- the bag shifted 40 px at 29.1 s;
- the speaker tower 'barely visible' at 16.2 s (out of frame).

The first judge also has one row wrong. At 3.2 s the 'dark grey wedge across the top centre' matches the video's dark ceiling. The real error there is the warm beige cast on the light grey wall.

With a constant one-third error in horizontal size, I would score layout at about 3 in most rows and 2.5 at 22.6 s, averaging about 3.0 rather than 3.2. The verdict stays false.


### Palace of Fine Arts: rotunda and people (`o3328`)

Judge: layout 3.25, colour 2.5, moving things 1.5, largely matches: False. Skeptic agrees: True (corrected 3.25/2.5/1.5)

Verdict: does not largely match. It fails on layout (non-lost rows average about 3.25, below the 3.5 bar) and on colour (about 2.5, below 3); no row falls below 2 on layout. Per-row layout: 3.6 s = 3, 10.8 s = 3, 18.0 s = 3, 25.2 s = 3.5, 32.4 s = 3.5, 39.5 s = 3.5.

Layout: the scene is clearly the Palace of Fine Arts in every row, with the rotunda, free-standing colonnade, exhibition-hall wall, doors, trees, lampposts and path roughly where they should be. The rotunda views are the weakest. At 10.8 s (PSNR 11.4, centre SSIM 0.35) the columns are smeared and stretched 30-50 px off, and at 18.0 s the tower is shifted and the sky is full of dark floaters. At 3.6 s the left colonnade is a dark block. The wall rows (25-40 s) are better aligned, but doors and lampposts are off by 40-50 px at 32.4 s and the green doors vanish at 25.2 s and 39.5 s.

Colour: there is a systematic warm, saturated cast. Tan stone renders salmon pink in half the frames, the sky is too cyan and blotchy, the rotunda is oversaturated, and the asphalt is bluish.

Moving things: people are almost entirely missing. There are no ghosts at 3.6 s, 18.0 s, 32.4 s or 39.5 s, even though the video shows many walkers and a foreground person at 39.5 s. The only ghosts are a sparse, edge-clipped one at 10.8 s and another at 25.2 s.

No rows are flagged tracking lost, so there is no lost-row score (0 means N/A), and fading nothing is correct: the alignment, while imperfect, is plausible in every row. fade_justified=true means no fade was needed.

Most likely fixes in the pipeline:
- ghost generation for walkers
- colour calibration for the pink and cyan cast
- sky masking and floater pruning
- pose or FOV refinement around the rotunda (10-18 s)

Inherent to the footage: ground smearing and some distant-structure loss, from low texture and motion blur.

Defects:

- 3.6 s: About 10 people walking on the path (the couple holding hands, the yellow shirt, the group on the right) have no ghost at all. The render shows an empty road, and the diff shows every person at full strength. (fixable: person detection or ghost generation is missing these walkers)
- 3.6 s: Upper-left sky is blotchy cyan with dark floater streaks running into the top of the colonnade tower. (fixable: sky masking or a sky dome, plus floater pruning)
- 3.6 s: The peristyle colonnade and lawn on the left are replaced by a dark grey block. The tall exhibition-hall wall on the far right is mostly lost behind smeared trees. (partly fixable (densification and coverage); partly inherent, because this area is distant and only seen briefly)
- 3.6 s: Asphalt is bluish-grey and smeared into streaks; the tyre-mark texture is gone. (colour cast is fixable; smearing is largely inherent (low texture plus motion blur))
- 10.8 s: Worst row (PSNR 11.4, centre SSIM 0.35). Rotunda columns are smeared into vertical streaks. The right-hand column group and urns sit 30-50 px (about 7-10%) right of the video, which looks like a horizontal stretch, and the diff doubles edges across the whole structure. (fixable: pose or FOV alignment refinement for this stretch, more training on the close-up views)
- 10.8 s: Rotunda colours are oversaturated orange and red. The sky is deep cyan, with a dark smear at top right and dark blobs inside the arch opening. (fixable: colour calibration and floater pruning)
- 10.8 s: The man walking in the left foreground appears only as a sparse speckle strip at the frame edge, not at his body position. The background walkers under the arch are missing. (fixable: ghost placement and density)
- 18 s: Most of the sky in the upper half is covered with large dark streak and blob floaters. (fixable: sky mask or floater pruning)
- 18 s: The free-standing colonnade tower sits about 30 px left of the video, is too wide, and its column detail is mush. The rotunda column on the right is thinner than in the video. (fixable: alignment and densification)
- 18 s: About 8 people on the path (pink-shirt woman, white-top woman with phone, two dark-clothed men) have no ghosts. The render path is empty. (fixable: ghost generation)
- 25.2 s: The green lattice door at the left is a dark brown recess. The tan stone wall renders salmon pink. (colour is fixable; the door is partly a coverage or appearance-model issue (fixable))
- 25.2 s: The woman in the red jacket in the foreground is only a sparse dot ghost, cut off at the right edge and shifted 30-40 px right. The man behind her, the crouching person and the cyclist are missing as ghosts. (fixable: ghost placement and detection of small figures)
- 25.2 s: Deciduous-tree foliage bleeds into the wall. Floaters in the top-right sky. The ground is streaky. (partly fixable (pruning); ground streaking largely inherent)
- 32.4 s: The beige wall renders strongly salmon or pink, and brown smear blobs cover the wall left of the first door. (fixable: colour calibration and pruning)
- 32.4 s: The right double door is shifted about 40 px right and cut off, and the lamppost about 50 px. The diff doubles both door outlines. The tall tree trunk at the left edge is missing. Blotchy sky at top. (fixable: alignment, FOV or distortion check)
- 32.4 s: The person at the left edge of the frame is missing. (fixable: ghost generation)
- 39.5 s: The girl in the white sweater and jeans in the right foreground has no ghost. The distant walkers on the path (about 6) are missing. (fixable: ghost generation)
- 39.5 s: The green door at the right is gone (pink or dark recess). The wall is pink instead of tan. The ground shows radial smear streaks. (colour fixable; door and ground partly inherent (motion blur, low texture))


Skeptic:

I agree with the verdict (does not largely match) and the numbers: layout about 3.25, colour about 2.5 (below the bar of 3), dynamic 1.5, and no rows with lost tracking. I disagree with much of the defect diagnosis. Most of the "misalignment" the first judge reported comes from a bug in the comparison script, not from the reconstruction.

The clip is 962x1280, which is 3:4 (checked with ffprobe on data/work/o3328/input/clip.mp4). pipeline/memreplay/compare.py frame_at() resizes it straight to the 450x800 (9:16) screenshot, so the video column is squeezed horizontally to 0.75. I searched for the scale that best aligns the edges of render and video. In all 6 rows the best fit is 1.325-1.35 horizontally and 1.00 vertically. That raises the edge correlation from 0.24-0.32 to 0.54-0.71. So the render has the same vertical view as the video, but it only covers the middle 75% of the video's width, shown at true proportions.

These first-judge items are caused by that squeeze, and the fixes it proposed (pose or FOV refinement) won't help:
- 10.8 s: the "horizontal stretch", the columns and urns 30-50 px off, and the doubled edges.
- 18 s: the tower "30 px left and too wide".
- 32.4 s: the door and lamppost shifts.
- 10.8 s and 25.2 s: the ghosts "at the edge or shifted right". Both sit exactly where the squeeze predicts, so they are placed correctly; they are just too sparse.

Several things the first judge called "missing" lie outside the area the render can show:
- 25.2 s and 39.5 s: the green doors.
- 32.4 s: the tree trunk and the person at the left edge.
- 39.5 s: the girl in white.
- 18 s: the pink-shirt woman.
- 3.6 s: most of the exhibition-hall wall on the far right.

Fix the comparison script first: crop the centre of the video frame to 720x1280 before resizing, or capture at a 3:4 viewport. Then score again; PSNR and SSIM are currently pushed down by the misalignment.

Even after correcting for the squeeze, the scores barely change:
- Layout stays near 3.25 because of the sky floaters (3.6 s, 18 s), the dark block in place of the colonnade (3.6 s) and the smeared columns (10.8 s).
- Colour fails on its own: the stone is pink or salmon, the rotunda is oversaturated orange, and the sky is cyan.
- People in view are still missing at 3.6 s, 10.8 s, 18 s, 25.2 s and 39.5 s.

The verdict holds. My corrected object below keeps the same scores, with the defect list fixed.
