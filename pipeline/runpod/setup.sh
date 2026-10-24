#!/usr/bin/env bash
# One-time setup of the vision pipeline on a Runpod pod with a network volume at /workspace.
#   bash setup.sh base world vipe warmup   # the whole initial pipeline (run in this order)
#   bash setup.sh extras                   # later, only if needed: SAM 2.1 masks + CoTracker3 rotation
#   bash setup.sh sam3d sam3d_weights      # stretch only: SAM 3D Objects (half a day of installs)
# Finished steps leave a marker in $ENVS/<env>/.setup-<step>; a rerun skips them (delete a marker to redo it).
# NOT YET TESTED ON A REAL POD. Every block follows the tool's own README as of 2026-10-23;
# if a step fails, check that README first (repo names in pipeline/README.md).
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
cuda_toolkit() {  # nvcc + headers inside the active env (the Runpod image may not ship nvcc)
  step "cuda-$1" mamba install -y -p "$CONDA_PREFIX" -c "nvidia/label/cuda-$1" cuda-toolkit
  export CUDA_HOME="$CONDA_PREFIX"
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
  have_env world || mamba create -y -p "$ENVS/world" python=3.12 "nodejs>=22" "ffmpeg>=6"
  use world
  cuda_toolkit 12.8.0
  step torch pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu128
  clone https://github.com/nerfstudio-project/gsplat gsplat
  step gsplat pip install -e "$SRC/gsplat" --no-build-isolation
  step gsplat-examples pip install -r "$SRC/gsplat/examples/requirements.txt" --no-build-isolation
  step geo pip install open3d pycolmap opencv-python-headless scipy OpenEXR trimesh anthropic
  step memreplay pip install -e "$REPO/pipeline"
  step splat-transform npm install -g @playcanvas/splat-transform
  # quick health check, so a broken env shows up now instead of at S1/S3/S6
  ffmpeg -hide_banner -encoders | grep -q libx264 \
    || { echo "ffmpeg lacks libx264. Fix: mamba install -y -p $ENVS/world 'ffmpeg=*=gpl*'"; exit 1; }
  "$CONDA_PREFIX/bin/nvcc" --version > /dev/null
  python -c "import open3d, gsplat, anthropic, trimesh, memreplay.handoff; print('world imports OK')"
  echo "world env ready: use world && memreplay --help"
}

vipe() {  # S2: NVIDIA ViPE. Its Python packages live in its own uv venv; this conda env only holds CUDA + uv.
  need_base
  clone https://github.com/nv-tlabs/vipe vipe
  cd "$SRC/vipe"
  have_env vipe || mamba env create -f envs/cu128.yml -p "$ENVS/vipe"
  use vipe
  step uv-sync uv sync     # builds ViPE's CUDA extensions into $SRC/vipe/.venv
  echo "ViPE ready: cd $SRC/vipe && uv run vipe --help"
}

warmup() {  # download all ViPE weights now (one comes from Google Drive and can be rate-limited later)
  need_base
  local d="$WORK/_warmup"; mkdir -p "$d"
  [ -f "$d/clip.mp4" ] || "$ENVS/world/bin/ffmpeg" -loglevel error -f lavfi -i testsrc=duration=2:size=640x480:rate=30 \
    -pix_fmt yuv420p "$d/clip.mp4"
  cd "$SRC/vipe"
  use vipe
  uv run python run.py pipeline=default streams=raw_mp4_stream streams.base_path="$d/clip.mp4" streams.frame_end=10 \
    pipeline.output.path="$d/vipe" pipeline.output.save_artifacts=true \
    || echo "ViPE warmup exited with an error (expected on a test pattern if nothing could be tracked)."
  if [ -f "$d/vipe/pose/clip.npz" ]; then
    echo "ViPE warmup OK: weights downloaded and poses written"
  else
    echo "WARNING: ViPE wrote no poses. If the error above is an ImportError, CUDA or build error (not a"
    echo "tracking failure), delete $ENVS/vipe/.setup-uv-sync and rerun: bash setup.sh vipe warmup"
  fi
}

extras() {  # optional upgrades, installed into the world env: SAM 2.1 (better masks), CoTracker3 (object rotation)
  need_base
  use world
  clone https://github.com/facebookresearch/sam2 sam2
  step sam2 pip install -e "$SRC/sam2"
  [ -f "$SRC/sam2/checkpoints/sam2.1_hiera_large.pt" ] || (cd "$SRC/sam2/checkpoints" && ./download_ckpts.sh)
  step extras-pip pip install "imageio[ffmpeg]" transformers
  python -c "import torch; torch.hub.load('facebookresearch/co-tracker', 'cotracker3_offline')"
  echo "SAM 2.1 + Grounding DINO + CoTracker3 ready in the world env"
}

sam3d() {  # stretch: SAM 3D Objects. Pins Python 3.11, CUDA 12.1, torch 2.5.1; needs >= 32 GB VRAM.
  need_base
  clone https://github.com/facebookresearch/sam-3d-objects sam-3d-objects
  cd "$SRC/sam-3d-objects"
  have_env sam3d || mamba env create -f environments/default.yml -p "$ENVS/sam3d"
  use sam3d
  export PIP_EXTRA_INDEX_URL="https://pypi.ngc.nvidia.com https://download.pytorch.org/whl/cu121"
  step dev pip install -e '.[dev]'
  step p3d pip install -e '.[p3d]'        # pytorch3d needs a second step (per the repo)
  export PIP_FIND_LINKS="https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.5.1_cu121.html"
  step inference pip install -e '.[inference]'
  step hydra-patch ./patching/hydra
  step hf-cli pip install 'huggingface-hub[cli]<1.0'
  step memreplay bash -c "pip install --no-deps -e '$REPO/pipeline' && pip install 'pydantic>=2'"
  echo "SAM 3D env ready. Weights: bash setup.sh sam3d_weights (after Hugging Face approval)"
}

sam3d_weights() {  # needs approved access to facebook/sam-3d-objects and HF_TOKEN in /workspace/secrets.sh
  need_base
  cd "$SRC/sam-3d-objects"
  use sam3d
  [ -d checkpoints/hf ] && { echo "SAM 3D weights already in place"; return 0; }
  hf download --repo-type model --local-dir checkpoints/hf-download --max-workers 1 facebook/sam-3d-objects
  mv checkpoints/hf-download/checkpoints checkpoints/hf && rm -rf checkpoints/hf-download
}

TARGETS="base world vipe warmup extras sam3d sam3d_weights"
[ $# -gt 0 ] || { echo "usage: bash setup.sh <target>...   targets: $TARGETS"; exit 1; }
for target in "$@"; do
  case " $TARGETS " in *" $target "*) ;; *) echo "unknown target: $target (targets: $TARGETS)"; exit 1 ;; esac
  echo "=== setup: $target ==="
  # Subshell so cd/env changes don't leak. Note: `( f ) || ...` would silently disable set -e inside f.
  set +e; ( set -e; "$target" ); rc=$?; set -e
  [ "$rc" = 0 ] || { echo "=== setup $target FAILED (see the error above) ==="; exit 1; }
done
