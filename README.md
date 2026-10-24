# Memory Replay

Record a moment on Meta Ray-Ban glasses → we rebuild it as a 4D scene (3D + time) → you and your friends walk back into it together on a Quest 3S or a phone. Pause time, grab things, and branch off an alternate timeline.

Full plan, system design, and timeline: [docs/PLAN.md](docs/PLAN.md)

## Layout

```
apps/web/            Viewer: one WebXR web app for Quest 3S browser + phones + laptops
                     (three.js + Spark splats + Rapier physics + SpacetimeDB client)
apps/ios/            Native iPhone glasses preview, O/F recording and verified upload
server/upload/       S3/R2 signing service and local disk transport for capture tests
server/spacetime/    SpacetimeDB module: rooms, players, shared playhead, branches, object overrides
packages/shared/     memory.json contract (TypeScript). Python mirror: pipeline/memreplay/manifest.py
pipeline/            Python GPU pipeline: video -> poses/depth -> segments -> splat + meshes + tracks -> memory.json
docs/                Plan, architecture, demo script
data/                Local scratch (git-ignored). Big assets go to object storage, not git.
```

## P4 branch status

Jerry's multiplayer/phone lane is implemented: SpacetimeDB tables/reducers and generated SDK bindings, rooms and presence, shared timeline/branches, phone grab/throw, trajectory replay, authenticated upload service and worker status handoff. The local demo uses clearly labeled debug geometry. GPU reconstruction and production Quest object rendering/hand input remain P1–P3 work.

Setup, cloud configuration and the Wayfarer → phone → Quest test: **[docs/P4.md](docs/P4.md)**. **Browser O/F simulation, live iPhone preview, and video/database verification: [docs/CAPTURE_TEST.md](docs/CAPTURE_TEST.md)**. Rehearsal and honest Devpost draft: **[docs/DEMO.md](docs/DEMO.md)**.

## Quick start

Use Node 22.12+ and SpacetimeDB CLI 2.13.0.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Start `spacetime start --listen-addr 127.0.0.1:3000` in another terminal, then:

```bash
npm run stdb:publish:local
LOCAL_HTTP=1 npm run dev
```

Open **http://127.0.0.1:5173/?demo=1**, register the mock manifest, create a room and open its link in a second tab. The [runbook](docs/P4.md) includes anonymous local publication, credentials, real uploads and device acceptance steps. No cloud credentials are needed for the local tests.

```bash
npm run test:integration     # against the running local database
npm run stdb:generate       # after changing the module schema
```

## How we work

- **The contract is `memory.json`.** Pipeline and viewer only talk through it. Change it in both `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py` in the same PR, and tell the channel.
- **Viewer is built against `apps/web/public/mock/memory.json`** until the pipeline produces real scenes. Never block on the pipeline.
- **Branches:** `web/*`, `stdb/*`, `pipe/*`, `demo/*`. Small PRs into `main`, merge fast, no long-lived branches. `main` must always run.
- **Assets:** never commit `.ply/.spz/.glb/.mp4`. Upload to the shared bucket and put the URL in the manifest.
- **Sync points:** standups at the times in the plan. Post blockers right away; don't sit on them.
