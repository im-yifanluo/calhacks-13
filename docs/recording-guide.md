# Recording guide

How to record a clip that memos rebuilds into a good 3D memory, with Ray-Ban Meta glasses or a phone. The pipeline gets
depth from the camera's own movement: NVIDIA ViPE triangulates across time as the camera moves, so how you move matters
more than which camera you use. It needs a video; a single photo can't be rebuilt.

## Required and recommended

### Required

These are checked by code; a clip that fails them is refused.

- **A video file:** MP4 or MOV. The upload API also accepts WebM, but the web upload panel and the iPhone app's importer
  take MP4 and MOV.
- **Upload limits:** at most the server's `maxUploadBytes`, which `GET /api/account/config` reports (2 GiB by default,
  90 MiB on the Cloudflare Workers deployment); a duration of up to an hour; a title of 1–120 characters.
- **In the iPhone app,** when the server reconstructs videos (`pipelineAvailable` is not `false`): at least 1280 px on
  the long edge, a frame rate of about 24 fps or more (23.976 fps passes; the check is 23.5 fps) and a non-empty audio
  track (`apps/ios/SceneCapture/CaptureRequirements.swift`). A clip that fails stays on the phone, and the error gives
  its measured size, frame rate and audio.

The web upload checks none of these media properties, and the pipeline takes any video ffmpeg can read (audio is
optional there).

### Recommended

- **30 fps** (see below).
- **1080p.** More resolution only makes the upload bigger: the first pipeline step scales every clip to 1280 px on the
  long side.
- **Stabilization off.** Stabilization warps each frame differently, which breaks the camera solve.
- **Sound on.** The scene plays the clip's audio in sync with the timeline.
- **SDR, or HLG HDR** (an iPhone's HDR video). The pipeline tone-maps HLG to SDR; PQ HDR (HDR10) is converted without
  tone mapping and looks flat.

### Frame rate: 30 fps recommended, about 24 fps accepted

The first pipeline step (S1 normalize) turns every clip into a constant 30 fps video, and the scene's tracks and camera
path are sampled every third frame (10 Hz). Record at 30 fps.

The iPhone app accepts clips from about 24 fps up because the glasses' live stream through Meta's toolkit can deliver
around 25 fps even when the app asks for 30. S1 resamples such a clip to 30 fps by repeating frames: the timing stays
right, but no dropped frame comes back. A higher frame rate brings nothing, because S1 drops it to 30 fps.

## Capture settings

### Ray-Ban Meta glasses

- In the Meta AI app, set the glasses' video to 1080p at 30 fps and turn video stabilization off. The modes and toggles
  depend on the glasses' generation and firmware ("Wayfarer" is a frame style, not a generation). Prefer 1080p: that is
  the mode with a documented stabilization switch.
- Keep audio on.
- The glasses have one ultrawide camera. ViPE estimates the lens itself, so no calibration or undistortion is needed.
- The glasses' own recorder gives the steadiest input. The live stream through the iPhone app is convenient, but it can
  drop to about 25 fps, and its audio is experimental in Meta's toolkit.

### Phone

- Use the standard video mode at 30 fps, 1080p or 4K, and avoid action modes with heavy stabilization.
- An iPhone's HDR video is fine. On a phone that records PQ HDR (HDR10), record SDR instead.
- Hold the phone steady at one height, at chest or eye level.
- Pan wider than feels natural. A phone in portrait sees about 36° across, while the viewer shows about 100°, so
  whatever the camera never saw is blurry or empty at the sides of the view.

## The scripted take

Shoot one take of under 30 seconds, three times, and keep the best:

1. **Look at the floor for 3 seconds.** The pipeline finds the floor plane, and from it which way is up. When the floor
   is barely in view, it has to assume the floor's height.
2. **Walk 2–3 m sideways while slowly panning across the room.** Sideways movement gives parallax, which is what ViPE
   triangulates depth from. Turning your head on the spot gives it nothing.
3. **Then the action:** someone else moves, tosses or throws the props while you keep filming.

Throughout, stay standing at one height and turn slowly.

## Props and people

- **Props:** 2–3 compact, free-standing things such as a ball, a can, a bottle, a kettle, a pillow or a box, ideally
  symmetric and brightly coloured. The pipeline tracks a prop's position but not its rotation, so a symmetric prop looks
  right when it moves.
- **What doesn't become a prop:** things on walls or built in (signs, paintings, hooks, mirrors) stay part of the room,
  and worn or carried things (bags, lanyards, shoes, phones, cameras) are left alone.
- **Film each prop clearly, from a few angles.** A prop becomes grabbable only if the pipeline can carve its own splat
  out of the room (at least 50 Gaussians). Otherwise it stays baked into the room and can't be picked up.
- **Someone other than the wearer** moves or throws the props.
- **People** become moving point "ghosts" (up to 12,000 coloured points per person per frame), not solid figures. One or
  two people who keep moving work best. People who sit or linger get baked into the room as smears, and in a crowd ViPE
  runs out of labels (it tells apart at most about 250 things in a clip), so walkers turn into sparse mosaics.

## What breaks tracking

ViPE loses or wobbles the camera path in these situations. The pipeline leaves out frames where the path jumps (more
than 15 cm off the smoothed path, or a turn of more than 20° in one frame), and the viewer fades longer lost stretches
to black.

- **Turning on the spot:** no parallax.
- **Fast turns and quick pans:** motion blur and big jumps between frames.
- **Close-ups of blank, white or dark walls:** nothing to track. In one hotel lobby clip ViPE lost a third of the frames
  near a close, dark wall; white bathroom tiles never got enough views.
- **Walking straight ahead:** little parallax, so the room streaks along the walking direction. Mix in sideways steps
  and pans.
- **Changing height** by sitting, crouching or lifting the camera. The pipeline uses the camera's steady height to tell
  the floor from tables and seats.
- **Glass, mirrors, windows and reflections,** and transparent things: a clear acrylic podium came out only partly.
- **Uneven light:** bright windows next to dark corners make the camera's exposure swing, and overexposed walls and
  lamps wash out. Even light is best; night scenes flare.
- **Moving cars and other big moving things that aren't people:** they smear into the room.

## Clip length

- Under 30 seconds is plenty for a room.
- Longer clips cost GPU time. Every clip becomes 30 fps, and ViPE processes about 2 frames per second on an H100: an
  11-second clip took about 4 minutes and a 2½-minute walk 34 minutes, before the room's splat trains (roughly 8–20
  minutes). Long walks also drift vertically, which the pipeline has to level out.
- Hard limits: 90 seconds per recording through the iPhone app's glasses stream, plus the upload limits above.

## Measure the eye height

Measure the camera's height above the floor while recording. For the glasses, that is the wearer's eye height, standing,
in the shoes they wear. For a phone, it is where the phone was held: a phone at the chest of a 185 cm person is about
1.35 m.

The pipeline uses this height twice in its world step: to choose the floor (it prefers the plane that puts the camera at
this height, so a stage or a bed isn't taken for the floor), and to check ViPE's metric scale (it rescales when the
camera's median height is more than 25 % off). Pass it when you run the pipeline yourself, for example
`memreplay run work/kitchen --title "Kitchen" --eye-height 1.62`. An upload through the app or the library carries no
eye height: the worker then assumes 1.45 m and corrects the scale only when the camera's height is 40–70 % off.

## Get the clip into memos

### With the iPhone app and the glasses

In the `SceneCapture` app (setup in [ios.md](./ios.md)):

1. On the **Capture** tab, press **Connect with Meta AI**, then **Start Session** and **Preview glasses camera**.
2. Enter a title, press **Record**, then **Stop & save**. A recording stops on its own after 90 seconds. Keep the app in
   the foreground: going to the background ends the session.
3. When you are signed in, the clip uploads by itself. Otherwise it stays under **Memories**, in **On this phone**,
   until you choose **Upload as** your name. **Retry uploads** resumes uploads that failed.

### With the glasses' own recorder

1. Record with the glasses: press and hold the capture button to start a video, and press it again to stop (see
   [Ray-Ban's FAQ](https://www.ray-ban.com/usa/c/frequently-asked-questions-ray-ban-meta-smart-glasses)).
2. Import the video in the Meta AI app and save it to the phone (MOV on iPhone, MP4 on Android). Check that it plays
   there.
3. Upload it, in one of three places:
   - the iPhone app: **Memories**, then **Import glasses MP4 / MOV** (the same checks as a live recording);
   - the web library (`/library.html`), signed in with your name or six-digit password: in **Upload a video**, enter a
     **Title**, choose the **Video** and press **Upload video**. To upload from a computer, AirDrop or copy the file
     there first;
   - the capture test page (`/capture.html`), under **Test a real glasses video**: the same upload panel, without
     signing in, next to tools that check the stored file ([capture-testing.md](./capture-testing.md)).

If the browser can't read the video's duration, export an H.264 MP4 copy and upload that. A phone clip goes the same way
as a Meta AI export.

### By hand on the GPU pod

Copy the clip into a work folder as `clip.mov` or `clip.mp4` and run `memreplay run` with `--eye-height`: see the
[pipeline runbook](../pipeline/README.md).

### After the upload

The memory's card in the library shows the upload, then the reconstruction's progress, then **Explore in 3D** when the
scene is ready. A server without a GPU worker (`pipelineAvailable: false`) stores the video without reconstructing it;
**Watch original** plays it back.

## Limitations

- **Audio over the live stream:** Meta's toolkit marks the glasses' streamed audio as experimental, and a test recording
  through the app played back without audible sound. When the sound matters, use the glasses' own recorder.
- **Throws in the recording** are the least tested part of the pipeline: it fills a throw's arc only through gaps that
  start as a throw, and that has been checked only on synthetic scenes.
- **The scene is reliable only where the camera looked.** Guided mode in the viewer keeps you near the recorded path and
  fogs what the camera never saw.
- Clip-by-clip results, scores and what limits quality: [reports/vision-pipeline.md](./reports/vision-pipeline.md).
