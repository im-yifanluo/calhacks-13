#!/usr/bin/env bash
# Pass 5: every room retrained with this morning's known-good trainer config (--app_opt back on: without it the
# MCMC training diverged and 85 % of the Gaussians died), from ViPE's own cameras; then pose export, props, both
# memory files, verify. Two rooms at a time. Logs where the status page looks.
source /workspace/memory-replay/pipeline/runpod/env.sh
cd /workspace/work
LOG=/workspace/logs/static_run.log; POST=/workspace/logs/post_run.log
: > $LOG; : > $POST
say() { echo "$(date +%T) $*" | tee -a $LOG; }
for c in img8014 img8017; do cp $c/world/cameras.vipe.json $c/world/cameras.json; done
say "PASS 5: all rooms, app_opt restored"
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
    echo "$(date +%T) $c READY" >> $POST )
}
( for c in img8014 img8013 img8016; do train_one $c 0; done ) &
( for c in img8015 img8017; do train_one $c 1; done ) &
wait
say "STATIC DONE"
echo "POST DONE" >> $POST
