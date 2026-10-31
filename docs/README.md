# Documentation

Start with the [README](../README.md) for what memos is and how to run it.

## Guides

- [Architecture](architecture.md): the components, the interfaces between them (I1–I7) and the design decisions.
- [Development](development.md): local setup, the full local stack, commands, environment variables and every test
  suite.
- [Viewer](viewer.md): camera modes, controls on desktop, phone and Quest, URL parameters and the engine.
- [Multiplayer](multiplayer.md): parties, the shared clock, takes, grabbing and the network adapter.
- [Scene format](scene-format.md): `memory.json`, the world frame and `.memos.zip` scene bundles.
- [Upload API](upload-api.md): routes, accounts and six-digit passwords, the GPU worker handoff.
- [Deployment](deployment.md): hosting SpacetimeDB, storage, the upload API, the web app and the GPU worker.
- [iPhone app](ios.md): the two Xcode projects, recording, the upload queue and the check programs.
- [Capture testing](capture-testing.md): the capture test page and stored-video checks.
- [Recording guide](recording-guide.md): how to record clips that reconstruct well.
- [Pipeline runbook](../pipeline/README.md): every pipeline step, the GPU pod and the worker.

## Reports

- [Vision pipeline](reports/vision-pipeline.md): results on the phone and glasses clips, an independent judge
  panel's verdicts and what limits quality. Judge data: [reports/judge/](reports/judge/).
- [4D Gaussian splatting](reports/4dgs.md): a parallel experiment with true 4D splatting, compared with the layered
  scene.

## History

- [The original plan](history/plan.md): decisions, design and timeline as planned at the start of the hackathon.
- [Demo script](history/demo-script.md): the three-minute demo and the Devpost draft.

The system diagram is drawn by [architecture/make_arch.py](architecture/make_arch.py).
