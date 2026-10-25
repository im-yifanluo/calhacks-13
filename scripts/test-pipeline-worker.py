"""Exercise the real worker loop/HTTP/storage/status path with CPU stand-ins for GPU stages.

This is not a reconstruction or quality test. It refuses non-loopback servers.
"""
import hashlib
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from memreplay import cli, worker

assert urlsplit(os.environ["STDB_HTTP_URL"]).hostname == "127.0.0.1"
assert urlsplit(os.environ["MEMREPLAY_UPLOAD_API"]).hostname == "127.0.0.1"
mid, expected_hash = int(sys.argv[1]), sys.argv[2]
calls = []

def stage(name, work):
    assert hashlib.sha256((work / "clip.mov").read_bytes()).hexdigest() == expected_hash
    calls.append(name)
    if name == "vipe" and "--fail" in sys.argv:
        raise RuntimeError("Deliberate GPU-stage failure for integration test")

def merge(work, title, memory_id, device, static=False):
    scene = json.loads((Path(__file__).resolve().parents[1] / "apps/web/public/demo/memory.json").read_text())
    scene["title"] = "Synthetic transport fixture — no reconstruction"
    scene["id"] = memory_id
    path = work / ("memory.static.json" if static else "memory.json")
    path.write_text(json.dumps(scene))
    return path

with patch.object(cli, "run_stage", stage), patch.object(cli, "merge", merge):
    worker.loop(once=True, memory_id=mid)
assert calls == list(cli.STAGES), calls
print("PASS actual worker loop: downloads exact phone bytes, calls all pipeline stages, publishes, marks ready (GPU stages substituted)")
