#!/usr/bin/env bash
# Process several memories on the pod with the GPU kept busy:
#   queue 1: nouns + ViPE for each clip, back to back (shortest first)
#   queue 2: as soon as a clip's ViPE output exists: world, l0, objects, merge, verify, background splat, merge, verify
# Usage (pod, from anywhere):  bash batch.sh <work dir>...      e.g. bash batch.sh $WORK/img8014 $WORK/img8013
# Titles come from <work>/title.txt and the device from <work>/device.txt when present.
# Logs: <work>/logs/<step>.log ; summary lines go to stdout.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
use world
DIRS=("$@")
[ ${#DIRS[@]} -gt 0 ] || { echo "usage: bash batch.sh <work dir>..."; exit 1; }

stamp() { date +%H:%M:%S; }
step() {   # step <work> <name> <cmd...>: run with a log, print one summary line
  local w=$1 name=$2; shift 2
  mkdir -p "$w/logs"
  local t0=$SECONDS
  if "$@" > "$w/logs/$name.log" 2>&1; then
    echo "$(stamp) $(basename "$w") $name ok ($((SECONDS - t0)) s)"
  else
    echo "$(stamp) $(basename "$w") $name FAILED ($((SECONDS - t0)) s): tail of $w/logs/$name.log"; tail -5 "$w/logs/$name.log"
    return 1
  fi
}

queue1() {
  for w in "${DIRS[@]}"; do
    [ -f "$w/nouns.json" ] || step "$w" nouns memreplay stage nouns --work "$w"
    if [ -f "$w/vipe/pose/clip.npz" ]; then echo "$(stamp) $(basename "$w") vipe already done"; continue; fi
    step "$w" vipe memreplay stage vipe --work "$w" || touch "$w/vipe.failed"
  done
}

queue2() {
  for w in "${DIRS[@]}"; do
    while [ ! -f "$w/vipe/pose/clip.npz" ] && [ ! -f "$w/vipe.failed" ]; do sleep 10; done
    [ -f "$w/vipe.failed" ] && { echo "$(stamp) $(basename "$w") skipped (ViPE failed)"; continue; }
    local title device
    title=$(cat "$w/title.txt" 2>/dev/null || basename "$w")
    device=$(cat "$w/device.txt" 2>/dev/null || echo "ray-ban-meta-gen2")
    step "$w" world memreplay stage world --work "$w" || continue
    step "$w" l0 memreplay stage l0 --work "$w" || continue
    step "$w" objects memreplay stage objects --work "$w" || continue
    step "$w" merge memreplay merge "$w" --title "$title" --device "$device" || continue
    step "$w" verify memreplay verify "$w"
    step "$w" background memreplay stage background --work "$w" && \
      step "$w" merge2 memreplay merge "$w" --title "$title" --device "$device" && \
      step "$w" verify2 memreplay verify "$w"
  done
}

echo "$(stamp) batch: ${DIRS[*]}"
queue1 & q1=$!
queue2 & q2=$!
wait $q1 $q2
echo "$(stamp) batch done"
