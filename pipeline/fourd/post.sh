#!/usr/bin/env bash
# usage: post.sh <model dir> <config> <data dir> <work dir> <out dir> <gpu> [extra post.py args]
set -e
source /workspace/memory-replay/pipeline/runpod/env.sh   # NB: exports WORK, so read our args after it
use world
source /workspace/envs/4dgs/bin/activate
MODEL=$1; CFGF=$2; DATA=$3; WDIR=$4; OUT=$5; export CUDA_VISIBLE_DEVICES=$6; shift 6
cd /workspace/4dgs/A/4DGaussians
python /workspace/4dgs/A/post.py -m $MODEL --configs $CFGF --data $DATA --work $WDIR --out $OUT "$@"
