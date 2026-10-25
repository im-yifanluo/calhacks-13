# Judge run 4: glasses scenes, final pipeline (part 3: hall, long walk)

# Judging report: video → 3D scene pipeline

## Per-clip scores (skeptic-corrected)

- **v106, hackathon hall, long walk:** layout 3.2 · colour 2.8 · dynamic 2.75 · PSNR 14.8, SSIM 0.54, histogram match 0.64 · worst row 45 s (PSNR 11.3) · tracking lost: none, so no fade was needed · **largely matches: no**

The skeptic lowered colour at 35 s (3.5 → 3) and dynamic at 25 s (4 → 3.5). It put layout at 3.0–3.2 but changed no row. Neither change affects the verdict.

## Most important defects

**Fixable in the pipeline**
1. **Black or grey ceiling.** Black voids or grey mush replace the grey ceiling and trusses at 5, 25, 45 and 55 s. At 45 s the whole top band is black, and at 55 s the top-left is. This needs far-field or sky fill. The dark triangles at 5 s are a degraded copy of the real truss, not invented floaters.
2. **Floaters.** A dark red blob sits in the lower left at 15 s, a dark chunk hangs from the ceiling at 35 s, and a bright beige blob sits at bottom centre at 45 s. Pruning should remove them.
3. **Transient people baked into the static scene.** At 45 s smeared seated people appear on a visible empty chair. Walkers in the central aisle at 15 s have no ghosts. Better masking of moving people, plus ghosts for distant people, would fix both.
4. **Orange or red cast** on the table crowds, worst at 55 s. Colour calibration should correct it.

**Inherent to the footage**
5. **Lost detail in crowds and nearby subjects.** Densely packed moving crowds smear: laptops and table edges are lost. Very close, motion-blurred people vanish with no ghost (15 s, 45 s). The low-texture floor and thin chair legs are lost. More weight on near-field density might help a little.

Much of what looks like a baked crowd at 45 s sits behind the hooded person in the foreground. There the render shows what is behind that person, so it does not contradict the video.

## Verdict

**The scene does not yet largely match the video from the recorded camera.** Camera tracking is excellent. Pillars, banners, screens, light rows and the booth line up within a few pixels in every row. The far background is recognisably the same hall throughout. Layout (3.2, needs at least 3.5) and colour (2.8, needs at least 3) miss the bar because of the ceiling, floaters and baked crowds. The standing group at 25 s is handled well, with ghosts in the right places. Ceiling fill, floater pruning and masking of moving people are all pipeline work and would likely push this clip over the line. Crowd smear will remain.
