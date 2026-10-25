# Memory Replay: notes for agents

Turn a Ray-Ban Meta glasses video into a 3D memory that people relive together in VR (Quest 3S) or on a phone. Things move as in the video; pause time to grab and throw objects and branch alternate timelines. Hackathon project (CalHacks 13, Oct 23–25 2026).

## Read first
1. **[docs/INTEGRATION.md](docs/INTEGRATION.md):** what was merged from which branch, which contract won, how the viewer talks to the server, and the known issues with owners.
2. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (system design, interfaces I1–I7) and **[docs/TEAM.md](docs/TEAM.md)** (who owns which folder and interface: Nikko glasses + upload, Jerry hosting + database + viewer, Yifan pipeline).
3. **[docs/PLAN.md](docs/PLAN.md):** product plan, system design, timeline, risks.
4. **[README.md](README.md):** setup and daily commands.
5. Per-area docs: [docs/P3_VIEWER.md](docs/P3_VIEWER.md) (viewer), [docs/P4.md](docs/P4.md) (multiplayer, upload, worker contract), [docs/CAPTURE_TEST.md](docs/CAPTURE_TEST.md) (upload and stored-video test), [docs/SPLAT_TEST.md](docs/SPLAT_TEST.md), [pipeline/README.md](pipeline/README.md) (vision pipeline runbook; being rewritten).

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

## Honest status (Sat Oct 24, 9 PM)
- **Working, checked in a desktop browser and by tests:** viewer engine with physics and replay, and the **follow mode** (a recorded memory opens riding the recorded walk at eye height: drag to look, Space pauses everything and frees you to walk anywhere, Play glides you back; `apps/web/src/follow.ts`); multiplayer server and client; network adapter and room panel; upload service and capture page. Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:integration` against a local SpacetimeDB.
- **Never run on real hardware:** Quest 3S, a phone over the tunnel.
- **Vision pipeline:** run on the 5 phone sample clips and on all 9 Ray-Ban Meta glasses clips of the demo footage (`data/indoor-video`, `data/outdoor-video`); per-clip scores from the recorded camera, an independent judge panel's verdicts and what limits quality are in [docs/VISION_PIPELINE_REPORT.md](docs/VISION_PIPELINE_REPORT.md) §3; the scenes live in `apps/web/public/memories/<id>/` (not in git; the status page is `/status/index.html`). Rooms train with ViPE depth supervision and the appearance model on; sky pixels are seeded on a far dome and the layers prune keeps the far field; colours are baked and calibrated against the frames; each camera keyframe carries the exposure (`e`), replayed in wearer's view. `pipeline/tools/` has the headless capture + scoring (`evalclip.py`, `rescore.sh`) and the judge workflow. The worker (`memreplay worker`: upload → pipeline → `ready`) is written but not yet run against a live SpacetimeDB and bucket; until then, publish with `memreplay publish` and add the `memory.json` URL to the library by hand. The Anthropic API key on the pod is out of credits: nouns and prop specs come from `objects/manual_specs.json`.
- **Real 4D Gaussian splatting** was tried in parallel on two glasses clips ([docs/FOURD_REPORT.md](docs/FOURD_REPORT.md), `pipeline/fourd/`): far better from the recorded camera (people as real moving splats), not yet a VR scene (room wobble, size, nothing grabbable); the split room/people variant is the one to integrate.
- **What's fixed and what's still open:** [docs/INTEGRATION.md](docs/INTEGRATION.md) §4.
