# Viewer

The viewer is the web app that plays a memory: a Gaussian splat room, the people in it as moving point clouds ("ghosts"), and props you can grab and throw. One page serves desktop browsers, phones and the Quest 3S (WebXR). It lives in [apps/web](../apps/web) (`index.html` → [src/main.ts](../apps/web/src/main.ts)) and is built on three.js, [Spark](https://sparkjs.dev) for the splats and Rapier for physics. On its own a page is a solo session; in a party it shares the clock, the takes and every grab with the others (see [Multiplayer](./multiplayer.md)). The scene it loads is a `memory.json`, described in [Scene format](./scene-format.md).

## Run it

```bash
npm install
LOCAL_HTTP=1 npm run dev
```

Open http://127.0.0.1:5173. With no `?memory=`, the page opens the practice room (`apps/web/public/demo/memory.json`): a procedural splat floor, a ball and a can, and no downloads. Pause, drag the ball, let go, then press Play to watch the new take; pick **Original** in the take picker to return to the recording.

- `?memory=<manifest URL>` opens another scene (URL-encode a manifest URL that has its own query string). Asset URLs resolve relative to the manifest, so the host serving them must allow this page's origin (CORS).
- `?memory=/mock/memory.json` is a test fixture over Spark's public butterfly splat (needs internet). Its ball and can are `primitive` placeholders, which only the practice room draws, so the page shows the splat alone.
- Scenes copied into `apps/web/public/memories/<id>/` (not in git) open with `?memory=/memories/<id>/memory.json`. A `memory.static.json` next to it, when the pipeline writes one, is the room alone. Run `python pipeline/tools/index_scenes.py`, then open `/scenes/index.html` for links to every local scene. The dev server answers unknown paths with the viewer (party codes live at `/CODE`), so static pages need their full path.

Plain `npm run dev` serves HTTPS with a self-signed certificate on every network interface; `LOCAL_HTTP=1` serves plain HTTP on 127.0.0.1 only. The full local stack (SpacetimeDB, the upload API) is in [Development](./development.md).

## Playing a memory

The title pill at the top names the memory and says whether it is a recording, the sample scene or a local import. Next to it: **Hide UI**, **Memories** (the library, `/library.html`), **Enter VR** where immersive VR works, and the party button ("Solo", or the party code and head count). The dock at the bottom holds the view chip, **Back to the start**, Play/Pause, the scrubber, the take picker and **View options** (⋯).

- A memory starts playing as soon as it loads. At the end playback stops; Play starts it again from the beginning.
- The scrubber shows every take as a marker at the time it was made (click one to switch to it) and the stretches where tracking was lost as hatched bands.
- The status line at the top fades after 4 s, except while you hold or throw something; warnings stay. While the memory plays, the whole overlay fades after 3 s without input and comes back on any touch, click or key.
- **Hide UI** (or **H**) clears the view and leaves a faint **Show UI** button; that button, a double-tap on the scene, **H** or **Escape** bring the controls back. Camera, playback and the party carry on, and objects can't be grabbed while the controls are hidden.

### Grab, throw and takes

1. Pause. Objects can only be grabbed while time is frozen (in VR a grab while playing pauses first). Nothing can be grabbed at the very end of the memory.
2. Press an object and drag. The grab starts once the pointer moves 6 px or stays down 150 ms, so a quick tap does nothing. A held object never goes below the floor.
3. Let go. Time is still frozen, so the object stays where you put it, keeping the throw your hand or pointer gave it. Grab it again to adjust it: that carries on the same edit.
4. Press Play. The object leaves from where you put it with that throw: its whole flight is simulated and recorded at once (until it rests, the clip ends or 100 s pass), then the take plays. A seek, a take change or a clock change from the party releases a placed object the same way, and grabbing a second object releases the first into its take.

Each edit lands in a take, an alternate timeline; the original recording is never changed.

- Solo, every new grab makes a take branched from the one you are on, named "Take 1", "Take 2" and so on. A take inherits the edits of the takes above it up to the moment it was made ([details](#timeline-and-take-inheritance)). In a party the server decides which take a grab edits ([Multiplayer](./multiplayer.md#takes-and-grabbing)).
- The take picker lists **Original**, then each take as "name · time made", with "from <take>" when it branched off another take. Picking a take jumps to the moment it was made, paused.
- Grabbing an object whose throw is still being previewed, or whose landing pose is being held, catches it at that moment, so what is on screen and the take agree.
- **Export takes** (in **View options**) downloads the takes as JSON (`<memory id>-takes.json`). Solo takes live only in the page: a reload loses them, and there is no import. In a party the takes are kept on the server.

## Camera modes

There are four ways to look at a memory. The recorded camera path is always drawn on the floor, a line with a dot where it starts, and a recorded memory opens at the wearer's first spot, looking where they looked.

- **Follow the walk**, the default for a recorded memory. While it plays you ride the recorded camera path at the current time, at the wearer's eye height, and look wherever you like: on a screen a drag turns the view in place, up and down included, like a photo sphere (zoom is off); in VR you turn your head while the rig moves so the headset stays on the path. Only your position follows the recording; the look direction, the field of view and the colours stay yours. Pause and you are free: walk anywhere with the usual controls and grab things; scrubbing while paused does not move you. Play glides you from wherever you are back onto the path at the current time in 0.6 s, keeping your look direction, and a jump in the clock while playing (a seek by the party leader) glides the same way. On touch screens the WALK pad dims while you ride the walk.
- **Free camera**: go anywhere while it plays.
- **Guided path**: a free camera that keeps your head within 0.75 m of the recorded path (moves are clamped; in VR the world slides back under you) and fogs the view as you look away from every direction the camera looked from nearby spots (within 1.5 m). The fog starts 12° outside the recorded field of view and is almost opaque 50° further out; walking out of the corridor in VR fades the view too. A scene rebuilt from one hand-held camera is only reliable near where it went, looking where it looked. A pale ribbon on the floor marks the corridor.
- **Wearer's view**: replays the recorded camera itself, with its position, rotation, field of view and exposure. It works on screens only: entering VR switches it off, so it never drives a headset's view. Leaving it starts from the current recorded pose, never from an earlier camera, and keeps the recorded field of view to avoid a zoom jump.

Stretches where the recording lost tracking (`timeline.gaps` in the manifest) fade to black in guided path, in wearer's view, and in follow mode while it plays: the room there was never reconstructed.

**Exposure replay.** The room splat has one exposure, averaged over the clip, while the camera's exposure and white balance changed from frame to frame. Each camera keyframe can carry that change as a per-channel gain and bias (`e`). In wearer's view the viewer applies the nearest keyframe's values to the whole canvas as a CSS colour matrix (`camera/exposure.ts`), so the picture matches the video frame by frame. The other modes, and VR, show the room's own colours.

**Switching.** The chip above the dock (at its left end on desktop, its right end on touch screens) names the current view: Following the walk, Paused · roam freely, Free camera, Guided path or Wearer's view. A click moves follow → free camera → wearer's view → follow. **View options** has the same switches as toggles: **Follow the walk**, **Wearer's view** and **Guided path** (follow and guided exclude each other). `?mode=` picks the view a page opens in:

- no `?mode=`, or `?mode=follow`: follow the walk;
- `?mode=free`: free camera;
- `?mode=guided`: guided path.

The practice room and `?xrPreview` never start in follow mode, and local imports (`?import=`) start with the free camera unless the address says `?mode=follow`. Entering VR keeps the view you chose, except wearer's view.

## Controls

### Desktop

- Drag empty space to look around: an orbit with the free camera or guided path, a turn in place while following. Scroll zooms, except while following. Wearer's view takes no camera input.
- **W/A/S/D** or the **up/down arrows** walk along the floor in the view direction, **Q/E** go down and up, **Shift** runs (4 m/s instead of 1.5 m/s). While you ride the walk, the path wins.
- **Space** plays or pauses, **←/→** step 0.5 s, **[** and **]** switch takes.
- Pause, then drag an object to grab it; let go to place it; Play throws it. **Escape** lets go, like releasing the button.
- Keys typed into a field, a menu or a button never reach the viewer.

### Phone and tablet

- Drag the scene to look around; pinch to zoom.
- The **WALK** pad walks you along the floor in the view direction, 1.5 m/s at full deflection.
- Pause, then touch-drag an object to grab it; let go to place it; Play throws it.
- The dock has two rows within thumb reach. The party panel is a bottom sheet: drag it down or press Escape to close it.

### Quest

Open the page in the Quest Browser and press **Enter VR**. You start where the wearer started, standing on the scene's floor and facing their first heading; your height comes from `local-floor` tracking. Solo, entering VR rewinds to the start, paused, so there is time to look around; in a party only a memory that already ended rewinds.

- **A or X**: play or pause.
- **Grip** (or the trigger), or a **pinch** with tracked hands: grab. Reach out and touch an object (within 8 cm of its surface), or point at it: the ray turns amber and the object glows, and a ray passing within 3° of a small object still offers it. Move, then let go: while paused the object stays where you let go until you press Play, which throws it with the motion your hand gave it. Grabbing while the memory plays freezes time first. The object hangs from the controller grip (the wrist for tracked hands), keeping its offset and rotation, and letting go of the trigger never drops an object held by the grip.
- **Trigger or pinch on the panel**: Play/Pause, **−1 s**, **+1 s**, the scrubber (it seeks at most 15 times a second), **‹ ›** to switch takes, **Original**, **Help** and **Hide**. **Help** lists the controls and has **Exit VR**.
- **Left stick**: walk in the direction you face (1.5 m/s). **Right stick**: turn in 30° steps around your head. Neither moves you while you hold an object, scrub or drag the panel. With tracked hands you walk physically and use the panel; stick locomotion needs controllers.
- **B or Y**: hide the panel to a small **Show controls** pill, and bring it back in front of you.
- **Right stick click**: bring the panel back in front of you.

The panel, about 33° wide, opens 1.1 m ahead and 0.5 m below your eyes and follows lazily: it re-centres only when you turn more than 30° or step 0.5 m away, and never while you point at it. Drag the bar under it to put it anywhere from 0.6 to 3 m away, between 55° below and 20° above eye level; the stick of the dragging hand pushes it away or pulls it closer. A dropped panel stays where it is; when it has been out of view (more than 55° from your gaze) for 2.5 s, a **Bring controls here** pill appears in front of you. The panel shows the same status line as the screen, and the party you are in.

Controllers buzz on hover, press, grab and release, and twice (rising) when a throw's take is saved. Their models come from the WebXR input profiles, which needs internet. Opening the system menu, the headset losing focus, a hand disconnecting or leaving VR let go of whatever you hold; leaving VR also cancels a grab still waiting on the party.

## URL parameters

- `?memory=<url>`: the manifest to open; the default is `/demo/memory.json`, the practice room. In a party the database picks the scene and the address stays `/CODE`.
- `?mode=follow`, `?mode=free`, `?mode=guided`: the view the page opens in ([camera modes](#camera-modes)).
- `?lod=0`: turns Spark's level of detail off and draws every Gaussian. Slower; meant for comparisons, such as the pipeline's render-against-video captures (`pipeline/tools/capture.js`).
- `?stats`: shows the frame rate and the viewer's state (PLAYING, PAUSED, HOLDING, PLACED, RECORDING THROW) at the top left.
- `?import=<id>`: opens a scene imported from a `.memos.zip` or a folder into this browser through the library. Imports are stored in IndexedDB for the signed-in account, and can't host a party, since other devices can't reach their files.
- `?xrPreview` (dev server only): shows the headset panel on the desktop, worked with the mouse. It is not a headset emulator; the camera stays still, and **Leave** in the note at the top returns to the normal page.
- `?seed=local` (dev server only): adds every scene listed in `apps/web/public/memories/index.json` to the current account's library once, then drops itself from the address. **Load local memories** in the party panel and the library's empty state do the same.
- `/CODE`, or the older `?room=CODE`: join a party ([room addresses](./multiplayer.md#room-addresses)).

## Audio

When the manifest has `source.audioUrl`, the clip's audio follows the timeline: play, pause, seek, speed, take changes and the party's clock. It re-seeks when it drifts more than 100 ms from the timeline. Browsers block sound until a user gesture, so it starts on the first tap, click, key or VR button press; until then the **Sound** toggle in **View options** reads "Sound (tap to start)". The toggle mutes it. An audio file that fails to load shows a warning, and the memory plays silently.

## People ghosts

People are `points-sequence` objects: one point cloud per frame, already in world coordinates, drawn as a single `THREE.Points` whose dot size follows the point budget (1.5 to 4.5 cm). Frame k shows from t = k / sampleHz, and only one frame is ever on the GPU. Ghosts only replay: they have no pick target, collider or physics body, so nothing can grab them or bump into them. When a ghost file's header disagrees with the manifest about the frame count or rate, the file wins and a warning says so; a ghost that fails to load is a warning too, and the rest of the memory still plays.

## Open it on a Quest

One-time setup:

1. Turn on Developer Mode for the headset in the Meta Horizon phone app. This needs a free Meta developer account with an organization.
2. Install adb: `brew install android-platform-tools`, or Meta Quest Developer Hub.
3. Connect the Quest with a USB-C cable and allow USB debugging inside the headset.

Every session:

```bash
LOCAL_HTTP=1 npm run dev
adb reverse tcp:5173 tcp:5173
```

In the Quest Browser, open http://localhost:5173 and press **Enter VR**. `localhost` counts as a secure context, so WebXR works over plain HTTP. The dev server also proxies SpacetimeDB (`/stdb`) and the upload API (`/api`), so parties and uploads work through the same address. To debug the headset's page, open `chrome://inspect` in desktop Chrome. Dev builds keep the last 300 headset events (presses, grabs, panel drags, buttons, visibility changes) in `window.__vrlog`, to read back after a session.

Without a cable, the headset needs HTTPS: plain `npm run dev` on the same network (accept the self-signed certificate in the headset), or a tunnel as for phones below. A plain-HTTP LAN address is not a secure context, so **Enter VR** doesn't appear there.

## Open it on a phone

The 3D viewer and guest parties work over any address, but account sign-in, camera capture and the capture page's file checks need trusted HTTPS. Two ways to get it:

- Same Wi-Fi: plain `npm run dev` serves self-signed HTTPS on every interface. Open `https://<laptop's LAN IP>:5173` and accept the certificate.
- A public link: run `npm run tunnel` alongside plain `npm run dev`; it prints an `https://<random>.trycloudflare.com` address. With `LOCAL_HTTP=1 npm run dev`, use `cloudflared tunnel --url http://127.0.0.1:5173` instead. The app, SpacetimeDB and the upload API all go through that one link.

Register library manifests from the address the phones use (the tunnel URL, or a full public `https://…/memory.json`), not from 127.0.0.1: **Add to library** resolves the link against the page, and on a phone 127.0.0.1 is the phone. For guest-only party tests over plain HTTP on the LAN, see `npm run party:lan` in [Multiplayer](./multiplayer.md#run-and-test-parties-locally).

## Performance

- **Splat budget.** The viewer refuses a scene above 1,000,000 splats (the declared `background.splatCount` or the loaded total) and warns above 500,000, the Quest target. With level of detail on, the default, Spark aims for about 500,000 drawn splats (`lodSplatCount`). The frames of a `splat-sequence` load later and are not counted, so the pipeline has to budget them.
- **Pixel ratio.** At most 1.5 device pixels per CSS pixel, since splats are fill-rate bound; after two seconds in a row below 40 fps on a screen, it drops to 1. Antialiasing is off, and WebXR uses fixed foveation 1.
- **Spark settings.** `preUpdate: false` and `maxStdDev: √5`. The app keeps a single three.js instance (`resolve.dedupe` in `apps/web/vite.config.ts`) so Spark binds to it.
- **Streaming.** A `splat-sequence` keeps three frames and has one request in flight. Manifest and track JSON time out after 30 s, binary files after 120 s (a ghost file can be tens of megabytes).
- **VR panel.** Drawn on a 1536 × 768 canvas and redrawn only when something on it changes, at most 10 times a second during playback.
- **Bundle.** The viewer's JavaScript is about 7.8 MB (2.8 MB gzipped), almost all of it Spark (about 3 MB) and Rapier (about 4 MB, with its WebAssembly embedded), both needed before anything renders. Load a scene before presenting on slow Wi-Fi.

## How the engine is organized

The source is in [apps/web/src](../apps/web/src):

- `main.ts`: the app shell. Renderer, `SparkRenderer`, the camera under a `rig` group (VR moves the rig), OrbitControls, the camera modes, the overlay and the render loop. Each frame runs, in order: headset input, `viewer.update`, audio, the camera mode, guided mode's clamp and fog, the lost-tracking fade, the overlay (10 times a second), the party's avatars and pose, then the render.
- `engine/`: `viewer.ts` (`Viewer`: grab, throw, record, replay), `timeline.ts` (the clock and takes), `tracks.ts` (keyframe sampling), `physics.ts` (Rapier), `loader.ts` (manifest and asset loading), `audio.ts` (audio sync).
- `camera/`: `follow.ts` (`PathFollower`, `placeHead`), `guided.ts` (`PathGuide`: the path line, the corridor, the gaze fog and the blackout), `wearer.ts` (`wearerPose`, `releaseWearer`), `exposure.ts` (the colour matrix).
- `input/`: `desktop.ts` (mouse and touch grabbing, keyboard walking and shortcuts), `joystick.ts` (the WALK pad).
- `xr/`: `input.ts` (`XRInput`: controllers, hands, rays, haptics, sticks and buttons), `panel.ts` (`VRPanel`: the panel drawn on a canvas; its layout, hit testing and follow rule are plain functions, testable without a headset).
- `ui/`: `overlay.ts` (status toast, auto-hide, popovers, **Enter VR**, drag-to-close sheets), `scene-only.ts` (**Hide UI**).
- `party/` and `net/`: the party panel and the network adapter ([Multiplayer](./multiplayer.md)). `scenes/`: `.memos.zip` and folder imports.

### Viewer

`Viewer` (`engine/viewer.ts`) owns a `Timeline` and a `Physics` world. `update(dt)` ticks the clock, steps a running throw at 60 Hz, and poses every object. A held or simulated object follows physics; another player's held or thrown object follows their streamed pose, interpolated over one 15 Hz interval; a throw that came to rest holds its final pose while the clock stays put; everything else samples `timeline.track(...)` at the current time. An object is visible between its `visibleFrom` and `visibleTo`, or while a take's recording drives it. Every object except ghosts gets an invisible pick proxy shaped like its collider (a box around a convex hull) for ray picking.

A grab asks the authority (below), then makes every visible object except ghosts a kinematic body at its current pose and velocity. The held body follows the hand (`moveHeld`). Letting go while paused calls `place()`; `release()` makes the body dynamic, with the hand's motion added to the object's recorded velocity, and records the flight into the active take frame by frame. At rest the viewer emits `recording` and `rest`, calls `authority.release`, and holds the final pose.

### Timeline and take inheritance

`Timeline` (`engine/timeline.ts`) holds `time`, `playing`, `speed`, `activeId` and `branches`, with Original first (id `"original"`). Local takes have ids `local-N`. `tick(dt)` advances by dt × speed and stops at the end; `select(id)` jumps to the take's fork time, paused. `appendRecording` merges chunks of an object's recording (overlapping timestamps are de-duplicated, later values win; the frames must start at or after the take's fork time). `setRecording` replaces or clears an object's whole recording on a take, and may start before the fork time, because the server edits a take in place when someone seeks back on it and grabs.

`Timeline.track(objectId, original, t)` decides which recording drives an object, and every device resolves takes with it:

1. The active take's own recording of the object applies from its first frame on, even before the take's fork time.
2. Otherwise walk up the parent takes with a limit that starts at the active take's fork time and drops to each parent's fork time on the way. A parent's recording applies only if it starts at or before the limit, and then in full: a throw in flight at the fork carries on in the child. A recording that starts after the limit is the parent's own future, so edits a parent gains after a child was made never leak into the child; an edit that starts before the fork time is shared history and does reach it.
3. Otherwise the original track applies.

Times within 1 ms count as the same instant, since server fork times are rounded to microseconds.

### Tracks and physics

Keyframes are `{t, p, q, s?, v?, e?}`. Positions and scale interpolate linearly and rotations by slerp; outside a track the end pose holds. The velocity at a paused time is the active keyframe's `v`, interpolated towards the next keyframe's `v`, or a finite difference when there is no `v`; it is zero outside the track.

Physics is Rapier at 60 Hz with continuous collision detection and 9.81 m/s² gravity:

- A large floor slab sits at `world.floorY`, and `background.colliderUrl` (a GLB) adds the room as a triangle mesh.
- Object colliders are sphere, box, capsule, cylinder or a convex hull from a GLB, scaled by the keyframe scale, with the manifest's mass (at least 1 g), restitution 0.35, friction 0.65 (the floor 0.8) and light damping.
- A throw starts with the object's recorded velocity at the paused time plus the hand's smoothed motion; a hand that hasn't moved for 100 ms adds nothing. Speed is capped at 12 m/s and spin at 20 rad/s; recorded angular momentum before the grab is not estimated.
- Only the thrown object is dynamic. The others stay kinematic, frozen at their poses at the moment of the edit while the flight is simulated, and resume their tracks on replay: this is not a coupled simulation of the whole scene.
- A recording ends when the body sleeps, at the end of the clip, or after 6000 steps (100 s, with a warning); the final pose holds afterwards. Throw keyframes use media time from the moment of the edit, and replay uses the saved poses; physics never reruns.

### Loader

`loadMemory(url, demo, onWarning, source?)` (`engine/loader.ts`) fetches `memory.json` and checks it, and every track, with `validateManifest` and `validateTrack` from `@memreplay/shared`; any failure is a visible load error. Every asset URL resolves relative to the manifest, or through `source.resolveAsset` for an imported bundle. Tracks can be inline or separate JSON files.

- The background is a Spark `SplatMesh`; `format` tells Spark the file type. The practice room builds its floor in code instead.
- Objects by visual kind: `splat`, `mesh` (GLB), `splat-sequence` (a `urlPattern` with `{frame}`; frame `floor((t − visibleFrom) × timeline.sampleHz)`; a missing frame is a warning and is not requested again until a reload), `points-sequence` (the ghost file) and `primitive`, drawn as its collider's shape in the practice room only. A `convex` collider loads its hull from a GLB.
- The splat budget is checked twice: the declared background count before loading, the loaded total after.

### The authority hook

The viewer never decides alone who may grab in a shared room. A network layer installs an `InteractionAuthority` with `viewer.setAuthority(...)` before allowing shared edits; `net/adapter.ts` is the one the party uses.

```ts
interface InteractionAuthority {
  acquire(request: GrabRequest): Promise<boolean | { branch: Omit<Branch, "tracks"> }>;
  release(objectId: string): void;
}
```

`acquire` gets `{ objectId, branchId, time, pose }` and must wait for real ownership, never grant optimistically. It returns `false` to refuse, or, in a room, `{ branch }`: the take the server chose, which the viewer switches to. `true` makes a local take, for standalone use. `release(objectId)` ends ownership once, when a throw has come to rest or a late or cancelled grant has to be given back. Without an authority the viewer is a solo session.

### Viewer API

The API uses seconds, three.js poses and string take ids: `"original"` for Original, decimal strings for server takes. Converting server microseconds and u64 ids happens only in the adapter.

- `setAuthority(authority)`: install or remove the gate above.
- `subscribe(listener)`: typed events `clock` (time, playing, take), `fork` (a local take), `grab`, `pose` (at most 15 Hz while held, every fourth physics step while simulating), `throw`, `recording` (the frames of a finished throw) and `rest`. Returns an unsubscribe function.
- `grab(objectId)`, `moveHeld(position, rotation, dt)`, `place()`, `release()`, `cancelPendingGrab()`; `held`, `isPlaced`, `recording` and `busy` say where an interaction stands.
- `togglePlay()`, `seek(time)`, `selectBranch(id)`: local clock changes, each emitting `clock`.
- `applyClock(time, playing, speed, branchId)`: apply a known take and the shared clock without emitting `clock`. It is a no-op when nothing changed, and ignores the echo of a pending grab (paused at the grab's time); any other change finishes a running preview, drops a held object and cancels a pending grab.
- `applyRemotePose(objectId, pose)`, `clearRemotePose(objectId)`: show another player's live hold or throw. `holdPose(objectId, frame)`: hold the landing pose of a throw watched live while the clock stays put.
- `revokeOwnership(objectId)`: the server took the object away; stop writing at once and emit the recorded prefix.
- `timeline.upsertBranch(row)` (parents first; rejects missing parents and cycles), `timeline.appendRecording(...)`, `timeline.setRecording(...)`, `timeline.track(...)`, `timeline.export(memoryId)`.

The running instance is `window.memoryReplay`, and start-up dispatches a `memoryreplay:ready` event whose `detail` is the viewer. Every build sets `window.__memreplayScene` (scene, grid, guide, camera, renderer) for scripted screenshots such as `pipeline/tools/capture.js`. Dev builds also expose `window.__memreplay`: the viewer, the party session and adapter, the memory, the audio and the input objects, plus `positionsAt(t)` and `takes()` for comparing tabs of one party.

### Gotchas

- Spark draws nothing unless a `SparkRenderer` is added to the scene; `main.ts` adds one.
- In VR, Spark sorts splats on a timer and then restores whichever render target was current, which after a VR frame is the headset's expired frame surface: WebGL then reports INVALID_OPERATION about 120 times a second. `main.ts` leaves no render target current after each VR frame.
- Splats write no depth, so the floor grid would draw over a reconstructed room; it shows only in the practice room and in scenes without a background splat.
- A lost WebGL context stops rendering and offers **Reload viewer**.

### Tests

`npm test` runs the viewer's vitest suites in [apps/web/tests](../apps/web/tests) with real Rapier WebAssembly: interpolation, takes and inheritance, replay, collisions, ownership gates, the shared-clock import, desktop and phone input, follow mode, audio sync, the VR panel, and the headset controls against a simulated headset (`vr-controls.test.ts`, where only the WebXR event boundary is fake). `npm run typecheck` checks the app with the generated bindings, and `npm run build` builds the viewer, the library and the capture page into `apps/web/dist`. Every suite is listed in [Development](./development.md).

## Limitations

- The VR controls are tested against a simulated headset. Not measured on a Quest 3S: the frame rate with a reconstructed scene, ghost performance, audio lag, throwing feel, hand and controller pose accuracy, and spawn and floor alignment. A desktop's frame rate says nothing about a headset's.
- Not tested on a physical phone: touch grabbing and throwing and the WALK pad.
- Primitive placeholder objects appear only in the practice room; other scenes skip them entirely.
- Physics simulates only the thrown object against frozen surroundings, and replays saved poses rather than re-simulating.
- Solo takes vanish on reload; **Export takes** saves them as JSON, but nothing reads that file back.
