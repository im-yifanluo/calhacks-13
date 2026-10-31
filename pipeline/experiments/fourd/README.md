# 4D Gaussian splatting experiment

A parallel track that trained [4DGaussians](https://github.com/hustvl/4DGaussians) (CVPR 2024) on the glasses clips,
to compare true 4D splatting against the main pipeline's static room plus moving layers. Results, costs and what is
still missing for VR are in [docs/reports/4dgs.md](../../../docs/reports/4dgs.md). Nothing here is part of
`memreplay` or the automatic worker.

The scripts run on the GPU pod and use its fixed layout: a 4DGaussians checkout in `/workspace/4dgs/A/4DGaussians`,
datasets in `/workspace/4dgs/A/data/<clip>`, runs in `/workspace/4dgs/A/runs/<clip>/<run>`, a venv in
`/workspace/envs/4dgs` on top of the pipeline's `world` environment, and logs in `/workspace/logs/4dgs.log`.

| Step | Script | What it does |
| --- | --- | --- |
| 1 | `patch_4dgaussians.py <4DGaussians dir>` | Patches a 4DGaussians checkout (commit 843d5ac), idempotently: torch 2.9 compatibility, a robust scene box, and the opt-in static/dynamic split (`FOURD_DYN_FLAG=1`) and random training background (`FOURD_RANDBG=1`) |
| 2 | `convert.py <work dir> <dataset dir>` | A `memreplay` work dir (ViPE + world poses) to the Nerfies/HyperNeRF dataset layout 4DGaussians reads |
| 3 | `train.sh <clip> <run> <config> <gpu>` | Trains with a config from `configs/` (v59a/v59d: the v59 runs; v71a: v71) |
| 4 | `post.sh` / `post.py` | Scores held-out frames, renders videos and exports per-time `.spz` frames in the viewer's world frame |
| — | `static_eval.py` | Scores the main pipeline's static room at the same held-out cameras, for a like-for-like comparison |
| — | `compare.py` | The side-by-side image in the report (video frame, main pipeline, 4DGS) |
| — | `motion.py` | How far the deformation moves each Gaussian, on people versus the room |
| — | `fit_world.py` | Maps a model trained in an older world frame onto the current one, for `post.py --to_world` |
