#!/usr/bin/env bash
# post2.sh <label> <clip>...: re-export each clip's trained room at the mean appearance (bake), then props, both
# memory files, verify. No training. CPU only, so it runs beside the GPU jobs.
source /workspace/memory-replay/pipeline/runpod/env.sh; use world
cd /workspace/work
POST=/workspace/logs/post_run.log
LABEL=$1; shift
for c in "$@"; do
  W=$WORK/$c
  memreplay stage bake --work $W > $W/logs/bake.log 2>&1 || { echo "$c bake FAILED" >> $POST; tail -3 $W/logs/bake.log >> $POST; continue; }
  grep "\[bake\]" $W/logs/bake.log | cut -c1-200 >> $POST
  memreplay stage layers --work $W > $W/logs/layers.log 2>&1 || { echo "$c layers FAILED" >> $POST; tail -3 $W/logs/layers.log >> $POST; }
  memreplay merge $W --title "$(cat $W/title.txt)" --device "$(cat $W/device.txt)" > $W/logs/merge.log 2>&1
  memreplay merge $W --static --title "$(cat $W/title.txt)" --device "$(cat $W/device.txt)" > $W/logs/merge_static.log 2>&1
  memreplay verify $W > $W/logs/verify.log 2>&1 || echo "$c verify FAILED" >> $POST
  echo "$c $(grep -h '^\[layers\]' $W/logs/layers.log | cut -c1-300)" >> $POST
  echo "$(date +%T) $c READY ($LABEL)" >> $POST
done
