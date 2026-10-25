#!/usr/bin/env bash
# pull.sh <clip id> ...: copy a finished scene's viewer files from the pod into apps/web/public/memories/<id>/
set -euo pipefail
source "$(dirname "$0")/remote.sh"
[[ $# -gt 0 ]] || { echo 'Usage: bash pipeline/runpod/pull.sh CLIP_ID [...]' >&2; exit 1; }
for c in "$@"; do
  [[ "$c" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Invalid clip ID' >&2; exit 1; }
  D="$MEMREPLAY_LOCAL_REPO/apps/web/public/memories/$c"
  mkdir -p "$D"
  rsync -az --no-owner --no-group -e "$MEMREPLAY_RSYNC_SSH" \
    --include='memory.json' --include='memory.static.json' --include='colmap_names.txt' \
    --include='world/' --include='world/bg_room.spz' --include='world/bg_static.spz' --include='world/room_collider.glb' \
    --include='world/cameras.json' --include='world/cameras.vipe.json' --include='world/world.json' --include='world/ghosts.json' --include='world/pose_refine.json' --include='world/exposure.json' \
    --include='objects/' --include='objects/*.spz' --include='objects/*.json' --include='people/' --include='people/*' \
    --include='input/' --include='input/audio.m4a' --include='verify/' --include='verify/report.json' \
    --exclude='*' \
    "root@$MEMREPLAY_SSH_HOST:$MEMREPLAY_REMOTE_WORK/$c/" "$D/"
  echo "$c pulled: $(du -sh "$D" | cut -f1)"
done
