# Memory Replay: notes for agents

Turn a Ray-Ban Meta glasses video into a 3D memory that people relive together in VR (Quest 3S) or on a phone. Things move as in the video; pause time to grab and throw objects and branch alternate timelines. Hackathon project (CalHacks 13, Oct 23–25 2026).

## Read first
1. **[docs/INTEGRATION.md](docs/INTEGRATION.md).** The work is split across unmerged branches that conflict. It says what lives where, which version of each contract wins, the merge order and how to verify each step.
2. **[docs/PLAN.md](docs/PLAN.md):** product plan, system design, timeline, risks.
3. **[pipeline/README.md](pipeline/README.md):** the vision pipeline runbook (glasses video → `memory.json`, run on Runpod).
4. **[README.md](README.md):** setup and daily commands.

Branch docs not on `main` yet:
- `origin/nikko`: `docs/P3_VIEWER.md`, `docs/SPLAT_TEST.md`
- `origin/stdb/jerry-p4`: `docs/P4.md`, `docs/CAPTURE_TEST.md`, `docs/DEMO.md`
- `origin/part1`: `docs/PART1.md`

Read them with `git show <branch>:<path>`.

## Layout
```
apps/web/            viewer (three.js + Spark splats + Rapier), one URL for Quest, phone and desktop
server/spacetime/    SpacetimeDB 2.13 TypeScript module: rooms, players, shared clock, branches, grabbing
packages/shared/     memory.json scene format (manifest.ts); Python mirror in pipeline/memreplay/manifest.py
pipeline/            vision pipeline (Python): memreplay CLI, file formats in handoff.py, Runpod scripts in runpod/
docs/                plan, integration guide
```

## Rules that bite
- **The scene format exists twice:** `packages/shared/src/manifest.ts` and `pipeline/memreplay/manifest.py`. Change both in the same commit.
- **Never hand-edit generated or lock files.** Regenerate `apps/web/src/module_bindings/` with `npm run stdb:generate` (SpacetimeDB CLI 2.13.0), and `package-lock.json` with `npm install`.
- **SpacetimeDB module code must be deterministic.** No `Math.random()` or `Date.now()`; use `ctx.random` and `ctx.timestamp`. Wire and SQL names are snake_case; TypeScript names are camelCase.
- **The `spacetime` CLI defaults to Maincloud.** Pass `-s http://127.0.0.1:<port>` for local work.
- **Spark needs a `SparkRenderer`** added to the scene, or splats never draw.
- **Big assets** (`.ply`, `.spz`, `.glb`, `.mp4`, `.mov`) never go in git.
- **Commit or push only when asked.** Local `main` may hold unpushed commits; check `git status` and `git log origin/main..main` first.

## Honest status (Oct 24, early morning)
- **Working:** multiplayer server and 18-check smoke test (main, `/smoke.html` in a browser); viewer engine with physics and XR controls (nikko, 17 node tests, checked in a desktop browser, never run on a Quest); multiplayer client, upload, capture (jerry-p4, 16 vitest tests); local CPU pipeline (part1, 20 pytest tests).
- **Designed, not built:** vision pipeline steps S3–S6. Only `memreplay merge` (S7) exists on main. Nothing has run on Runpod or real glasses footage.
- **Not built by anyone:** the pipeline worker (upload → pipeline → `ready`), the viewer↔server adapter (`net/adapter.ts`), viewer support for main's new scene fields.
