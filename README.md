# Memory Replay

Record a moment on Meta Ray-Ban glasses → we rebuild it as a 4D scene (3D + time) → you and your friends walk back into it together on a Quest 3S or a phone. Pause time, grab things, and branch off an alternate timeline.

Full plan, system design, and timeline: [docs/PLAN.md](docs/PLAN.md)

## Layout

```
apps/web/            Viewer: one WebXR web app for Quest 3S browser + phones + laptops
                     (three.js + Spark splats + Rapier physics + SpacetimeDB client)
server/spacetime/    SpacetimeDB module: rooms, players, shared playhead, branches, object overrides
packages/shared/     memory.json contract (TypeScript). Python mirror: pipeline/memreplay/manifest.py
pipeline/            Python GPU pipeline: video -> poses/depth -> segments -> splat + meshes + tracks -> memory.json
docs/                Plan, architecture, demo script
data/                Local scratch (git-ignored). Big assets go to object storage, not git.
```

## Quick start

```bash
npm install
npm run dev                 # https://<laptop-ip>:5173 (self-signed; accept the warning on Quest)
npm run tunnel              # public https URL for phones/judges (needs cloudflared)
```

SpacetimeDB (local):

```bash
spacetime start                         # terminal 1
npm run stdb:publish:local              # terminal 2: build + publish the module
npm run stdb:generate                   # regenerate client bindings into apps/web/src/module_bindings
```

## How we work

- **The contract is `memory.json`.** Pipeline and viewer only talk through it. Change it in both `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py` in the same PR, and tell the channel.
- **Viewer is built against `apps/web/public/mock/memory.json`** until the pipeline produces real scenes. Never block on the pipeline.
- **Branches:** `web/*`, `stdb/*`, `pipe/*`, `demo/*`. Small PRs into `main`, merge fast, no long-lived branches. `main` must always run.
- **Assets:** never commit `.ply/.spz/.glb/.mp4`. Upload to the shared bucket and put the URL in the manifest.
- **Sync points:** standups at the times in the plan. Post blockers right away; don't sit on them.
