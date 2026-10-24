# Source this in every shell on the pod:  source /workspace/memory-replay/pipeline/runpod/env.sh
# Everything lives on the network volume (/workspace) so it survives pod stops and redeploys.
export WS=/workspace
export REPO=$WS/memory-replay            # this repo, cloned or rsynced here
export SRC=$WS/src                       # third-party repos (vipe, sam3, sam2, sam-3d-objects, gsplat)
export ENVS=$WS/envs                     # conda envs: core, vipe, world, seg, obj
export WORK=$WS/work                     # one folder per memory: $WORK/<memory-id>
export HF_HOME=$WS/cache/hf              # Hugging Face weights
export TORCH_HOME=$WS/cache/torch        # torch.hub weights (CoTracker3, ViPE's SAM/DeAOT)
export PIP_CACHE_DIR=$WS/cache/pip
export UV_CACHE_DIR=$WS/cache/uv
export UV_PYTHON_INSTALL_DIR=$WS/cache/uv-python   # uv-managed Pythons must survive stops too
export TORCH_CUDA_ARCH_LIST="8.0;8.9;9.0"   # build CUDA code for A100, L40S and H100 (envs are shared on the volume)
[ -f "$WS/secrets.sh" ] && source "$WS/secrets.sh"   # HF_TOKEN, ANTHROPIC_API_KEY (never commit)

if [ -f "$WS/miniforge3/etc/profile.d/conda.sh" ]; then
  source "$WS/miniforge3/etc/profile.d/conda.sh"
fi

# use <env>: activate one of our envs and point CUDA builds at its own nvcc.
use() {
  local had_u=0; [[ $- == *u* ]] && had_u=1 && set +u   # conda's activate scripts break under set -u
  conda activate "$ENVS/$1"
  [ "$had_u" = 1 ] && set -u
  export CUDA_HOME="$CONDA_PREFIX"
}
