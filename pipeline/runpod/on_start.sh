#!/usr/bin/env bash
# Run after EVERY pod start: apt packages live on the container disk, which is wiped on stop.
set -euo pipefail
APT="apt-get -o DPkg::Lock::Timeout=600 -qq"     # wait for another apt run instead of failing
$APT update
$APT install -y tmux rsync git git-lfs libgl1 libglib2.0-0 > /dev/null
echo "System packages ready. Now run: source $(cd "$(dirname "$0")" && pwd)/env.sh"
