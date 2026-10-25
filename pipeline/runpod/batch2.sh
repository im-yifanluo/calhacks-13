#!/usr/bin/env bash
# batch2.sh <gpu> <clip>...: on the pod, for each clip in turn (waits for <work>/input/clip.ready, written by the
# uploader): normalize, nouns, ViPE (this GPU), world, l0, objects (CPU), then append the clip to the train queue
# (/workspace/logs/train_queue) for trainq.sh. Summary lines go to /workspace/logs/static_run.log (status page).
source /workspace/memory-replay/pipeline/runpod/env.sh
GPU=$1; shift
LOG=/workspace/logs/static_run.log; Q=/workspace/logs/train_queue
say() { echo "$(date +%T) $*" | tee -a $LOG; }
step() { local w=$1 name=$2; shift 2; mkdir -p $w/logs; local t0=$SECONDS
  if "$@" > $w/logs/$name.log 2>&1; then say "$(basename $w) $name ok ($((SECONDS-t0)) s): $(grep -hE '^\[' $w/logs/$name.log | tail -1 | cut -c1-140)"; return 0
  else say "$(basename $w) $name FAILED ($((SECONDS-t0)) s)"; tail -3 $w/logs/$name.log | tee -a $LOG; return 1; fi; }
for c in "$@"; do
  W=$WORK/$c
  until [ -f $W/input/clip.ready ]; do sleep 15; done
  ( use world
    EYE=$(python3 -c "import json;print(json.load(open('$W/capture.json'))['eye_height_m'])")
    [ -f $W/input/frames.json ] || step $W normalize memreplay stage normalize --work $W --eye-height $EYE || exit 1
    [ -f $W/nouns.json ] || step $W nouns memreplay stage nouns --work $W || exit 1
    [ -f $W/vipe/pose/clip.npz ] || CUDA_VISIBLE_DEVICES=$GPU step $W vipe memreplay stage vipe --work $W || exit 1
    source /workspace/envs/lite/bin/activate
    step $W world memreplay stage world --work $W || exit 1
    step $W l0 memreplay stage l0 --work $W || exit 1
    step $W objects memreplay stage objects --work $W || exit 1
    echo $c >> $Q; say "$c queued for training" )
done
touch /workspace/logs/gpu${GPU}_free
say "batch2 gpu$GPU done: $*"
