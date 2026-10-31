#!/usr/bin/env bash
# usage: train.sh <clip> <run-name> <config.py> <gpu> [extra train.py args, e.g. --save_iterations 9000 18000]
# data: /workspace/4dgs/A/data/<clip> (convert.py), model: /workspace/4dgs/A/runs/<clip>/<run-name>
set -e
CLIP=$1; RUN=$2; CFG=$3; GPU=$4; shift 4
source /workspace/memory-replay/pipeline/runpod/env.sh
use world
source /workspace/envs/4dgs/bin/activate
export CUDA_VISIBLE_DEVICES=$GPU
cd /workspace/4dgs/A/4DGaussians
log() { echo "$(date -u +%FT%TZ) [4dgs] $*" >> /workspace/logs/4dgs.log; }
log "train $CLIP/$RUN start on $(hostname) GPU $GPU cfg $CFG"
T0=$(date +%s)
python train.py -s /workspace/4dgs/A/data/$CLIP -m /workspace/4dgs/A/runs/$CLIP/$RUN --configs $CFG \
  --port $((6100 + GPU * 500 + RANDOM % 400)) --expname $CLIP/$RUN --test_iterations 3000 7000 14000 \
  --save_iterations 7000 14000 "$@"
log "train $CLIP/$RUN done in $(( $(date +%s) - T0 )) s"
