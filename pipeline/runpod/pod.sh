#!/usr/bin/env bash
# Run a command on the pod explicitly configured for this checkout/account.
set -euo pipefail
source "$(dirname "$0")/remote.sh"
exec ssh "${MEMREPLAY_SSH_ARGS[@]}" "root@$MEMREPLAY_SSH_HOST" "$@"
