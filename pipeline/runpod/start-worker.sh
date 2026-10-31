#!/usr/bin/env bash
# Run one foreground worker per configured identity. tmux keeps it running after SSH disconnects.
set -euo pipefail
cd "$(dirname "$0")/../.."
source pipeline/runpod/env.sh
worker_env="${MEMREPLAY_WORKER_ENV:-/workspace/memos-worker.env}"
# Some RunPod network volumes ignore chmod. Resolve symlinks and refuse a token
# readable by other users; store it under /root when the volume cannot enforce 0600.
python3 - "$worker_env" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1]).resolve(strict=True)
if path.stat().st_mode & 0o077:
    raise SystemExit("Worker credential must be root-only (0600); use /root/memos-worker.env on volumes that ignore chmod")
PY
source "$worker_env"
use world
# Use this checkout even if Yifan's shared environment has an older editable install.
export PYTHONPATH="$PWD/pipeline${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
command -v flock >/dev/null
test -f "$SRC/vipe/run.py" || { echo "ViPE is missing; run pipeline/runpod/setup.sh first" >&2; exit 1; }
test -f pipeline/memreplay/source_check.py || { echo "pipeline/memreplay/source_check.py is missing; sync the complete worker source" >&2; exit 1; }
python -c 'import torch, gsplat, cv2, OpenEXR, scipy, trimesh, pydantic; assert torch.cuda.is_available(), "CUDA GPU is not available"'
( use vipe; cd "$SRC/vipe"; uv run python -c 'import torch, vipe_ext; assert torch.cuda.is_available(), "ViPE cannot access CUDA"' )
python -m memreplay.hosted_publish
if [[ "${1:-}" == "--check" ]]; then exit 0; fi
mkdir -p "${MEMREPLAY_WORK:-$WORK}"
# One GPU worker per work directory. Accidental second starts fail instead of training a job twice.
exec flock --nonblock "${MEMREPLAY_WORK:-$WORK}/.memos-worker.lock" python -m memreplay.cli worker "$@"
