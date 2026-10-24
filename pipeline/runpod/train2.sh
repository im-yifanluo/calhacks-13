#!/usr/bin/env bash
# train2.sh <label> <clip for GPU0> [clip for GPU1]: wait until no splat training runs, then retrain the given
# rooms with the current code (one per GPU), pose export, props, both memory files, verify. Appends to the
# status-page logs; READY lines carry the label.
source /workspace/memory-replay/pipeline/runpod/env.sh
cd /workspace/work
LOG=/workspace/logs/static_run.log; POST=/workspace/logs/post_run.log
LABEL=$1; A=$2; B=$3
say() { echo "$(date +%T) $*" | tee -a $LOG; }
while pgrep -f "[t]rain_splat" > /dev/null; do sleep 15; done
sed -i '/^POST DONE$/d' $POST
say "$LABEL: $A $B"
train_one() {
  local c=$1 gpu=$2 W=$WORK/$1 t0=$SECONDS
  ( use world
    CUDA_VISIBLE_DEVICES=$gpu memreplay stage background --static --work $W > $W/logs/background_static.log 2>&1 ) \
    || { say "$c static splat FAILED"; tail -3 $W/logs/background_static.log | tee -a $LOG; return 1; }
  psnr=$( source /workspace/envs/lite/bin/activate; python - "$W" <<'PY' 2>/dev/null
import glob, json, sys
f = sorted(glob.glob(sys.argv[1] + "/gsplat_static/stats/val_step*.json"))
d = json.load(open(f[-1])) if f else {}
print(round(d.get("psnr", 0), 2), round(d.get("ssim", 0), 3), round(d.get("lpips", 0), 3))
PY
)
  say "$c static ok ($((SECONDS-t0)) s) psnr/ssim/lpips $psnr $(grep -h "\[background\]" $W/logs/background_static.log | tail -1 | cut -c1-200)"
  ( use world
    memreplay stage refine --work $W > $W/logs/refine.log 2>&1; grep "\[refine\]" $W/logs/refine.log | cut -c1-300 >> $POST
    memreplay stage layers --work $W > $W/logs/layers.log 2>&1 || { echo "$c layers FAILED" >> $POST; tail -3 $W/logs/layers.log >> $POST; }
    memreplay merge $W --title "$(cat $W/title.txt)" --device "$(cat $W/device.txt)" > $W/logs/merge.log 2>&1
    memreplay merge $W --static --title "$(cat $W/title.txt)" --device "$(cat $W/device.txt)" > $W/logs/merge_static.log 2>&1
    memreplay verify $W > $W/logs/verify.log 2>&1 || echo "$c verify FAILED" >> $POST
    echo "$c $(grep -h '^\[layers\]' $W/logs/layers.log | cut -c1-300)" >> $POST
    echo "$(date +%T) $c READY ($LABEL)" >> $POST )
}
train_one $A 0 &
[ -n "$B" ] && train_one $B 1 &
wait
say "$LABEL DONE"
echo "POST DONE" >> $POST
