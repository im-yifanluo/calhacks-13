#!/usr/bin/env bash
# rescore.sh <clip>...: pull a scene's viewer files from the pod and score it (same steps as autopull.sh, on demand)
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO" || exit 1
source .venv/bin/activate
SSH="ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/memreplay_runpod -p 31390"
POD="root@38.80.152.148"
for c in "$@"; do
  while pgrep -f "tools/evalclip.py" > /dev/null; do sleep 5; done       # one headless browser at a time
  D="apps/web/public/memories/$c"; mkdir -p "$D" "data/work/$c/input"
  rsync -az --no-owner --no-group -e "$SSH" \
    --include='memory.json' --include='memory.static.json' --include='colmap_names.txt' \
    --include='world/' --include='world/bg_room.spz' --include='world/bg_static.spz' --include='world/room_collider.glb' \
    --include='world/cameras.json' --include='world/world.json' --include='world/ghosts.json' --include='world/exposure.json' --include='world/ghosts/' --include='world/ghosts/*' \
    --include='objects/' --include='objects/*.spz' --include='objects/*.json' --include='input/' --include='input/audio.m4a' \
    --include='verify/' --include='verify/report.json' --exclude='*' "$POD:/workspace/work/$c/" "$D/" \
  && rsync -az -e "$SSH" "$POD:/workspace/work/$c/input/clip.mp4" "data/work/$c/input/clip.mp4" \
  && CAPTURE_URL=${CAPTURE_URL:-http://127.0.0.1:5178} python pipeline/tools/evalclip.py $c 6 2>&1 | tail -1 \
  && python3 pipeline/tools/status_update.py --log "$c re-scored: $(python3 -c "import json;d=json.load(open('$D/compare.json'));print(d.get('mean_tracked'))")" > /dev/null \
  || echo "$c FAILED"
done
