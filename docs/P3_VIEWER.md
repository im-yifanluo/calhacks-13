# P3 viewer

P3 is implemented in `apps/web`: asset loading, playback, Rapier collisions, desktop drag/throw, WebXR controller and hand input, and alternate takes. This is a **local session** until P4 connects the provided API to SpacetimeDB. No room connection, avatar sync, upload flow, or Claude API calls are implied by the viewer demo.

## Run and try it

```bash
npm install
npm run dev
npm test
npm run build
```

Open `http://localhost:5173`. The default demo creates a small Spark splat floor and primitive objects in code. It makes no remote asset requests and does not claim to be reconstructed footage. The mock manifest's asset URLs are placeholders used only by this built-in demo path.

1. Pause near the ball's high point around 2 seconds, or use the scrubber.
2. Drag the ball and release. This forks a take and previews/records its physics trajectory.
3. Press **Play take** to replay the recorded trajectory from the paused time. If the preview is still simulating, it is finished before replay begins.
4. Scrub or select **Original**. The original motion is unchanged. A second edit creates a child take that inherits earlier edits.
5. Use **Export takes** to download the local branch records as JSON. Local takes live in memory and are lost on reload unless exported or persisted by P4. Export is data for inspection/integration; the UI does not yet import files.

Desktop: drag empty space to orbit, scroll to zoom, Space to play/pause, arrow keys to seek ±0.5 seconds. Colliders toggles collision outlines. Wearer's view follows the camera track on the desktop; it is disabled during immersive VR to avoid driving the user's head pose.

## Quest

Use the README's USB/adb setup and open `http://localhost:5173` in Quest Browser. For direct LAN access use `npm run dev:lan -w apps/web`; for a public HTTPS URL use `npm run tunnel`. A plain LAN-IP HTTP URL is not a secure context for WebXR.

- The rig starts at the first camera keyframe's x/z position, at `world.floorY`, with that keyframe's yaw. Headset height is supplied by `local-floor` tracking.
- Squeeze a controller or pinch a hand ray over a paused grabbable object. Release to throw. The object preserves its offset relative to the controller, including rotation.
- The floating panel works without the DOM HUD: trigger/pinch selects Play, −1 second, +1 second, Takes, or Original. A/X toggles play, B/Y cycles takes.
- Left stick moves; right stick turns in 30° steps. Hand-only users can move physically and use the panel; joystick locomotion requires controllers.
- One local grab/simulation is active at a time. Hand disconnect, cancelled pointers, lost focus, and XR exit release local input. Network ownership loss can explicitly stop simulation via the API below.

The renderer uses antialiasing off, pixel ratio 1, fixed foveation 1, a shared Three.js instance, Spark `preUpdate:false`, and `maxStdDev: Math.sqrt(5)`. Declared/loaded static scenes above one million splats fail visibly; above 500,000 emit a warning. Sequence frames have a three-frame cache with one request in flight. Sequence frames must also be budgeted by the pipeline; the viewer's initial total-count check cannot account for all future sequence assets.

**Still requires a physical Quest:** controller/hand pose accuracy, throwing feel, 72 FPS with the team's real scene, spawn/floor alignment, and USB/LAN access. Desktop software-rendering FPS is not a headset benchmark. The IWSDK spike was not attempted without hardware; this uses the plan's default Three.js stack.

## Assets and time

Pass `?memory=` with a URL-encoded manifest URL. All asset/track URLs resolve relative to that manifest, including external camera/object JSON tracks, background SPZ/other Spark formats, GLB visuals, optional GLB room collision mesh, and GLB convex hulls. CORS must permit the viewer origin. A failed required asset shows a load error; a missing sequence frame shows a warning and can be retried by reloading.

- World frame remains +Y up and meters; floor height comes from the manifest. No shared TypeScript/Python contract changes were made.
- Track JSON is a nonempty array of `{t,p,q,s?}`. `t` is seconds, strictly increasing. Positions and scale interpolate linearly; normalized rotations use quaternion slerp. Outside a track's endpoints the endpoint pose is held. Invalid times, nonfinite components, zero quaternions, and nonpositive scales are rejected.
- Sequence convention: `urlPattern` contains literal **`{frame}`**, replaced by a zero-based, unpadded integer. Frame index is `floor((time - visibleFrom) * timeline.sampleHz)`, clamped to `frameCount - 1`. P2 must follow this convention or coordinate a change.
- A static background is required for real memories. A sequence is a timed visual attached to the object's pose; nonrigid people should be `grabbable:false`.
- A paused object's release velocity includes its recorded linear velocity plus the measured hand/pointer throw. Angular throw velocity comes from controller rotation. Speeds are capped for stability. Recorded angular momentum before grabbing is not estimated.
- Rapier runs at 60 Hz with CCD. Mass, box/sphere/capsule/convex colliders, uniform keyframe scale, the floor, and an optional room triangle mesh are used. Untouched objects remain kinematic at the fork pose during the paused physics preview; they resume their tracks on replay. This is not a full coupled dynamic scene simulation.
- Throw keyframes use media time starting at the fork. Paused previews advance a separate simulation clock. Replay uses saved poses rather than rerunning physics. Bodies stop recording at sleep, clip end, or a 100-second safety cap, then the final pose is held. A safety-cap warning is shown.

## P4 integration surface

`Viewer` is exported from `apps/web/src/viewer.ts`. The running instance is `window.memoryReplay`; initialization dispatches a `memoryreplay:ready` CustomEvent whose `detail` is that instance. The default app deliberately does not connect to a room.

The API uses **seconds**, Three.js poses, and **string branch IDs**. Map server branch `0n` to `"original"`; convert other u64 IDs to decimal strings. Convert server microseconds to seconds only at the adapter boundary. Send original keyframe times in seconds when serializing recordings.

| API | Adapter responsibility |
|---|---|
| `setAuthority({ acquire, release })` | Install before allowing shared-room edits. `acquire(request)` must wait for successful ownership, not return an optimistic grant. A denial returns `false`. In a room, return `{ branch: { id, parentId, name, forkTime } }` with the canonical server branch. `true` is only the standalone/local-fork mode. |
| `authority.release(objectId)` | End ownership using cached latest pose, once. Called when simulation completes or a late/cancelled grant must be released. Do not release an object now owned by someone else. |
| `subscribe(listener)` | Receives typed `clock`, `fork`, `grab`, `pose`, `throw`, `recording`, and `rest` events. Returns an unsubscribe function. |
| `timeline.upsertBranch(row)` | Import branch rows in parent-first order. Rejects missing parents/cycles. |
| `timeline.appendRecording(branchId, objectId, frames)` | Import replay chunks. Overlapping timestamps are deduplicated; later values win. Accepts out-of-order chunk delivery once the branch exists. |
| `applyClock(time, playing, speed, branchId)` | Apply a known server branch and anchor without emitting a clock echo. Call on server clock changes, not every rendered frame. |
| `applyRemotePose(objectId, pose)` | Interpolate remote owner poses over one 15 Hz interval. |
| `clearRemotePose(objectId)` | Remove live override when saved replay takes over. Seeking/branch changes also clear live overrides. |
| `revokeOwnership(objectId)` | Stop local writes/simulation when another player catches the throw. Emits the recorded prefix; does not attempt to release the new owner's object. |

Event mapping to the **updated main** server:

- `acquire`: call `grab` with the requested pose and wait for the owned row plus the canonical branch. Main auto-forks when grabbing on Original. If editing an existing take should create another child, P4 must explicitly call `forkBranch` first. Return its branch metadata in the grant so the client does not invent a second branch.
- `pose`: call `moveObject` while this client still owns the row. Held samples are throttled to 15 Hz; simulation emits every fourth 60 Hz step.
- `throw`: call `release` with `rest:false`. Main retains `heldBy` and changes mode to `thrown`.
- `recording`: persist the array using `saveBranchKeyframes`, split into roughly 1–2-second chunks if needed. The last sample holds after the body sleeps.
- `rest`: cache the final pose. Let `authority.release` send `release(rest:true)` once; do not send twice from both hooks.
- `clock`: route user intent to `seek`, `setPaused`, or `setBranch`. Apply authoritative updates with `applyClock` and avoid echo loops. If a clock update accompanies a pending ownership grant, coordinate it in the adapter: an unrelated seek must invalidate the pending grab.

The adapter should handle reducer failures, player disconnects, branch ID mapping, and acquisition races. P3 tests grant rejection, late grants, canonical branch grants, inherited replay, and clock echo prevention. Actual network integration and shared-room tests belong to P4; the existing `/smoke.html` remains intact.

**Port correction included:** main's README and Vite proxy use 3055, but its start/publish npm scripts still used 3001. The scripts now also use 3055. If using a different server, set `STDB_URL` for Vite and publish/start on that same address.

## Validation and known limits

`npm test` compiles the testable modules to ignored `apps/web/.test-dist` and uses Node's test runner with real Rapier WASM. It exercises interpolation, input validation, inherited branches, replay equality, floor/shape collisions, ownership gates, and shared-clock import. `npm run build` type-checks the entire app, including main's generated bindings and smoke page, and builds both entry points.

Browser verification also covers pointer drag/throw, branch selection, camera/debug controls, JSON export, narrow-screen layout, visible load errors, real Spark sample SPZ loading, binary GLB visual/hull/room fixtures, external tracks, and PLY object/sequence fixtures. Fixture assets are temporary and are not committed. The real sample is Spark's [butterfly SPZ](https://sparkjs.dev/assets/splats/butterfly.spz), not team footage.

The production viewer is roughly 7.7 MB uncompressed / 2.8 MB gzip, primarily Spark and Rapier. Vite reports its large-chunk warning; verify first-load time on venue Wi-Fi and preload the scene before presenting. This work does not establish headset performance, real reconstruction quality, or end-to-end multiplayer readiness.
