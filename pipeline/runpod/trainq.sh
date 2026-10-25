#!/usr/bin/env bash
# trainq.sh <gpu> <expected count>: train each clip that batch2.sh appends to /workspace/logs/train_queue, on one GPU:
# static room (depth-supervised, baked), pose export, props, both memory files, verify -> "READY (run)" in post_run.log
source /workspace/memory-replay/pipeline/runpod/env.sh
GPU=$1; N=$2
LOG=/workspace/logs/static_run.log; POST=/workspace/logs/post_run.log; Q=/workspace/logs/train_queue
say() { echo "$(date +%T) $*" | tee -a $LOG; }
done_list=" "; n=0
while [ $n -lt $N ]; do
  c=""; for x in $(cat $Q 2>/dev/null); do case "$done_list" in *" $x "*) ;; *) c=$x; break;; esac; done
  if [ -z "$c" ]; then sleep 20; continue; fi
  W=$WORK/$c; t0=$SECONDS
  # colours first: the HLG->SDR curve was refitted after these clips were normalized, so re-encode the frames
  # (ViPE's geometry is unaffected) and rebuild the room points + ghosts, whose colours come from the frames
  ( use world; EYE=$(python3 -c "import json;print(json.load(open('$W/capture.json'))['eye_height_m'])")
    memreplay stage normalize --work $W --eye-height $EYE > $W/logs/normalize2.log 2>&1 && say "$c re-normalized (colour fix)" || say "$c re-normalize FAILED"
    source /workspace/envs/lite/bin/activate; memreplay stage l0 --work $W > $W/logs/l0.log 2>&1 && say "$c l0 ok: $(grep -h '^\[l0\] ghosts' $W/logs/l0.log)" || say "$c l0 FAILED" )
  ( use world; CUDA_VISIBLE_DEVICES=$GPU memreplay stage background --static --work $W > $W/logs/background_static.log 2>&1 ) \
    && say "$c static ok ($((SECONDS-t0)) s) $(grep -h '\[bake\]' $W/logs/background_static.log | tail -1 | cut -c1-160)" \
    || { say "$c static splat FAILED"; tail -3 $W/logs/background_static.log | tee -a $LOG; }
  ( use world
    memreplay stage refine --work $W > $W/logs/refine.log 2>&1
    memreplay stage layers --work $W > $W/logs/layers.log 2>&1 || { echo "$c layers FAILED" >> $POST; tail -3 $W/logs/layers.log >> $POST; }
    memreplay merge $W --title "$(cat $W/title.txt)" --device "$(cat $W/device.txt)" > $W/logs/merge.log 2>&1
    memreplay merge $W --static --title "$(cat $W/title.txt)" --device "$(cat $W/device.txt)" > $W/logs/merge_static.log 2>&1
    memreplay verify $W > $W/logs/verify.log 2>&1 || echo "$c verify FAILED" >> $POST
    echo "$c $(grep -h '^\[layers\]' $W/logs/layers.log | cut -c1-300)" >> $POST
    echo "$(date +%T) $c READY (run)" >> $POST )
  done_list="$done_list$c "; n=$((n+1))
done
say "TRAIN QUEUE DONE ($n clips)"
