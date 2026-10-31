#!/usr/bin/env bash
# One-time setup of the vision pipeline on a Runpod pod with a network volume at /workspace.
#   bash setup.sh base world vipe warmup   # the whole pipeline (run in this order)
# Finished steps leave a marker in $ENVS/<env>/.setup-<step>; a rerun skips them (delete a marker to redo it).
# Every block follows the tool's own README as of 2026-10-23; if a step fails, check that README first (repo names
# in pipeline/README.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
bash "$HERE/on_start.sh"   # always: idempotent; installs libGL (open3d) and git-lfs too
source "$HERE/env.sh"
mkdir -p "$SRC" "$ENVS" "$WORK" "$HF_HOME" "$TORCH_HOME"

clone()     { [ -d "$SRC/$2" ] || git clone --recursive "$1" "$SRC/$2"; }
have_env()  { [ -d "$ENVS/$1/conda-meta" ]; }
mamba()     { "$WS/miniforge3/bin/mamba" "$@"; }   # call Miniforge's binary directly (not on PATH inside envs)
need_base() {   # Miniforge must exist; load conda's shell functions if base was installed in this same run
  [ -x "$WS/miniforge3/bin/mamba" ] || { echo "Run 'bash setup.sh base' first."; exit 1; }
  type conda >/dev/null 2>&1 || source "$WS/miniforge3/etc/profile.d/conda.sh"
}
step() {    # step <name> <command...>: run once per env, then skip on reruns
  local marker="$CONDA_PREFIX/.setup-$1"; shift
  [ -f "$marker" ] && { echo "  (skip $1: already done)"; return 0; }
  "$@" && touch "$marker"
}
check_nvcc() {  # check_nvcc <major.minor>: the active env's nvcc must match the CUDA that torch was built with
  local v; v=$("$CONDA_PREFIX/bin/nvcc" --version | sed -n 's/.*release \([0-9]*\.[0-9]*\).*/\1/p')
  [ "$v" = "$1" ] || { echo "nvcc in $CONDA_PREFIX is CUDA $v, expected $1"; exit 1; }
}
cuda_toolkit() {  # cuda_toolkit <major.minor>: nvcc + headers inside the active env (the Runpod image ships no nvcc)
  # Pin cuda-version: a channel label alone loses to conda-forge's newest CUDA (we got 13.4 + gcc 15 for torch cu128).
  step "cuda-$1" mamba install -y -p "$CONDA_PREFIX" -c conda-forge "cuda-version=$1" cuda-toolkit
  export CUDA_HOME="$CONDA_PREFIX"
  check_nvcc "$1"
}

base() {  # Miniforge (conda + mamba) on the volume
  if [ ! -x "$WS/miniforge3/bin/conda" ]; then
    curl -fsSL -o /tmp/miniforge.sh \
      https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
    bash /tmp/miniforge.sh -b -p "$WS/miniforge3"
  fi
  echo "Miniforge ready. Next: bash setup.sh world vipe warmup"
}

world() {  # everything except ViPE: our code, ffmpeg 6, gsplat (main branch), open3d, Claude SDK, splat-transform
  need_base
  have_env world || mamba create -y -p "$ENVS/world" python=3.12 "nodejs>=22" "ffmpeg>=6" ninja
  use world
  # ninja lets torch compile gsplat's CUDA files in parallel (without it: one file at a time, ~40 min)
  [ -x "$CONDA_PREFIX/bin/ninja" ] || mamba install -y -p "$CONDA_PREFIX" -c conda-forge ninja
  export MAX_JOBS="${MAX_JOBS:-32}"
  cuda_toolkit 12.8   # must match torch's cu128 wheels below
  step torch pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu128
  clone https://github.com/nerfstudio-project/gsplat gsplat
  step gsplat pip install -e "$SRC/gsplat" --no-build-isolation
  step gsplat-examples pip install -r "$SRC/gsplat/examples/requirements.txt" --no-build-isolation
  step geo pip install open3d pycolmap opencv-python-headless scipy OpenEXR trimesh anthropic boto3
  step memreplay pip install -e "$REPO/pipeline"
  step splat-transform npm install -g @playcanvas/splat-transform
  # quick health check, so a broken env shows up now instead of at S1/S3/S6
  ffmpeg -hide_banner -encoders | grep -q libx264 \
    || { echo "ffmpeg lacks libx264. Fix: mamba install -y -p $ENVS/world 'ffmpeg=*=gpl*'"; exit 1; }
  "$CONDA_PREFIX/bin/nvcc" --version > /dev/null
  python -c "import open3d, gsplat, anthropic, trimesh, memreplay.handoff; print('world imports OK')"
  echo "world env ready: use world && memreplay --help"
}

VIPE_COMMIT=8c9f361   # the commit our commands were checked against (Sep 2026)

vipe() {  # S2: NVIDIA ViPE. Its Python packages live in its own uv venv; this conda env only holds CUDA + uv.
  need_base
  clone https://github.com/nv-tlabs/vipe vipe
  cd "$SRC/vipe"
  git checkout -q "$VIPE_COMMIT"
  # = ViPE's envs/cu128.yml, plus a cuda-version pin (its channel label alone loses to conda-forge's newest CUDA)
  # and ninja (otherwise torch compiles the CUDA extensions one file at a time).
  have_env vipe || mamba create -y -p "$ENVS/vipe" -c conda-forge "cuda-version=12.8" uv cuda-nvcc eigen zlib \
    libcusparse-dev libcublas-dev libcusolver-dev ninja
  use vipe
  check_nvcc 12.8
  step uv-sync uv sync     # uv's own Python 3.12 (UV_PYTHON_PREFERENCE in env.sh); builds the CUDA extensions into .venv
  # import torch first so libc10/libcudart are loaded; a broken build would otherwise silently JIT-rebuild at run time
  uv run python -c "import torch, vipe_ext; print('ViPE CUDA extension OK; torch', torch.__version__)"
  echo "ViPE ready: cd $SRC/vipe && uv run vipe --help"
}

warmup() {  # download ViPE's weights now. Two (DeAOT, DROID-SLAM) come from Google Drive, which rate-limits.
  need_base
  local d="$WORK/_warmup"; mkdir -p "$d"; rm -rf "$d/vipe"
  [ -f "$d/clip.mp4" ] || "$ENVS/world/bin/ffmpeg" -loglevel error -f lavfi -i testsrc=duration=2:size=640x480:rate=30 \
    -pix_fmt yuv420p "$d/clip.mp4"
  cd "$SRC/vipe"
  use vipe
  uv run python run.py pipeline=default streams=raw_mp4_stream streams.base_path="$d/clip.mp4" streams.frame_end=10 \
    pipeline.output.path="$d/vipe" pipeline.output.save_artifacts=true \
    || echo "ViPE warmup exited with an error (a test pattern may fail SLAM; fine if the Google Drive check passes)."
  local f missing=""
  for f in "$TORCH_HOME/hub/aot/R50_DeAOTL_PRE_YTB_DAV.pth" "$TORCH_HOME/hub/droid_slam/droid.pth"; do
    [ -s "$f" ] || missing="$missing $f"
  done
  [ -z "$missing" ] || { echo "Google Drive weights missing:$missing (rate-limited? retry later: bash setup.sh warmup)"; exit 1; }
  if [ -f "$d/vipe/pose/clip.npz" ]; then
    echo "ViPE warmup OK: all weights downloaded and poses written"
  else
    echo "ViPE warmup: Google Drive weights are in place; the rest (Hugging Face) download on the first real run."
  fi
}

TARGETS="base world vipe warmup"
[ $# -gt 0 ] || { echo "usage: bash setup.sh <target>...   targets: $TARGETS"; exit 1; }
for target in "$@"; do
  case " $TARGETS " in *" $target "*) ;; *) echo "unknown target: $target (targets: $TARGETS)"; exit 1 ;; esac
  echo "=== setup: $target ($(date +%H:%M:%S)) ==="
  # Subshell so cd/env changes don't leak. Note: `( f ) || ...` would silently disable set -e inside f.
  set +e; ( set -e; "$target" ); rc=$?; set -e
  [ "$rc" = 0 ] || { echo "=== setup $target FAILED (see the error above) ==="; exit 1; }
  echo "=== setup $target done ($(date +%H:%M:%S)) ==="
done
