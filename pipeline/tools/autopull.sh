#!/usr/bin/env bash
# autopull.sh <expected count>: poll the pod; when a clip is "READY (run)" in post_run.log, pull its viewer files, its
# normalized clip (for scoring) and score it from the recorded camera (evalclip.py). Logs each score to the status page.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
source .venv/bin/activate
N=${1:-9}
SSH="ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/memreplay_runpod -p 31390"
POD="root@38.80.152.148"
done_list=" "; n=0
while [ $n -lt $N ]; do
  post=$($SSH $POD 'cat /workspace/logs/post_run.log' 2>/dev/null)
  for c in $(echo "$post" | grep -oE "^[0-9:]+ (\S+) READY" | awk '{print $2}' | sort -u); do
    case "$done_list" in *" $c "*) continue;; esac
    echo "$(date +%T) $c ready -> pull + score"
    D="apps/web/public/memories/$c"; mkdir -p "$D" "data/work/$c/input"
    rsync -az --no-owner --no-group -e "$SSH" \
      --include='memory.json' --include='memory.static.json' --include='colmap_names.txt' \
      --include='world/' --include='world/bg_room.spz' --include='world/bg_static.spz' --include='world/room_collider.glb' \
      --include='world/cameras.json' --include='world/world.json' --include='world/ghosts.json' --include='world/exposure.json' --include='world/ghosts/' --include='world/ghosts/*' \
      --include='objects/' --include='objects/*.spz' --include='objects/*.json' --include='people/' --include='people/*' \
      --include='input/' --include='input/audio.m4a' --include='verify/' --include='verify/report.json' --exclude='*' \
      "$POD:/workspace/work/$c/" "$D/" \
    && rsync -az -e "$SSH" "$POD:/workspace/work/$c/input/clip.mp4" "data/work/$c/input/clip.mp4" \
    && CAPTURE_URL=${CAPTURE_URL:-http://127.0.0.1:5177} python pipeline/tools/evalclip.py $c 6 2>&1 | tail -1 \
    && m=$(python3 -c "import json;d=json.load(open('$D/compare.json'));print(d.get('mean_tracked'))" 2>/dev/null) \
    && python3 pipeline/tools/status_update.py --log "$c pulled and scored (tracked rows): $m" > /dev/null \
    || echo "$(date +%T) $c pull/score FAILED"
    done_list="$done_list$c "; n=$((n+1))
  done
  echo "$post" | grep -q "TRAIN QUEUE DONE" && [ $n -ge $(echo "$post" | grep -c "READY") ] && break
  sleep 60
done
echo "$(date +%T) autopull done:$done_list"
