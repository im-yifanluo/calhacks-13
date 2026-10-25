#!/usr/bin/env bash
# run a command on pod A (2x H100, the pipeline pod); see podb.sh for pod B
exec ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15 -o ServerAliveInterval=30 -i "$HOME/.ssh/memreplay_runpod" -p 31390 root@38.80.152.148 "$@"
