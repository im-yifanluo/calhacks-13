# P4 demo and Devpost draft

## Three-minute rehearsal

- **0:00–0:25 — Capture/import:** Show a clip recorded on the Wayfarer glasses and imported through Meta AI. Explain that the web app accepts the exported recording. If storage/worker is not configured, state that this segment is the capture handoff rather than a live reconstruction.
- **0:25–0:50 — Upload/status:** With real infrastructure ready, upload and show the status row. For a fast demo, use a previously processed scene and disclose the processing time. With only the local P4 branch, register `/mock/memory.json` and keep `?demo=1` visible; call it a geometry fixture.
- **0:50–1:25 — Share:** Create a room, open its link on the second device, and show two names and a moving remote head. Pause/seek on one screen and point to the matching playhead on the other.
- **1:25–2:10 — Edit:** Pause near 1 second. Grab the object on the phone and release it. Show the automatic branch and the other client's matching movement. Wait until the simulation ends before seeking.
- **2:10–2:40 — Replay:** Rewind and play the alternate trajectory. Switch to Original. Open a fresh tab on the branch to demonstrate that the trajectory persists for late joiners.
- **2:40–3:00 — Architecture:** Explain database ownership arbitration, client physics, and recorded keyframes. State which GPU/XR pieces are integrated in the build being shown.

## Go/no-go checklist

| Gate        | Evidence required                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Local P4    | `npm test`, typecheck, web build, and network integration test pass                                      |
| Storage     | Real exported video PUT succeeds; incomplete upload cannot register; retry produces one memory           |
| Pipeline    | Assigned worker processes the uploaded source and publishes a valid manifest; failure is visible         |
| Two devices | Correct room, presence, shared time and branch across phone and Quest                                    |
| Interaction | Phone ownership contention, throw, rest, rewind and late-join replay agree                               |
| P3 scene    | Actual object assets/colliders render; headset hands/controllers work; measured frame rate is acceptable |
| Demo assets | Only intended demo recordings and public URLs; no binary assets or credentials in Git                    |

The local branch was tested with 16 automated module/upload/client/storage tests, the real SpacetimeDB 2.13 network suite, and a browser session at desktop and 390×844 viewport sizes. A real two-second synthetic MP4 also passed upload, independent database lookup, byte-for-byte retrieval, repeated-completion and browser playback checks; see [CAPTURE_TEST.md](CAPTURE_TEST.md). The native iPhone O/F app is implemented but its full SDK build and hardware test require newer Xcode and the devices. Cloud storage, GPU reconstruction and physical-device gates remain unverified. A resized browser is not evidence of a real phone test.

## Devpost copy (draft; review before submitting)

**Name:** Memory Replay

**Tagline:** Return to a captured moment together—and explore an alternate timeline.

**Inspiration:** A video preserves one viewpoint. We want to turn a recorded scene into a place friends can revisit and interact with, from a headset or a phone.

**What we built in the P4 lane:** A shared browser experience with rooms, presence, synchronized time, phone object manipulation, and persistent alternate trajectories. SpacetimeDB arbitrates object ownership so one client simulates an object while others follow. The upload service registers exported glasses clips and exposes processing status from an assigned reconstruction worker.

**How it works:** Meta AI imports the recording from the glasses. Our phone web page uses a presigned PUT to object storage and registers the source in SpacetimeDB. Reconstruction workers publish a `memory.json` manifest and assets. The viewer shares room state and records edited motion as branch keyframes, allowing later participants to replay it.

**What we learned:** Releasing a held object must preserve simulation authority until it rests. Reconnection needs both an HTTP token exchange and replayed WebSocket subscriptions. Upload completion must stay idempotent even after processing changes a memory's status.

**Current limits:** This P4 branch uses explicit debug geometry for the local interaction demo. The GPU reconstruction stages and production Quest renderer/input are other team lanes; list them as completed only after their actual device gates pass. Processing speed, visual quality and headset frame rate have not been measured here.

**Next:** Integrate the team's reconstruction output and XR controls, then run the capture-to-headset test with the actual Wayfarer glasses, phone and Quest.

Before submission: replace the fixture with the integrated scene if ready, add the actual demo video and measured processing/performance numbers, verify the event's current submission fields/prizes, and review the team attribution. This document is a draft; nothing has been submitted or announced.
