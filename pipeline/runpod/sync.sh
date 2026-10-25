#!/usr/bin/env bash
# Copy source only to this account's configured pod. Credentials travel separately.
set -euo pipefail
source "$(dirname "$0")/remote.sh"
rsync -az --no-owner --no-group \
  --exclude node_modules --exclude .git --exclude .claude --exclude .codex --exclude .agents --exclude .flash \
  --exclude data --exclude dist --exclude .venv --exclude .ssh --exclude .aws --exclude .runpod \
  --exclude '.env*' --exclude secrets.sh --exclude '*.pem' --exclude '*.key' --exclude '*.p8' --exclude '*.p12' \
  --exclude '*.mp4' --exclude '*.mov' --exclude '*.ply' --exclude '*.spz' --exclude '*.glb' \
  --exclude __pycache__ --exclude '*.egg-info' --exclude apps/web/public/memories \
  --exclude apps/ios/DerivedData --exclude server/spacetime/target --exclude .DS_Store --exclude NIKKO_BUILD_LOG.md \
  -e "$MEMREPLAY_RSYNC_SSH" "$MEMREPLAY_LOCAL_REPO/" "root@$MEMREPLAY_SSH_HOST:$MEMREPLAY_REMOTE_REPO/"
echo synced
