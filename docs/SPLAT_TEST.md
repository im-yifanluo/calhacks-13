# Public Gaussian-splat tests

Run `node scripts/setup-splat-test.mjs`, then `npm run dev`.
The setup downloads a checksum-verified public Spark sample, generates a small floor, and writes Git-ignored fixtures. It can be rerun using the cached sample.

- [One stationary splat](http://localhost:5173/?memory=/splat-test/rendering.json): 178,093 total splats including the floor.
- [Two copies](http://localhost:5173/?memory=/splat-test/two-splats.json): 355,225 total splats.
- [Interaction](http://localhost:5173/?memory=/splat-test/interaction.json): pause, grab/drag, release, and replay a take.

This tests the existing viewer without changing its source. The generic viewer text still mentions a ball/pipeline assets; these presets use a public butterfly sample and approximate test colliders. They are not team footage or evidence that the reconstruction pipeline works.

Source: [Spark butterfly SPZ](https://sparkjs.dev/assets/splats/butterfly.spz). Publisher and credits: [sparkjsdev/assets](https://github.com/sparkjsdev/assets). No asset license is inferred from the renderer's code license. Downloaded assets are not committed.

Verified locally: visible SPZ rendering, both load levels, and actual pointer grab/release on the interaction preset. No page errors were reported. Physical Quest stereo, head tracking, and the plan's 72 FPS target remain unverified. Use the README's USB/HTTPS setup to open the same URLs on Quest.
