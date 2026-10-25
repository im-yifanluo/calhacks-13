#!/usr/bin/env bash
# Shared local SSH configuration. Source this from the laptop-side helpers.
MEMREPLAY_LOCAL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEMREPLAY_SSH_CONFIG="${MEMREPLAY_SSH_CONFIG:-$MEMREPLAY_LOCAL_REPO/data/runpod-account/ssh.env}"
if [[ -f "$MEMREPLAY_SSH_CONFIG" ]]; then source "$MEMREPLAY_SSH_CONFIG"; fi
: "${MEMREPLAY_SSH_HOST:?Configure your own pod in data/runpod-account/ssh.env; see pipeline/runpod/ssh.env.example}"
: "${MEMREPLAY_SSH_PORT:?Set the current direct SSH port from RunPod}"
: "${MEMREPLAY_SSH_KEY:?Set the absolute path to your private SSH key}"
[[ "$MEMREPLAY_SSH_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || { echo 'Invalid SSH host' >&2; exit 1; }
[[ "$MEMREPLAY_SSH_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$MEMREPLAY_SSH_PORT >= 1 && 10#$MEMREPLAY_SSH_PORT <= 65535 )) || { echo 'Invalid SSH port' >&2; exit 1; }
[[ "$MEMREPLAY_SSH_KEY" = /* && -f "$MEMREPLAY_SSH_KEY" ]] || { echo 'SSH private key is missing; use an absolute path' >&2; exit 1; }
MEMREPLAY_REMOTE_REPO="${MEMREPLAY_REMOTE_REPO:-/workspace/memory-replay}"
MEMREPLAY_REMOTE_WORK="${MEMREPLAY_REMOTE_WORK:-/workspace/work}"
for path in "$MEMREPLAY_REMOTE_REPO" "$MEMREPLAY_REMOTE_WORK"; do
  [[ "$path" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Remote paths must be absolute and contain no shell metacharacters' >&2; exit 1; }
done
mkdir -p "$MEMREPLAY_LOCAL_REPO/data/runpod-account"
MEMREPLAY_SSH_ARGS=(-o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new
  -o "UserKnownHostsFile=$MEMREPLAY_LOCAL_REPO/data/runpod-account/known_hosts"
  -o ConnectTimeout=15 -o ServerAliveInterval=30 -i "$MEMREPLAY_SSH_KEY" -p "$MEMREPLAY_SSH_PORT")
printf -v MEMREPLAY_RSYNC_SSH '%q ' ssh "${MEMREPLAY_SSH_ARGS[@]}"
