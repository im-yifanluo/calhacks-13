# Judge run 4: glasses scenes, final pipeline (part 2: colonnade walk 2, garden)

# Judging report: Palace of Fine Arts clips

**Final scores (1–5; to pass, layout must be at least 3.5 and colour at least 3)**

- **o3331, colonnade walk 2:** layout 3.5, colour 2.8, dynamic 3.5. **Does not largely match.** The skeptic overturned a narrow pass because colour had been rounded up.
- **o3332, garden and people:** layout 3.4, colour 2.8, dynamic 3.0. **Does not largely match.** Both judges agree.

Tracking held in every row of both clips, so leaving all rows unfaded is correct.

**Fixable in the pipeline**

1. **Colour cast.** This shows in every row of both clips. Sunlit stone comes out saturated orange, often blotchy or with rainbow streaks. Asphalt is blue-grey and grass is neon. The worst case is the o3331 rotunda at 5 s, where the colour-histogram match is 0.24. Fixes:
   - calibrate colour and white balance
   - handle bright highlights
   - limit how much the appearance model can change colour on geometry seen from few views

   The judges think this alone could lift o3331's colour score to about 3.
2. **Far-field smears and floaters.** In the late rows of o3331 and the second half of o3332, flame-like orange, pink or white streaks replace the colonnade and dome. There is also a bright blob at the vanishing point. Prune the far field and fill it with sky rather than leaving smeared splats.
3. **People and props.**
   - People at mid range, at the frame edge or in the distance often have no ghost. At 29 s in o3332 almost nobody is shown.
   - In o3331 at 15 s, a passer-by who was not masked out is baked into the static scene.
   - o3332 has solid boxes that are not in the video (a blue block, a green box and a brown box).

   Fixes: mask passers-by before training, lower the person-detection size threshold, and check where props are placed.

**Inherent to the footage**

4. **Close-range geometry seen in one pass.** A single forward walk past plain stone and walls cannot resolve the near columns (o3331 at 15 s) or the wall texture (o3331 at 55 s). Ground seen at grazing angles comes out streaked. In o3332 the camera passes close to the bushes, so there are few clear views of the background behind them.

**Overall verdict**

Not yet. Seen from the recorded camera, the layout holds at every sampled moment. Paths, lawns, the colonnade, benches, the cart and the near walkers' ghosts are all in the right places, so the structure is there. Both clips fall short on colour, and in o3332 the background also breaks down from about 29 s. Fixing the colour cast is the cheapest and most effective change, and it would probably be enough for o3331 to pass. o3332 also needs the far-field cleanup and better tracking of people.
