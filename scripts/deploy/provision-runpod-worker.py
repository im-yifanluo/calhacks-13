#!/usr/bin/env python3
"""Provision the approved worker with an in-container deadline and a local stop watchdog.

Run under caffeinate on macOS. Keep this process alive for the initial session.
Credentials are read by runpodctl, never copied into the pod or printed here.
"""

import base64
import json
import os
import shlex
import signal
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "data/runpod-account"
CLI = ROOT / "data/runpod-tools/bin/runpodctl"
PLAN = json.loads((STATE / "deployment-plan.json").read_text())
DEADLINE = int(time.time()) + 3 * 60 * 60
POD_ID = None
STOPPING = False


def cli(*args):
    result = subprocess.run([str(CLI), *args], capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "RunPod command failed")
    return json.loads(result.stdout)


def record(name, value):
    path = STATE / name
    temporary = path.with_suffix(path.suffix + ".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(value, f, indent=2)
        f.write("\n")
    temporary.replace(path)


def stop():
    global STOPPING
    STOPPING = True
    if not POD_ID:
        return
    # Retry transient network failures. Never create a replacement pod.
    while True:
        try:
            current = cli("pod", "get", POD_ID)
            status = current.get("desiredStatus", current.get("status"))
            if status in ("EXITED", "TERMINATED"):
                record("deadline-result.json", {"podId": POD_ID, "status": status, "verifiedAt": time.time()})
                print(f"Verified pod {POD_ID} stopped; network volume retained.", flush=True)
                return
            cli("pod", "stop", POD_ID)
        except Exception as error:
            print(f"Stop watchdog retry: {type(error).__name__}", flush=True)
        time.sleep(5)


def interrupted(_signum, _frame):
    if not STOPPING:
        stop()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

# This runs before /start.sh and survives SSH disconnects. RunPod supplies its
# pod-scoped runpodctl credential; the account-management key stays on the Mac.
deadline_source = base64.b64encode((ROOT / "scripts/deploy/runpod-deadline.py").read_bytes()).decode()
guard = """set -eu
mkdir -p /workspace/memos-ops
printf '%s' REPLACE_DEADLINE_SOURCE | base64 -d > /workspace/memos-ops/deadline.py
python3 -u /workspace/memos-ops/deadline.py > /workspace/memos-ops/deadline.log 2>&1 &
echo "$!" > /workspace/memos-ops/deadline.pid
exec /start.sh""".replace("REPLACE_DEADLINE_SOURCE", shlex.quote(deadline_source))

if (STATE / "pod-active.json").exists():
    raise SystemExit("Refusing to create another pod: inspect the existing pod-active.json first.")
assert PLAN["gpu"]["id"] == "NVIDIA H100 PCIe" and PLAN["gpu"]["count"] == 1
assert PLAN["containerDiskGB"] == 50 and PLAN["networkVolumeGB"] == 100
assert PLAN["dataCenter"] == "US-KS-2"
volume_id = PLAN["networkVolumeId"]
record("deadline.json", {"deadlineUnix": DEADLINE, "hours": 3, "status": "creating"})
pod = cli(
    "pod",
    "create",
    "--name",
    "memos-reconstruction",
    "--image",
    PLAN["image"],
    "--gpu-id",
    PLAN["gpu"]["id"],
    "--gpu-count",
    "1",
    "--cloud-type",
    "SECURE",
    "--data-center-ids",
    PLAN["dataCenter"],
    "--min-cuda-version",
    "12.8",
    "--container-disk-in-gb",
    "50",
    "--network-volume-id",
    volume_id,
    "--volume-mount-path",
    "/workspace",
    "--ports",
    "22/tcp",
    "--ssh",
    "--env",
    json.dumps({"TORCH_CUDA_ARCH_LIST": "9.0", "MEMREPLAY_STOP_AT": str(DEADLINE)}),
    "--docker-args",
    shlex.join(["bash", "-lc", guard]),
)
POD_ID = pod["id"]
record("pod-active.json", {"id": POD_ID, "networkVolumeId": volume_id, "deadlineUnix": DEADLINE})
print(
    json.dumps(
        {
            "podId": POD_ID,
            "networkVolumeId": volume_id,
            "deadlineUnix": DEADLINE,
            "containerDeadline": True,
            "localWatchdogPid": os.getpid(),
        }
    ),
    flush=True,
)
try:
    while time.time() < DEADLINE:
        time.sleep(min(5, max(0, DEADLINE - time.time())))
finally:
    stop()
