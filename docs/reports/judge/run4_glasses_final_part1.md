# Judge run 4: glasses scenes, final pipeline (part 1: six scenes)

# Judging report: video → 3D scenes

A clip passes if, seen from the recorded camera, it scores at least 3.5 on layout and at least 3 on colour (out of 5). Scores below are layout / colour / motion. Where the second judge corrected a score, the corrected score is used.

- **v59, stage, speaker at the podium:** 3.6 / 3.2 / 4.0. Passes, narrowly.
- **v71, stage and the hall:** 3.7 / 3.1 / 3.5. Passes, narrowly.
- **v83, hackathon hall walk:** 3.25 / 2.6–2.9 / 2.3–2.6. Fails on layout and colour.
- **o3328, Palace rotunda:** 3.6 / 2.8–2.9 / 3.0. Fails on colour.
- **o3329, Palace short:** 3.75 / 2.9 / 3.4. Fails on colour.
- **o3330, Palace colonnade:** 3.6 / 2.7 / 2.3. Fails on colour.

No clip lost tracking, so nothing needed fading.

## Fixable in the pipeline
1. **Colour calibration (the biggest problem).** Grey walls come out peach, and the teddy and the sandstone come out saturated orange. Tan brick turns salmon-pink, and o3329 has a cyan cast throughout. Colour alone fails three clips.
2. **People baked into the static scene.** Seated and passing people end up in the room as smears (v83, o3330). The wearer's hands end up in the pavement (o3329).
3. **Missing people.** Most walkers are missing in o3330, and every person is missing late in o3328. The people who do appear are often pixel mosaics, the wrong colour, or full of holes.
4. **Floaters and bad props.** Problems include:
   - blobs in the sky
   - flame-like smears on distant buildings
   - smeared upper walls and bright floor patches
   - needle-shaped streaks on the pavement
   - orange splats right at the camera
   - a phantom tan box beside the podium, and a white bin rendered orange

## Inherent to the footage
- The clear acrylic podium is faint or missing.
- Fast pans and blur from walking smear the floors and nearby ground.
- Distant colonnades, bleachers and buildings show little parallax.
- Textureless walls and thin things (fence, vines, cables) don't reconstruct.

## Verdict
**Not yet.** Geometry and camera alignment hold in every clip, and layout passes in five of six. But only the two stage clips pass on both layout and colour, and only just. Colour decides the result: fixing the colour calibration would probably turn the three Palace clips into passes. The hall walk (v83) also needs people masked out of the static room.
