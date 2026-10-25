# memos: team roles, interfaces and how we work

`main` is the source of truth (as of `13bf66a`, Oct 24 19:37). The system design and diagrams are in
[ARCHITECTURE.md](ARCHITECTURE.md). This page says **who owns what**, **which interface each person must keep**,
and **how to change things without stepping on each other**.

## Roles and responsibilities

| Person | Owns (code) | Responsible for | Interfaces they own |
|---|---|---|---|
| **Nikko** | `apps/ios/`, `server/upload/` | **Glasses and upload.** The phone app: Meta glasses capture through the DAT SDK, the durable upload queue (ported from `apps/ios/CameraAccess`), and the upload service it talks to. | I1, I2 (both sides), I3 (caller) |
| **Jerry** | `server/spacetime/`, cloud accounts, then `apps/web/` | **Hosting first:** the Maincloud database, the R2 bucket, the upload service and the viewer on HTTPS, plus the database rules (reducers, parties, leadership, name/key sign-in). **Then the viewer:** party and VR fixes, multi-headset testing, the phone/desktop UI. | I3 (reducer), I5 (bucket), I6 (reader), I7 (both sides) |
| **Yifan** | `pipeline/`, `packages/shared/` (scene format), the Runpod pods | **Pipeline.** Video → scene, the GPU worker, the scene format, the demo scenes. No UI work. | I4, I5 (worker), I6 (writer) |

If a task touches another person's files, ask them first or open the PR with them as reviewer.

## Interfaces (one owner per side)

| # | Between | Contract | Owner(s) |
|---|---|---|---|
| I1 | Glasses → phone app | Meta DAT SDK 1.0.1; MP4/MOV ≥ 1280 px, 30 fps, audio | Nikko |
| I2 | Phone → upload service → R2 | `POST /api/uploads/presign` `{identity, name, type, size, title, durationSec}` → `{putUrl, receipt, requestId}`; `PUT putUrl` (15 min); `POST /api/uploads/complete` `{identity, receipt}` (60 min); `Authorization: Bearer <SpacetimeDB token>` | Nikko (both sides) |
| I3 | Upload service → DB | `create_memory {requestId, title, sourceUrl, pipelineIdentity, durationUs}` → memory row `uploaded` | Nikko (caller) · Jerry (reducer) |
| I4 | GPU worker ↔ DB | poll `SELECT * FROM memory WHERE status = 'uploaded'`; `set_memory_status [id, status, progress, manifestUrl, error]`; uploaded → processing → ready / failed | Yifan (worker) · Jerry (reducer) |
| I5 | GPU worker ↔ R2 | read `videos/<owner>/<requestId>.<ext>`; write `memories/<memoryId>/` once (`memory.json`, splats, collider, audio) | Yifan (worker) · Jerry (bucket) |
| I6 | Viewer ← R2 | `memory.json` schema: `packages/shared/src/manifest.ts` = `pipeline/memreplay/manifest.py` | Yifan (writer) · Jerry (reader) |
| I7 | Viewer ↔ DB | WebSocket subscription; reducers: sign-in `register_account`, `set_display_name`; party `create_party`, `join_room`, `leave_room`, `transfer_leadership`, `attach_party_memory`; time (leader only) `set_paused`, `seek`, `set_playback_speed`, `set_branch`, `fork_branch`; interaction `grab`, `move_object`, `release`, `save_branch_keyframes`; presence `set_pose`; clock `sample_clock` | Jerry (server and client) |

**Sign-in (changed tonight):** Google sign-in is gone. People sign in with a **name**; `register_account` binds it to
a **personal key** (`memos1.…`, stored by the browser/phone) so the same identity works on another device. Guests can
still set a display name with `set_display_name`; a name registered to a key can't be changed that way.

## How we work from now on

1. **Branch from `main`, merge back to `main` by PR.** One task per branch; pull `main` before you start and before
   you open the PR. No long-lived personal branches.
2. **Interface changes need both owners in the PR.** `manifest.ts` + `manifest.py` together; a reducer + regenerated
   bindings (`npm run stdb:generate`, never hand-edit `module_bindings/`) together; the upload API + the phone app
   together.
3. **Green before merge:** `npm run typecheck`, `npm test`, `npm run build`, `npm test -w apps/web`,
   `cd pipeline && python -m pytest -q tests`; for server changes also `npm run test:integration` and
   `npm run test:party` against a local SpacetimeDB (`npm run stdb:start`, `npm run stdb:publish:local`).
4. **Big files never in git** (`.mov`, `.mp4`, `.spz`, `.ply`, `.glb`): they go to R2 or stay local.
5. **Say what you're touching** in the team chat before editing a shared file (`main.ts`, `index.html`,
   `session.ts`, `server/spacetime/src/index.ts`).

## Not merged, on purpose

| Branch | Why | What to do |
|---|---|---|
| `origin/frontend-quest`, `origin/frontend-phone` | Built on an old `main`; they rewrite `input-xr.ts` and `style.css` and add a second VR panel, all superseded by the merged glass UI and VR panel (PR #4, which already credits their fixes) | Don't merge. Jerry may cherry-pick anything still useful into `apps/web`. |
| `origin/pipe/motion-extraction-2` | A pipeline fix (prop motion separation, colour tags) on an old `main` | Yifan ports it onto current `main` after tonight's runs, with tests. |
| `apps/ios/CameraAccess` (merged) | A second phone app that duplicates SceneCapture | Reference only: Nikko ports its upload-queue durability into SceneCapture, then deletes it. |

## What's left before the demo (owner)

1. Hosting: Maincloud database, R2 bucket (public read, CORS), upload service and viewer on HTTPS (**Jerry**).
2. GPU worker running on Runpod, one real upload end to end (**Yifan**).
3. Phone app on a real iPhone with the glasses (DAT SDK), durable upload queue (**Nikko**).
4. Viewer party fixes: VR controls respect the leader, no junk take from a guest's catch, stale takes hidden after a scene switch; multi-headset test (**Jerry**, after hosting).
5. Demo clip recorded by everyone, run through the pipeline (**Yifan**).
