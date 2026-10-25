#!/usr/bin/env bash
# run a command on pod B (2x H200, same /workspace volume)
exec ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=15 -o ServerAliveInterval=30 -i "$HOME/.ssh/memreplay_runpod" -p 32888 root@38.80.152.148 "$@"
