#!/usr/bin/env bash
# One-time setup of the pipeline environments on a Runpod pod with a network volume at /workspace.
#   bash setup.sh base          # ONE person, first: Miniforge + core env
#   bash setup.sh vipe world    # P1, after base
#   bash setup.sh seg obj       # P2, after base (in parallel with P1, separate tmux session)
#   bash setup.sh obj_weights   # P2, once Hugging Face approved facebook/sam-3d-objects
# Finished steps leave a marker in $ENVS/<env>/.setup-<step>; a rerun skips them (delete a marker to redo it).
# NOT YET TESTED ON A REAL POD. Every block follows the tool's own README as of 2026-10-23;
# if a step fails, check that README first (pipeline/README.md, section 3 has the repo names).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v tmux >/dev/null && command -v rsync >/dev/null || bash "$HERE/on_start.sh"
source "$HERE/env.sh"
mkdir -p "$SRC" "$ENVS" "$WORK" "$HF_HOME" "$TORCH_HOME"

clone()     { [ -d "$SRC/$2" ] || git clone --recursive "$1" "$SRC/$2"; }
have_env()  { [ -d "$ENVS/$1/conda-meta" ]; }
mamba()     { "$WS/miniforge3/bin/mamba" "$@"; }   # call Miniforge's binary directly (not on PATH inside envs)
need_base() { [ -x "$WS/miniforge3/bin/mamba" ] || { echo "Run 'bash setup.sh base' first."; exit 1; }; }
step() {    # step <name> <command...>: run once per env, then skip on reruns
  local marker="$CONDA_PREFIX/.setup-$1"; shift
  [ -f "$marker" ] && { echo "  (skip: already done)"; return 0; }
  "$@" && touch "$marker"
}
cuda_toolkit() {  # nvcc + headers inside the active env (the Runpod image may not ship nvcc)
  step "cuda-$1" mamba install -y -c "nvidia/label/cuda-$1" cuda-toolkit
  export CUDA_HOME="$CONDA_PREFIX"
}
our_package() {   # our memreplay package without pulling its deps (keeps each env's numpy/opencv pins intact)
  step memreplay pip install --no-deps -e "$REPO/pipeline"
  step memreplay-deps pip install "pydantic>=2" trimesh "$@"
}

base() {
  if [ ! -x "$WS/miniforge3/bin/conda" ]; then
    curl -fsSL -o /tmp/miniforge.sh \
      https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
    bash /tmp/miniforge.sh -b -p "$WS/miniforge3"
  fi
  source "$WS/miniforge3/etc/profile.d/conda.sh"
  have_env core || mamba create -y -p "$ENVS/core" python=3.12
  use core
  step core-pip pip install -e "$REPO/pipeline" anthropic "huggingface-hub[cli]"
}

vipe() {  # P1 · S3. ViPE keeps its Python deps in its own uv venv; this env only holds CUDA + uv.
  need_base
  clone https://github.com/nv-tlabs/vipe vipe
  cd "$SRC/vipe"
  have_env vipe || mamba env create -f envs/cu128.yml -p "$ENVS/vipe"
  use vipe
  step uv-sync uv sync     # builds ViPE's CUDA extensions into $SRC/vipe/.venv
  echo "ViPE ready: cd $SRC/vipe && uv run vipe --help"
}

world() {  # P1 · S0, S4, S5, S6: ffmpeg >= 6, gsplat (main branch, masked loss), open3d, splat-transform
  need_base
  have_env world || mamba create -y -p "$ENVS/world" python=3.12 "nodejs>=22" "ffmpeg>=6"
  use world
  cuda_toolkit 12.8.0
  step torch pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu128
  clone https://github.com/nerfstudio-project/gsplat gsplat
  step gsplat pip install -e "$SRC/gsplat" --no-build-isolation
  step gsplat-examples pip install -r "$SRC/gsplat/examples/requirements.txt" --no-build-isolation
  step geo pip install open3d pycolmap opencv-python-headless scipy OpenEXR
  our_package
  step splat-transform npm install -g @playcanvas/splat-transform
}

seg() {  # P2 · S2, S8: SAM 3.1 (gated), SAM 2.1 fallback, Grounding DINO, CoTracker3
  need_base
  have_env seg || mamba create -y -p "$ENVS/seg" python=3.12
  use seg
  cuda_toolkit 12.8.0
  step torch pip install torch==2.10.0 torchvision --index-url https://download.pytorch.org/whl/cu128
  clone https://github.com/facebookresearch/sam3 sam3
  step sam3 bash -c "pip install -e '$SRC/sam3' && pip install -e '$SRC/sam3[notebooks]'"
  step fa3 bash -c "pip install einops ninja && pip install flash-attn-3 --no-deps --index-url https://download.pytorch.org/whl/cu128"
  step cc-torch pip install git+https://github.com/ronghanghu/cc_torch.git
  clone https://github.com/facebookresearch/sam2 sam2
  step sam2 pip install -e "$SRC/sam2"
  [ -f "$SRC/sam2/checkpoints/sam2.1_hiera_large.pt" ] || (cd "$SRC/sam2/checkpoints" && ./download_ckpts.sh)
  step extras pip install pycocotools "imageio[ffmpeg]" transformers scipy   # opencv comes from sam3[notebooks]
  our_package "numpy<2"                                                       # sam3 pins numpy < 2
  python -c "import torch; torch.hub.load('facebookresearch/co-tracker', 'cotracker3_offline')"
  echo "CoTracker3 weights cached"
  python -c "import numpy, cv2; print('numpy', numpy.__version__, 'opencv', cv2.__version__)"
}

obj() {  # P2 · S7: SAM 3D Objects. Pins Python 3.11, CUDA 12.1, torch 2.5.1; needs >= 32 GB VRAM.
  need_base
  clone https://github.com/facebookresearch/sam-3d-objects sam-3d-objects
  cd "$SRC/sam-3d-objects"
  have_env obj || mamba env create -f environments/default.yml -p "$ENVS/obj"
  use obj
  export PIP_EXTRA_INDEX_URL="https://pypi.ngc.nvidia.com https://download.pytorch.org/whl/cu121"
  step dev pip install -e '.[dev]'
  step p3d pip install -e '.[p3d]'        # pytorch3d needs a second step (per the repo)
  export PIP_FIND_LINKS="https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.5.1_cu121.html"
  step inference pip install -e '.[inference]'
  step hydra-patch ./patching/hydra
  step hf-cli pip install 'huggingface-hub[cli]<1.0'
  our_package
  echo "SAM 3D env ready. Weights: bash setup.sh obj_weights (after HF approval)"
}

obj_weights() {  # needs approved access to facebook/sam-3d-objects and HF_TOKEN in /workspace/secrets.sh
  need_base
  cd "$SRC/sam-3d-objects"
  use obj
  [ -d checkpoints/hf ] && { echo "SAM 3D weights already in place"; return 0; }
  hf download --repo-type model --local-dir checkpoints/hf-download --max-workers 1 facebook/sam-3d-objects
  mv checkpoints/hf-download/checkpoints checkpoints/hf && rm -rf checkpoints/hf-download
}

[ $# -gt 0 ] || { echo "usage: bash setup.sh base|vipe|world|seg|obj|obj_weights ..."; exit 1; }
for target in "$@"; do
  case "$target" in base|vipe|world|seg|obj|obj_weights) ;; *) echo "unknown target: $target"; exit 1 ;; esac
  echo "=== setup: $target ==="
  ( "$target" ) || { echo "=== setup $target FAILED (see the error above) ==="; exit 1; }   # subshell: no cd/env leaks
done
