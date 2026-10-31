# Scene format

`memory.json` is the contract between the vision pipeline and the viewer. The pipeline writes one per memory; the viewer
reads only this file and the files it names. A scene is a folder: the manifest plus its assets at relative paths.

## Where it is defined

- [`packages/shared/src/manifest.ts`](../packages/shared/src/manifest.ts): the TypeScript types (`MemoryManifest`,
  `DynamicObject`, `Keyframe`).
- [`packages/shared/src/validate.ts`](../packages/shared/src/validate.ts): `validateManifest` and `validateTrack`, the
  runtime checks used by the viewer, the library's scene import and the tests. Each throws an `Error` that names the
  first problem.
- [`pipeline/memreplay/manifest.py`](../pipeline/memreplay/manifest.py): the pydantic mirror that the pipeline writes
  with (`memreplay merge`). It rejects NaN and infinite keyframe values, like the TypeScript side.
- [`pipeline/memreplay/handoff.py`](../pipeline/memreplay/handoff.py): the binary layout of `points-sequence` files
  (`POINTS_SEQUENCE_LAYOUT`) and the pipeline's work-folder layout.

Change `manifest.ts` and `manifest.py` in the same commit. The format has one version, `1`.

## A scene folder

What the pipeline publishes for one memory (`memreplay publish`, or the worker):

```text
memory.json                 the scene: room, people, props, head path, audio
memory.static.json          the walk-through variant: the room alone
input/audio.m4a             the clip's audio
world/bg_room.spz           the room splat with the props carved out (memory.json)
world/bg_static.spz         the room splat with the props left in (memory.static.json)
world/room_collider.glb     the room's collision mesh
world/ghosts/person-0.bin   one points-sequence file per person
objects/<id>.spz            one splat per grabbable prop, in object-local coordinates
```

Scenes from older or partial pipeline runs use `world/bg.spz`, or the point cloud `world/bg_points.ply`, as the room.
These names are the pipeline's convention; the viewer only follows the URLs in the manifest. An optional `preview.jpg`
beside `memory.json` is the scene's picture on the memory cards (`pipeline/tools/preview.js` renders it).

## World frame and units

- Meters, +Y up: `world.up` is `"+y"` and `world.units` is `"meters"`. The floor is at `world.floorY`, which is 0 in
  every scene the pipeline writes.
- The pipeline's world step (S3) levels the scene, checks its scale and puts the wearer's first position on the floor at
  the origin, looking down −Z (three.js forward). The viewer never sees ViPE's raw frame.
- Times (`t`) are seconds from the start of the clip.
- Quaternions are `[x, y, z, w]`. Camera keyframes are three.js camera orientations: the camera looks down its local −Z
  with +Y up (`memreplay merge` converts from OpenCV camera axes).

## Top-level fields

- `version`: always `1`.
- `id`, `title`, `createdAt` (an ISO time). The viewer shows the title, and **Add to library** registers it as the
  memory's title (1–120 characters).
- `source`: the recording. `device` (a label such as `ray-ban-meta-gen2`), `durationSec`, `fps`, `width`, `height`, and
  optionally `audioUrl` (the clip's audio, `.m4a`) and `videoUrl` (the original clip).
- `world`: `up`, `units` and `floorY`.
- `timeline`: `durationSec` (the clip's length), `sampleHz` (the rate the tracks were sampled at; 10 Hz from the
  pipeline) and optionally `gaps`, a list of `[fromSec, toSec]` stretches where the camera's tracking was lost.
- `background`: the room. `kind` is `"splat"`; `url`; `format`, one of `spz`, `ply`, `splat`, `ksplat` and `sog`;
  `splatCount`; and optionally `colliderUrl`, a `.glb` collision mesh for the room (the pipeline's has the floor, tables
  and seats as a 10 cm heightfield, plus wall columns).
- `camera`: the wearer's head path. `track` (keyframes, or `{url}` of a JSON file holding them) and `fovYDeg`, the
  recording's vertical field of view.
- `objects`: everything that moves (below).

`validateManifest` also requires a finite `floorY`, a positive `durationSec` and `sampleHz`, and a `fovYDeg` between 0
and 180.

### Keyframes

A track is a non-empty array of keyframes, with `t` at least 0 and strictly increasing:

- `t`: seconds. `p`: position `[x, y, z]`. `q`: rotation `[x, y, z, w]`, not all zero (the viewer normalizes it).
- `s` (optional): uniform scale, positive, default 1.
- `v` (optional, objects): linear velocity in m/s, three finite numbers.
- `e` (optional, camera): the recording's exposure at that frame, `[gr, gg, gb, br, bg, bb]`, an sRGB gain and bias per
  channel that maps the room splat's colours (one average exposure) onto that frame.

Between keyframes the viewer interpolates position and scale linearly and rotation by slerp. Before the first keyframe
and after the last, it holds the end pose.

### Objects

Each entry of `objects` has:

- `id`: unique in the scene. SpacetimeDB keys grabs and recorded takes by it (`object_state` rows are keyed
  `"<take>:<id>"`), so keep ids stable when you republish a scene, and at most 100 characters (the `grab` reducer
  rejects longer ones).
- `label`: the word the object was segmented with (`person`, `ball`).
- `visual`, one of:
  - `mesh`: a `.glb` (`url`);
  - `splat`: a splat file (`url`, `format`) in object-local coordinates, moved by the track;
  - `splat-sequence`: one splat file per frame (`urlPattern` containing `{frame}`, `frameCount`, `format`), for things
    that deform;
  - `primitive`: a tinted shape (`shape` is `sphere`, `box` or `cylinder`; `size` is the full extents in meters, with a
    cylinder's axis along +Y; `color` is `#rrggbb`);
  - `points-sequence`: per-frame coloured points in one binary file (`url`, `frameCount`, `sampleHz`), for people.
- `collider`, one of `box` (`halfExtents`), `sphere` (`radius`), `capsule` (`halfHeight`, `radius`), `cylinder`
  (`halfHeight`, `radius`, axis +Y) and `convex` (`url` of a `.glb` whose vertices form the hull). Sizes must be
  positive (a capsule's `halfHeight` may be 0).
- `mass`: kilograms, at least 0. A grabbable object needs a mass above 0.
- `grabbable`: false for people and anything too big to pick up. They replay but cannot be grabbed.
- `visibleFrom`, `visibleTo`: the seconds the object is in the scene, with
  `0 ≤ visibleFrom ≤ visibleTo ≤ timeline.durationSec`.
- `track`: keyframes, or `{url}` of a JSON file holding them.

### What the pipeline writes

- **People:** id `person-<n>`, a `points-sequence` visual at 10 Hz with up to 12,000 points per person per frame,
  `grabbable: false`, mass 0 and an identity track (the points are already in world coordinates).
- **Props:** a `splat` visual carved out of the room splat (`objects/<id>.spz`), a `sphere`, `box` or `cylinder`
  collider, a mass from density × volume, and a 10 Hz track with velocity `v`. A prop whose carve finds fewer than 50
  Gaussians keeps a `primitive` visual, and its Gaussians stay in the room.
- **Camera:** one keyframe per 10 Hz sample, each with its exposure `e` once the bake step has run, and `fovYDeg` from
  ViPE's lens estimate.
- **Gaps:** runs of frames where ViPE's tracking glitched (found in S3), padded by 0.3 s on each side; runs shorter than
  0.5 s are dropped.

## Rules for producers and consumers

- **URLs are relative to the manifest.** Write asset paths relative to `memory.json` (`world/bg_room.spz`), with forward
  slashes, inside the scene folder; external tracks (`{url}`) follow the same rule. The viewer resolves every URL
  against the manifest's own URL, so it also follows an absolute URL (`apps/web/public/mock/memory.json` loads its
  background from sparkjs.dev), but the bundle importer, the library's scene publishing and the worker's publisher
  accept only relative paths inside the folder. Only SpacetimeDB's `memory.manifestUrl` is absolute: an http(s) URL of
  at most 2048 characters.
- **Optional fields are omitted, never `null`.** The pipeline writes with `exclude_none`, and the validator rejects
  `null` for keyframe `s` and `v`.
- **`splat-sequence` frames.** `{frame}` in `urlPattern` is replaced by a zero-based, unpadded integer. The frame shown
  at time t is `floor((t − visibleFrom) × timeline.sampleHz)`, clamped to `0 … frameCount − 1`.
- **`points-sequence` frames.** Frame k covers `[k / sampleHz, (k + 1) / sampleHz)` from the start of the clip (not from
  `visibleFrom`), clamped to the last frame. The points are in world coordinates, so the object's track must be the
  identity; the viewer warns otherwise. The file's header is authoritative: when the manifest's `frameCount` or
  `sampleHz` disagrees with it, the viewer uses the file and shows a warning.
- **`points-sequence` layout** (`POINTS_SEQUENCE_LAYOUT` in [handoff.py](../pipeline/memreplay/handoff.py)):
  little-endian. A header of the bytes `MRPS`, a u32 version (1), a u32 frame count and an f32 `sampleHz`, then one u32
  point count per frame. Then one block per frame: float16 positions (count × 3, meters), uint8 colours (count × 3,
  sRGB) and zero padding to the next multiple of 4 bytes, so the viewer can read each block without copying.
- **Keyframe velocity `v`.** An object grabbed while time is paused starts from its recorded velocity at that moment,
  and letting go adds the hand's throw to it, so a ball caught mid-air keeps flying. The viewer uses the `v` of the
  keyframe at or before t, interpolated toward the next keyframe's `v` when that one has one too; without `v` it uses
  the finite difference of the positions.
- **Exposure `e`.** Only on camera keyframes. In wearer's view, the viewer applies the nearest keyframe's `e` to the
  whole picture as a colour matrix (keyframes without one count as neutral). Every other view, and VR, shows the splat's
  own average exposure.
- **`timeline.gaps`.** The scene is unreliable inside these stretches. The viewer marks them on the scrubber and the VR
  panel, and guided mode, wearer's view and follow mode fade to black inside them.
- **Splat budget.** Keep the total splat count (room, props and every other splat file) at or under 500,000 for the
  Quest. The viewer refuses a scene whose `background.splatCount` is above 1,000,000 before loading anything; after
  loading it counts every splat, refuses the scene above 1,000,000 and shows a warning above 500,000. `splat-sequence`
  frames load later, one at a time, and are not part of that count, so budget them in the pipeline. `memreplay merge`
  warns when the room is above 500,000 splats, and the pipeline trains the room with at most 500,000 Gaussians.
- **Durations agree.** A memory registered in SpacetimeDB carries `durationUs`, which bounds seeks and recorded
  keyframes; it should equal `timeline.durationSec × 10⁶`. **Add to library** computes it from the manifest.

## How the viewer uses each field

- `background.url` and `format`: the room, loaded with Spark. Required in every scene except the built-in practice room
  (`apps/web/public/demo/memory.json`), which leaves it empty and draws a procedural floor.
- `background.colliderUrl`: each mesh in the `.glb` becomes a static Rapier trimesh, so thrown things land on tables.
  Without it, objects only land on the ground plane.
- `world.floorY`: the physics ground plane, the height of the drawn path, and where a headset user stands.
- `camera.track`: the first keyframe is where everyone starts (on a screen at its position and heading; in VR at its x
  and z on the floor, turned to its yaw). The track drives follow mode, wearer's view and guided mode, and is drawn on
  the floor.
- `camera.fovYDeg`: the field of view in wearer's view, and the view cone guided mode treats as seen. Keyframe `e`:
  exposure replay in wearer's view.
- `source.width` and `height`: the recorded view's aspect, for guided mode. `source.videoUrl`: not used by the viewer
  (the library's **Watch original** plays the memory's `sourceUrl` instead).
- `source.audioUrl`: played in sync with the timeline. It follows the playback speed, re-seeks when it drifts more than
  100 ms, starts on the first user gesture, and the **Sound** toggle in the **View options** (⋯) menu mutes it.
- `timeline.durationSec`: the scrubber's length. `timeline.sampleHz`: the frame rate of `splat-sequence` visuals.
- Visuals: `mesh` is loaded as glTF; `splat` with Spark; `splat-sequence` loads one frame at a time, keeps three, and
  shows a warning for a missing frame; `points-sequence` is one `THREE.Points` rewritten per frame, with no pick target
  and no physics body (a ghost that fails to load is a warning, not an error); `primitive` is drawn only in the practice
  room, from the collider's shape. In every other scene the viewer skips a `primitive` object entirely: no visual, no
  pick target, no physics body.
- Colliders: Rapier `box`, `sphere`, `capsule`, `cylinder` or a convex hull of the `.glb`'s vertices, scaled by keyframe
  `s`. Physics runs at 60 Hz with continuous collision detection; a throw is capped at 12 m/s.
- `mass`: the mass of the object's physics body. `grabbable`: whether a pointer, a hand or a controller can pick the
  object up. Only the grabbed object is simulated: the other objects stand still as obstacles at their pose at the grab,
  and follow their tracks again on replay.
- `visibleFrom` and `visibleTo`: the object is shown only between them, except while an edited take's recording moves
  it.

A required file that fails to load (the room, a collider, a mesh, a track) stops loading with an error.

## The static walk-through: `memory.static.json`

`memreplay merge --static` writes a second manifest beside `memory.json`: the room alone, to walk through.
`memreplay run` and the worker write it whenever the static room has been trained. It is the same format, with:

- the background `world/bg_static.spz`, trained on every frame with only people masked out, so the props stay part of
  the room (at most 500,000 splats);
- the room collider, the camera track (the start position, wearer's view and exposure), `timeline.gaps` and the audio;
- no objects: no people and no props. Its `id` ends in `-static`.

Open it like any scene, for example `/?memory=/memories/<id>/memory.static.json`. The worker publishes it next to
`memory.json` (only `memory.json` is registered in SpacetimeDB), the bundle importer offers it as the static
alternative, and the library's scene publishing uploads it alongside.

## Scene bundles: `.memos.zip`

A `.memos.zip` carries a finished scene to a browser without hosting it. It is an ordinary, unencrypted ZIP of a scene
folder: `memory.json` (and `memory.static.json`, if any) plus every file they reference, at the same relative paths. A
single enclosing folder inside the ZIP is fine, and the importer reads any standard ZIP, whatever its name.

To make one from a scene folder:

```bash
python3 pipeline/tools/package_scene.py path/to/scene-folder my-scene.memos.zip
```

The folder must contain `memory.json`, and the output name must end in `.memos.zip`. The script packs the files with
scene extensions (`.json`, `.spz`, `.ply`, `.splat`, `.ksplat`, `.sog`, `.glb`, `.bin`, `.m4a`, `.mp4`, `.mov`), skips
hidden files, refuses symbolic links, never overwrites an existing file, and enforces the importer's size limits. It
uploads nothing.

To import one, sign in to the library (`/library.html`) with your name or six-digit password. In **Import a 3D memory**,
pick the ZIP with **Scene ZIP** (or a scene folder with **Or scene folder**), choose the **Scene manifest**
(`memory.json`, or `memory.static.json` as the static alternative) and press **Import and open in 3D**. The scene is
saved in this browser's IndexedDB for the signed-in account, listed under **On this device**, and opens at
`/?import=<id>` in free camera (`&mode=follow` rides the recorded walk). Nothing is uploaded or registered in
SpacetimeDB, so an imported scene can't be used in a party, and clearing the site's data removes it. On a phone, save
the ZIP to Files and pick it with **Scene ZIP**.

Before saving, the importer checks:

- at most 250 MB expanded and 4,000 files; a manifest and external tracks of at most 16 MB each; at most 4,000
  `splat-sequence` frames;
- safe relative paths only: no scheme, leading `/`, backslash, `?`, `#`, `.` or `..` segment. Hidden files and
  `__MACOSX` folders are ignored; duplicate paths are rejected;
- `validateManifest`, a positive `source.width` and `source.height`, every track, and a `background.splatCount` of at
  most 1,000,000;
- every referenced file present and non-empty. The error names up to six missing files; a scene whose people files are
  missing can still be imported as `memory.static.json`, but the importer never switches to it on its own;
- every `.glb` is binary glTF 2.0 with its buffers and textures embedded (`data:` URIs are fine).

Importing does not repair or reconstruct anything. A `.spz` alone is one 3D appearance and a video alone is a video:
neither is a scene.

## Hosting a scene

To share a scene with a party, its folder must sit at a URL every device can reach:

- Keep the folder's layout: a manifest at `https://assets.example/memories/kitchen/memory.json` loads its room from
  `https://assets.example/memories/kitchen/world/bg_room.spz`.
- Serve `.json` as `application/json`; `.spz`, `.ply` and `.bin` as `application/octet-stream`; `.glb` as
  `model/gltf-binary`; and `.m4a` as `audio/mp4`. Support byte-range requests, which the audio uses to seek. The
  worker's S3 publisher and the upload API's file routes already do this.
- When the files come from another origin than the viewer, allow `GET` and `HEAD` from the viewer's origin in the
  bucket's CORS policy.
- Register it: in the viewer, open the party panel (**Solo**), expand **Add a memory**, paste the full
  `https://…/memory.json` URL into **memory.json link** and press **Add to library**. This calls `create_memory` with
  the manifest URL and the manifest's duration, and the memory is `ready` at once. The URL is resolved against the page,
  so register a scene from a public address, not from `127.0.0.1`, or phones can't open it.
- Or, on the Cloudflare Workers upload API, use the library's **Publish scenes**: choose a **Scene folder** (one scene,
  or a folder of several) and press **Publish**. It validates each scene, uploads its files (at most 64 MiB each) and
  registers it as a `ready` memory of the signed-in account. The Node upload API has no publishing routes.

For local work, copy scene folders into `apps/web/public/memories/<id>/` (ignored by git), run
`python3 pipeline/tools/index_scenes.py`, then open `/scenes/index.html` or `/?memory=/memories/<id>/memory.json` on the
dev server. `npm run build` copies everything under `apps/web/public/` into the build, these local scenes included; the
hosted build (`scripts/deploy/build-hosted-web.mjs`) copies only `demo/` and `mock/`.

## Limitations

- A prop that falls back to a `primitive` visual is not grabbable in the viewer: it stays baked into the room splat.
- `splat-sequence` frames are not counted against the splat budget when a scene loads.
- People are points, not trained splats. A real 4D splatting experiment and what it would take to integrate are in
  [reports/4dgs.md](./reports/4dgs.md).
