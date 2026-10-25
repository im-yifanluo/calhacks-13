"""Test adapter for the real worker's I4/I5 functions. Never runs reconstruction."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

repo = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("connection_worker", repo / "pipeline/memreplay/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
action = sys.argv[1]
if action == "poll":
    print(json.dumps(worker.pending_jobs()))
elif action == "publish":
    memory_id = int(sys.argv[2])
    job = next(row for row in worker.pending_jobs() if int(row["id"]) == memory_id)
    source = job.get("source_url") or job.get("sourceUrl")
    assert worker._source_check().allowed_source(source, os.environ["ASSET_BASE_URL"], worker._identity_hex(job["owner"]))
    work = Path(sys.argv[3])
    work.mkdir()
    worker.download(source, work / "clip.mov", 1024)
    worker.set_status(memory_id, "processing", 0.25)
    manifest = json.loads((repo / "apps/web/public/demo/memory.json").read_text())
    manifest["title"] = "[CONNECTION TEST] Synthetic scene, not a reconstruction"
    manifest["id"] = str(memory_id)
    # A small valid ASCII point file exercises a second exported asset's bytes.
    points = b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n"
    (work / "points.ply").write_bytes(points)
    manifest["background"].update(url="points.ply", format="ply", splatCount=1)
    (work / "memory.json").write_text(json.dumps(manifest))
    key = f"{memory_id}-{job.get('request_id') or job.get('requestId')}"
    exported = worker.publish_dir(work, Path(os.environ["MEMREPLAY_PUBLISH_DIR"]) / key)
    print(json.dumps({"manifestUrl": os.environ["MEMREPLAY_PUBLIC_BASE_URL"] + "/" + key + "/memory.json",
                      "sha256": hashlib.sha256((work / "clip.mov").read_bytes()).hexdigest(),
                      "assetSha256": hashlib.sha256(points).hexdigest(), "files": len(exported)}))
elif action == "ready":
    worker.set_status(int(sys.argv[2]), "ready", 1, sys.argv[3])
    print("ready")
else:
    raise ValueError("Unknown test action")
