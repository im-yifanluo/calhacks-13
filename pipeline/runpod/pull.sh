#!/usr/bin/env bash
# pull.sh <clip id> ...: copy a finished scene's viewer files from the pod into apps/web/public/memories/<id>/
set -e
for c in "$@"; do
  D="/Users/yifanluo/Hackathons/CalHacks 13/apps/web/public/memories/$c"
  mkdir -p "$D"
  rsync -az --no-owner --no-group -e "ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/memreplay_runpod -p 31390" \
    --include='memory.json' --include='memory.static.json' --include='colmap_names.txt' \
    --include='world/' --include='world/bg_room.spz' --include='world/bg_static.spz' --include='world/room_collider.glb' \
    --include='world/cameras.json' --include='world/cameras.vipe.json' --include='world/world.json' --include='world/ghosts.json' --include='world/pose_refine.json' --include='world/exposure.json' \
    --include='objects/' --include='objects/*.spz' --include='objects/*.json' --include='people/' --include='people/*' \
    --include='input/' --include='input/audio.m4a' --include='verify/' --include='verify/report.json' \
    --exclude='*' \
    "root@38.80.152.148:/workspace/work/$c/" "$D/"
  echo "$c pulled: $(du -sh "$D" | cut -f1)"
done
