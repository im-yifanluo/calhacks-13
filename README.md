# memos

Record a moment on Ray-Ban Meta glasses, then step back inside it. memos rebuilds the clip as a 3D scene that moves
over time, and you walk through it with friends on a Quest 3S, a phone or a laptop. Pause time, grab things, throw
them, and branch off an alternate take of what happened.

Built at CalHacks 13, October 23–25, 2026.

## Features

- **Capture:** an iPhone app records from the glasses (or a simulated camera) and uploads each clip with a durable,
  resumable queue.
- **Reconstruction:** a GPU pipeline turns one clip into a scene: the room as a Gaussian splat at real scale, people
  as moving point ghosts, the wearer's head path and audio, and small props as grabbable objects with physics.
- **One viewer everywhere:** the same web app runs in the Quest browser (WebXR, controllers and hands), on phones
  (touch and a walk pad) and on desktops (mouse and WASD).
- **Ways to watch:** follow the recorded walk, roam freely, stay near the camera's path in guided mode, or see
  exactly what the wearer saw.
- **Change what happened:** pause, grab an object and throw it. Each edit becomes a new take you can replay, and the
  original recording stays untouched.
- **Watch together:** parties share one clock through SpacetimeDB. The leader controls time, everyone sees the same
  take, and other players appear as avatars.

## How it works

![Architecture](docs/architecture/arch.png)

**Ship the scene, sync the state.** The GPU builds the scene files once; every device downloads them and renders
locally. Only small shared state (the clock, grabs and poses) travels live, so a party needs no rendering server.

1. The phone app uploads the clip through the upload API, which stores it and registers a `memory` row in
   SpacetimeDB.
2. The GPU worker picks up the upload and runs the pipeline: NVIDIA ViPE for the camera path, depth and masks, then a
   level, metric world frame, a gsplat room, people ghosts and prop tracks, written as `memory.json` plus assets.
3. The worker publishes the scene to storage and marks the memory ready.
4. Viewers load the scene files and join a party; the network adapter keeps their clocks, takes and grabs in sync.

Details: [architecture](docs/architecture.md) and the [scene format](docs/scene-format.md).

## Quick start

You need Node.js 22.13 or later (`.nvmrc` pins 22.23.2).

```bash
npm install
LOCAL_HTTP=1 npm run dev
```

Open http://127.0.0.1:5173. The default page is a small built-in demo: press Space to pause, drag the ball or the
can, let go to throw it, then play the new take. Parties and uploads also need SpacetimeDB and the upload API
running locally; [development](docs/development.md) has the full setup, and the [viewer guide](docs/viewer.md)
covers the Quest and phones.

Checks:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
pip install -e "pipeline[dev]" && ruff check . && pytest pipeline
```

## Repository layout

```
apps/
  web/            the viewer, memory library and capture test pages (Vite, three.js, Spark, Rapier)
  ios/            the iPhone capture app (SwiftUI, Meta Wearables Device Access Toolkit)
server/
  spacetime/      SpacetimeDB module: accounts, memories, parties, shared clock, takes, grabbing
  upload/         upload API: signed uploads, six-digit passwords, scene publishing (Node or Cloudflare Workers)
packages/
  shared/         the memory.json scene format and its validation
pipeline/         the vision pipeline (Python): clip → ViPE → world frame → room splat, ghosts, props → memory.json
scripts/          dev/ and deploy/ helpers
tests/            cross-package tests, integration suites against local services, end-to-end suites
docs/             guides, reports and the original hackathon plan
```

## Documentation

| Guide                                              | What it covers                                             |
| -------------------------------------------------- | ---------------------------------------------------------- |
| [Architecture](docs/architecture.md)               | Components, interfaces and design decisions                |
| [Development](docs/development.md)                 | Local setup, the full stack, commands and test suites      |
| [Viewer](docs/viewer.md)                           | Camera modes, controls, URL parameters, Quest and phones   |
| [Multiplayer](docs/multiplayer.md)                 | Parties, the shared clock, takes and grabbing              |
| [Scene format](docs/scene-format.md)               | `memory.json`, the world frame and scene bundles           |
| [Upload API](docs/upload-api.md)                   | Routes, accounts and passwords, the worker handoff         |
| [Deployment](docs/deployment.md)                   | Hosting the database, storage, API, web app and GPU worker |
| [iPhone app](docs/ios.md)                          | The two Xcode projects, recording and uploading            |
| [Capture testing](docs/capture-testing.md)         | The capture test page and stored-video checks              |
| [Recording guide](docs/recording-guide.md)         | How to record clips that reconstruct well                  |
| [Pipeline runbook](pipeline/README.md)             | Every pipeline step, the GPU pod and the worker            |
| [Pipeline report](docs/reports/vision-pipeline.md) | Results on the demo clips and what limits quality          |
| [4D splatting report](docs/reports/4dgs.md)        | A comparison with true 4D Gaussian splatting               |

[CONTRIBUTING.md](CONTRIBUTING.md) explains the conventions and the checks a change must pass.

## Limitations

- Reconstruction quality depends on the clip: walking sideways while panning works; turning on the spot, blank walls
  and fast motion do not ([recording guide](docs/recording-guide.md)).
- People are point ghosts, not splats, and only small props can be grabbed. The [4D splatting
  report](docs/reports/4dgs.md) explores the alternative.
- The privacy model suits a demo: memory rows and their storage URLs are readable by anyone with database access.

## Team

Built at CalHacks 13 by Yifan, Jerry, Nikko, and Andrew.

memos builds on [three.js](https://threejs.org), [Spark](https://sparkjs.dev), [Rapier](https://rapier.rs),
[SpacetimeDB](https://spacetimedb.com), [NVIDIA ViPE](https://github.com/nv-tlabs/vipe),
[gsplat](https://github.com/nerfstudio-project/gsplat) and the
[Meta Wearables Device Access Toolkit](https://wearables.developer.meta.com).
