# P3 viewer

P3 is implemented in `apps/web`: asset loading, playback, Rapier collisions, desktop drag/throw, WebXR controller and hand input, and alternate takes. On its own the viewer is a **local session**. Inside a room, `net/adapter.ts` connects it to SpacetimeDB (shared clock, takes, grabs, remote poses) and `session.ts` adds the room panel and avatars; see [INTEGRATION.md](INTEGRATION.md) §3. No Claude API calls are implied by the viewer demo.

## Run and try it

```bash
npm install
LOCAL_HTTP=1 npm run dev
npm test
npm run build
```

Open `http://127.0.0.1:5173`. The default demo creates a small Spark splat floor and primitive objects in code. It makes no remote asset requests and does not claim to be reconstructed footage. `?memory=/mock/memory.json` loads a demo manifest with primitive objects (a ball and a can) over Spark's public butterfly splat, which needs internet.

1. Pause near the ball's high point around 2 seconds, or use the scrubber.
2. Drag the ball and release. This forks a take and previews/records its physics trajectory. A grab starts after 6 px of movement or 150 ms held, so a quick tap does nothing. A held object can't go below the floor. When the preview comes to rest, the object holds its landing pose and the status says "Throw recorded. Press Play to replay this take."
3. Press **Play** to replay the recorded trajectory from the paused time. If the preview is still simulating, it is finished before replay begins.
4. Scrub or select **Original**. The original motion is unchanged. A second edit creates a child take that inherits earlier edits.
5. Use **Export takes** to download the local branch records as JSON. Local takes live in memory and are lost on reload unless exported or persisted by P4. Export is data for inspection/integration; the UI does not yet import files.

Desktop: drag empty space to orbit, scroll to zoom, Space to play/pause, arrow keys to seek ±0.5 seconds, `[` and `]` to switch takes. The **⋯** menu holds Wearer's view, Guided path, Colliders, Sound and Export takes. Wearer's view follows the camera track on the desktop; it is disabled during immersive VR to avoid driving the user's head pose. A recorded memory opens from the wearer's first pose; `&mode=guided` starts in guided mode (guided.ts), and the scrubber shows lost-tracking stretches (`timeline.gaps`) as hatched bands.

The overlay is dark glass over a full-bleed scene (style.css, after the UI design brief): a title pill and room button at the top, one status line that fades after 4 s, and a dock at the bottom with Play, the scrubber, the take picker and the menu. On phones the dock has two rows within thumb reach and the WALK pad sits above it. The room panel is a non-modal sheet (a bottom sheet on phones; drag it down or press Escape to close). While the memory plays, the overlay fades after 3 s without input and comes back on any touch, click or key. `?stats` shows the frame rate.

## Quest

Use the README's USB/adb setup (`LOCAL_HTTP=1 npm run dev`, `adb reverse tcp:5173 tcp:5173`) and open `http://localhost:5173` in Quest Browser. For direct LAN access, plain `npm run dev` serves self-signed HTTPS on every interface; for a public HTTPS URL use `npm run tunnel`. A plain LAN-IP HTTP URL is not a secure context for WebXR.

- The rig starts at the first camera keyframe's x/z position, at `world.floorY`, with that keyframe's yaw. Headset height is supplied by `local-floor` tracking.
- Point at a paused grabbable object: the ray turns amber and the object glows. Hold grip (or pinch with hands), move, then let go to throw. The object hangs from the controller grip (the wrist for hands), keeping its offset and rotation. Letting go of the trigger never drops an object held by the grip. Controllers buzz on hover, press, grab and release, and twice (rising) when a throw's take is saved.
- The panel (vr-panel.ts) is dark faux glass, about 33° wide: it opens 1.2 m ahead and 0.3 m below the eyes and follows lazily, re-centring only when you turn more than 30° or step 0.5 m away, and never while you point at it. Trigger/pinch works Play, −1 s, +1 s, the scrubber (seeks at most 15 times a second), ‹ › takes, Original, Help and Hide. **Drag the bar under the panel** to put it anywhere; the thumbstick of the dragging hand pushes it away or pulls it closer (0.6–3 m). A dropped panel stays put until you click the **right thumbstick**, which brings it back in front of you. **A/X** plays or pauses; **B/Y** hides it to a small "Show controls" pill and brings it back. Help has the controls and **Exit VR**.
- Left stick moves; right stick turns in 30° steps. Both use the user camera under the rig, so the stick follows where you look after spawn and after snap turns, and a snap turn pivots around your head. Neither moves you while you hold, scrub or drag the panel. Hand-only users can move physically and use the panel; joystick locomotion requires controllers.
- One local grab/simulation is active at a time. Hand disconnect, cancelled pointers, lost focus, opening the system menu and XR exit release local input; leaving VR cancels a grab still waiting on the room. Network ownership loss can explicitly stop simulation via the API below.
- In the dev server, `?xrPreview` shows the headset panel on the desktop, worked with the mouse (it is not a headset emulator). The input fixes and the preview come from Andrew Eng's `frontend-quest` branch; `tests/vr-controls.test.mjs` drives the controls against a simulated headset.

The renderer uses antialiasing off, pixel ratio 1, fixed foveation 1, a shared Three.js instance, Spark `preUpdate:false`, and `maxStdDev: Math.sqrt(5)`. Declared/loaded static scenes above one million splats fail visibly; above 500,000 emit a warning. Sequence frames have a three-frame cache with one request in flight. Sequence frames must also be budgeted by the pipeline; the viewer's initial total-count check cannot account for all future sequence assets.

**Still requires a physical Quest:** controller/hand pose accuracy, throwing feel, 72 FPS with the team's real scene, spawn/floor alignment, and USB/LAN access. Desktop software-rendering FPS is not a headset benchmark. The IWSDK spike was not attempted without hardware; this uses the plan's default Three.js stack.

## Assets and time

Pass `?memory=` with a URL-encoded manifest URL. All asset/track URLs resolve relative to that manifest, including external camera/object JSON tracks, background SPZ/other Spark formats, GLB visuals, optional GLB room collision mesh, and GLB convex hulls. CORS must permit the viewer origin. A failed required asset shows a load error; a missing sequence frame shows a warning and can be retried by reloading.

- World frame remains +Y up and meters; floor height comes from the manifest. The scene format is main's `packages/shared/src/manifest.ts`: keyframe velocity `v` (used on pause), `source.audioUrl` (played in sync, with a Sound toggle), `primitive` visuals, `points-sequence` people ghosts (drawn as points, no physics) and `cylinder` colliders.
- Track JSON is a nonempty array of `{t,p,q,s?}`. `t` is seconds, strictly increasing. Positions and scale interpolate linearly; normalized rotations use quaternion slerp. Outside a track's endpoints the endpoint pose is held. Invalid times, nonfinite components, zero quaternions, and nonpositive scales are rejected.
- Sequence convention: `urlPattern` contains literal **`{frame}`**, replaced by a zero-based, unpadded integer. Frame index is `floor((time - visibleFrom) * timeline.sampleHz)`, clamped to `frameCount - 1`. P2 must follow this convention or coordinate a change.
- A static background is required for real memories. A sequence is a timed visual attached to the object's pose; nonrigid people should be `grabbable:false`.
- A paused object's release velocity includes its recorded linear velocity plus the measured hand/pointer throw. Angular throw velocity comes from controller rotation. Speeds are capped for stability. Recorded angular momentum before grabbing is not estimated.
- Rapier runs at 60 Hz with CCD. Mass, box/sphere/capsule/cylinder/convex colliders, uniform keyframe scale, the floor, and an optional room triangle mesh are used. Untouched objects remain kinematic at the fork pose during the paused physics preview; they resume their tracks on replay. This is not a full coupled dynamic scene simulation.
- Throw keyframes use media time starting at the fork. Paused previews advance a separate simulation clock. Replay uses saved poses rather than rerunning physics. Bodies stop recording at sleep, clip end, or a 100-second safety cap, then the final pose is held. A safety-cap warning is shown.

## P4 integration surface

`Viewer` is exported from `apps/web/src/viewer.ts`. The running instance is `window.memoryReplay`; initialization dispatches a `memoryreplay:ready` CustomEvent whose `detail` is that instance. Without `?room=` the app stays a solo session; in a room, `session.ts` installs `NetAdapter` as the authority. Dev builds also expose `window.__memreplay` for debugging.

The API uses **seconds**, Three.js poses, and **string branch IDs**. Map server branch `0n` to `"original"`; convert other u64 IDs to decimal strings. Convert server microseconds to seconds only at the adapter boundary. Send original keyframe times in seconds when serializing recordings.

| API | Adapter responsibility |
|---|---|
| `setAuthority({ acquire, release })` | Install before allowing shared-room edits. `acquire(request)` must wait for successful ownership, not return an optimistic grant. A denial returns `false`. In a room, return `{ branch: { id, parentId, name, forkTime } }` with the canonical server branch. `true` is only the standalone/local-fork mode. |
| `authority.release(objectId)` | End ownership using cached latest pose, once. Called when simulation completes or a late/cancelled grant must be released. Do not release an object now owned by someone else. |
| `subscribe(listener)` | Receives typed `clock`, `fork`, `grab`, `pose`, `throw`, `recording`, and `rest` events. Returns an unsubscribe function. |
| `timeline.upsertBranch(row)` | Import branch rows in parent-first order. Rejects missing parents/cycles. |
| `timeline.appendRecording(branchId, objectId, frames)` | Import replay chunks. Overlapping timestamps are deduplicated; later values win. Accepts out-of-order chunk delivery once the branch exists. |
| `timeline.setRecording(branchId, objectId, frames \| null)` | Replace or clear one object's recording on a take. The adapter rebuilds tracks from the server's chunks with it, so chunk updates and deletes are reflected. |
| `applyClock(time, playing, speed, branchId)` | Apply a known server branch and anchor without emitting a clock echo. Call on server clock changes, not every rendered frame. |
| `applyRemotePose(objectId, pose)` | Interpolate remote owner poses over one 15 Hz interval. |
| `clearRemotePose(objectId)` | Remove live override when saved replay takes over. Seeking/branch changes also clear live overrides. |
| `revokeOwnership(objectId)` | Stop local writes/simulation when another player catches the throw. Emits the recorded prefix; does not attempt to release the new owner's object. |

How the adapter maps these to jerry's SpacetimeDB module is in [INTEGRATION.md](INTEGRATION.md) §3 and `apps/web/src/net/adapter.ts`. Server rules that shape it ([INTEGRATION.md](INTEGRATION.md) §2 B):

- Grab and fork need a paused timeline. Grabbing on Original forks "First edit"; re-grabbing an object that rests on a take forks "Edit <id>". The server picks the take, and the grant carries it, so the client never invents a second branch.
- The server forks and moves the room's timeline in the same transaction as the grab, so a paused clock at the grab time arrives before the grant. `applyClock` ignores that echo while a grab is pending, and is a no-op when nothing changed.
- Keyframe chunks: 1–120 frames, absolute media seconds, starting at or after the grab time, no overlaps; saved before `release(rest: true)`.
- Seek, fork and setBranch are rejected while a throw is still simulating, so the adapter runs every server call through one queue.
- Catching an object another player is still simulating is rejected, so `revokeOwnership` only runs when the server clears your ownership (disconnect or leave).

SpacetimeDB runs on 127.0.0.1:3055 by default; `STDB_PORT` (or `STDB_URL` for the Vite proxy) points everything elsewhere.

## Validation and known limits

`npm test` compiles the testable modules to ignored `apps/web/.test-dist` and uses Node's test runner with real Rapier WASM. It exercises interpolation, input validation, inherited branches, replay equality, floor/shape collisions, ownership gates, and shared-clock import. `npm run build` type-checks the entire app, including the generated bindings, and builds both entry points (the viewer and `/capture.html`).

Browser verification also covers pointer drag/throw, branch selection, camera/debug controls, JSON export, narrow-screen layout, visible load errors, real Spark sample SPZ loading, binary GLB visual/hull/room fixtures, external tracks, and PLY object/sequence fixtures. Fixture assets are temporary and are not committed. The real sample is Spark's [butterfly SPZ](https://sparkjs.dev/assets/splats/butterfly.spz), not team footage.

The production viewer is roughly 7.7 MB uncompressed / 2.8 MB gzip, primarily Spark and Rapier. Vite reports its large-chunk warning; verify first-load time on venue Wi-Fi and preload the scene before presenting. This work does not establish headset performance, real reconstruction quality, or end-to-end multiplayer readiness.
