# Memory Replay: notes for agents

Turn a Ray-Ban Meta glasses video into a 3D memory that people relive together in VR (Quest 3S) or on a phone. Things move as in the video; pause time to grab and throw objects and branch alternate timelines. Hackathon project (CalHacks 13, Oct 23–25 2026).

## Read first
1. **[docs/INTEGRATION.md](docs/INTEGRATION.md):** what was merged from which branch, which contract won, how the viewer talks to the server, and the known issues with owners.
2. **[docs/PLAN.md](docs/PLAN.md):** product plan, system design, timeline, risks.
3. **[README.md](README.md):** setup and daily commands.
4. Per-area docs: [docs/P3_VIEWER.md](docs/P3_VIEWER.md) (viewer), [docs/P4.md](docs/P4.md) (multiplayer, upload, worker contract), [docs/CAPTURE_TEST.md](docs/CAPTURE_TEST.md) (upload and stored-video test), [docs/SPLAT_TEST.md](docs/SPLAT_TEST.md), [pipeline/README.md](pipeline/README.md) (vision pipeline runbook; being rewritten).

## Layout
```
apps/web/            viewer (three.js + Spark splats + Rapier), one URL for Quest, phone and desktop
  src/viewer.ts      engine: grab, throw, record, replay (nikko); timeline.ts, tracks.ts, loader.ts, physics.ts
  src/net/           SpacetimeDB client (index.ts) and the viewer↔server adapter (adapter.ts)
  src/session.ts     room panel: rooms, library, upload, players, avatars
  capture.html       upload and stored-video test page
server/spacetime/    SpacetimeDB 2.13 TypeScript module: memories, rooms, players, shared clock, takes, grabbing
server/upload/       upload signing (S3/R2) and local-disk upload service
packages/shared/     memory.json scene format (manifest.ts); Python mirror in pipeline/memreplay/manifest.py
pipeline/            vision pipeline (Python): memreplay CLI (S1-S7, verify, publish, worker), Runpod scripts in runpod/
tests/               vitest: module harness, upload, storage
docs/                plan, integration guide, per-area guides
```

## Rules that bite
- **`pipeline/`** has its own runbook ([pipeline/README.md](pipeline/README.md)) and synthetic tests (`cd pipeline && python -m pytest -q tests`).
- **The scene format exists twice:** `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py`. Change both in the same commit.
- **Never hand-edit generated or lock files.** Regenerate `apps/web/src/module_bindings/` with `npm run stdb:generate` (SpacetimeDB CLI 2.13.0), and `package-lock.json` with `npm install`.
- **SpacetimeDB module code must be deterministic.** No `Math.random()` or `Date.now()`; use `ctx.random` and `ctx.timestamp`. Wire and SQL names are snake_case; TypeScript names are camelCase.
- **The `spacetime` CLI defaults to Maincloud.** Pass `-s http://127.0.0.1:<port>` for local work. Local SpacetimeDB runs on 3055 (`STDB_PORT` overrides it).
- **Spark needs a `SparkRenderer`** added to the scene, or splats never draw.
- **Big assets** (`.ply`, `.spz`, `.glb`, `.mp4`, `.mov`) never go in git.
- **Commit or push only when asked.**

## Honest status (Sat Oct 24, morning)
- **Working, checked in a desktop browser and by tests:** viewer engine with physics and replay; multiplayer server and client; network adapter and room panel; upload service and capture page. Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:integration` against a local SpacetimeDB.
- **Never run on real hardware:** Quest 3S, a phone over the tunnel, real glasses footage.
- **Vision pipeline:** built and run on the 5 sample clips ([docs/VISION_PIPELINE_REPORT.md](docs/VISION_PIPELINE_REPORT.md): per-clip scores against the video from the recorded camera, an independent judge panel's verdicts, and what limits quality). Rooms train with ViPE depth supervision and the appearance model on; colours are baked and calibrated against the frames; each camera keyframe carries the phone's exposure (`e`), replayed in wearer's view. `pipeline/tools/` has the headless capture + scoring (`evalclip.py`) and the judge workflow. The worker (`memreplay worker`: upload → pipeline → `ready`) is written but not yet run against a live SpacetimeDB and bucket; until then, publish with `memreplay publish` and add the `memory.json` URL to the library by hand.
- **What's fixed and what's still open:** [docs/INTEGRATION.md](docs/INTEGRATION.md) §4.
