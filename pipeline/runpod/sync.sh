#!/usr/bin/env bash
# copy the repo (code only) to the pod
cd "/Users/yifanluo/Hackathons/CalHacks 13" && rsync -az --no-owner --no-group \
  --exclude node_modules --exclude .claude --exclude data --exclude dist --exclude .venv \
  --exclude __pycache__ --exclude '*.egg-info' --exclude apps/web/public/memories --exclude server/spacetime/target --exclude .DS_Store \
  -e "ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/memreplay_runpod -p 31390" \
  ./ root@38.80.152.148:/workspace/memory-replay/ && echo synced
