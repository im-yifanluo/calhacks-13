"""Pipeline worker and publishing (docs/INTEGRATION.md §4, jerry's docs/P4.md "P1/P2 worker contract").

  memreplay publish <work> --to <dir>       copy the files the viewer loads into <dir> (e.g. apps/web/public/memories/<id>)
  memreplay publish <work> --to s3          upload them to the S3/R2 bucket from the upload service's env
  memreplay worker [--once]                 poll SpacetimeDB for uploaded memories, run S1-S7, publish, mark ready

Worker env (same names as server/upload/.env.example): STDB_HTTP_URL, STDB_DATABASE, PIPELINE_TOKEN,
PIPELINE_IDENTITY, and for publishing S3_ENDPOINT, S3_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
ASSET_BASE_URL (public base URL of the bucket). MEMREPLAY_WORK (default $WORK or ./work) holds the work dirs.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import traceback
import urllib.request
from pathlib import Path

VIEWER_FILES = ["memory.json", "input/audio.m4a", "world/bg.spz", "world/bg_points.ply", "world/room_collider.glb"]
PROGRESS = {"normalize": 0.15, "nouns": 0.2, "vipe": 0.55, "world": 0.6, "l0": 0.7, "objects": 0.8, "background": 0.95}


def viewer_files(work: Path) -> list[Path]:
    work = Path(work)
    m = json.loads((work / "memory.json").read_text())
    files = [f for f in VIEWER_FILES if (work / f).exists()]
    if m["background"]["url"] == "world/bg.spz":            # don't ship the L0 points when the splat exists
        files = [f for f in files if f != "world/bg_points.ply"]
    for o in m["objects"]:
        url = o["visual"].get("url")
        if url and (work / url).exists():
            files.append(url)
    return [work / f for f in dict.fromkeys(files)]


def publish_dir(work: Path, dest: Path) -> list[Path]:
    work, dest = Path(work), Path(dest)
    out = []
    for f in viewer_files(work):
        rel = f.relative_to(work)
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest / rel)
        out.append(dest / rel)
    return out


CONTENT_TYPES = {".json": "application/json", ".m4a": "audio/mp4", ".spz": "application/octet-stream",
                 ".ply": "application/octet-stream", ".glb": "model/gltf-binary", ".bin": "application/octet-stream"}


def publish_s3(work: Path, prefix: str) -> str:
    """Upload to the bucket; returns the public manifest URL."""
    import boto3

    s3 = boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT"], region_name=os.environ.get("S3_REGION", "auto"))
    bucket = os.environ["S3_BUCKET"]
    for f in viewer_files(work):
        key = f"{prefix.rstrip('/')}/{f.relative_to(work).as_posix()}"
        s3.upload_file(str(f), bucket, key, ExtraArgs={"ContentType": CONTENT_TYPES.get(f.suffix, "application/octet-stream"),
                                                       "CacheControl": "public, max-age=3600"})
    return f"{os.environ['ASSET_BASE_URL'].rstrip('/')}/{prefix.rstrip('/')}/memory.json"


# --- SpacetimeDB over HTTP ------------------------------------------------------------------------------
def _stdb(path: str, body) -> bytes:
    base = os.environ["STDB_HTTP_URL"].rstrip("/")
    data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    req = urllib.request.Request(f"{base}/v1/database/{os.environ['STDB_DATABASE']}/{path}", data=data, method="POST",
                                 headers={"Authorization": "Bearer " + os.environ["PIPELINE_TOKEN"],
                                          "Content-Type": "text/plain" if isinstance(body, str) else "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def set_status(memory_id: int, status: str, progress: float, manifest_url: str = "", error: str = "") -> None:
    """Same call as jerry's scripts/pipeline-status.py (reducer set_memory_status)."""
    _stdb("call/set_memory_status", [memory_id, status, round(progress, 3), manifest_url, error[:500]])


def _identity_hex(v) -> str:
    if isinstance(v, dict):
        v = next(iter(v.values()), "")
    if isinstance(v, list):
        v = v[0] if v else ""
    return str(v).lower().removeprefix("0x")


def pending_jobs() -> list[dict]:
    """Rows of the public memory table with status 'uploaded' assigned to this worker."""
    raw = json.loads(_stdb("sql", "SELECT * FROM memory WHERE status = 'uploaded'"))
    me = os.environ.get("PIPELINE_IDENTITY", "").lower().removeprefix("0x")
    jobs = []
    for stmt in raw:
        cols = [e["name"]["some"] if isinstance(e.get("name"), dict) else e.get("name")
                for e in stmt["schema"]["elements"]]
        for row in stmt["rows"]:
            r = dict(zip(cols, row))
            if not me or _identity_hex(r.get("pipelineIdentity", r.get("pipeline_identity"))) == me:
                jobs.append(r)
    return jobs


def process(job: dict, root: Path) -> str:
    from .cli import STAGES, merge, run_stage

    mid = int(job["id"])
    rid = re.sub(r"[^A-Za-z0-9_-]", "", str(job.get("requestId") or job.get("request_id") or ""))[:36]
    key = f"{mid}-{rid}" if rid else str(mid)                   # ids restart after a database reset
    work = root / f"memory-{key}"
    work.mkdir(parents=True, exist_ok=True)
    progress = 0.1
    set_status(mid, "processing", progress)
    src = job.get("sourceUrl") or job.get("source_url")
    seen = (work / "source.txt").read_text().strip() if (work / "source.txt").exists() else None
    if seen != src or not (work / "clip.mov").exists():          # new clip (or a different one under this key)
        urllib.request.urlretrieve(src, work / "clip.mov")
        (work / "source.txt").write_text(src)
    for name in STAGES:
        run_stage(name, work)
        progress = max(progress, PROGRESS[name])
        set_status(mid, "processing", progress)
    merge(work, job.get("title") or f"Memory {mid}", str(mid), "uploaded-clip")
    if os.environ.get("S3_BUCKET"):
        url = publish_s3(work, f"memories/{key}")
    else:
        dest = Path(os.environ["MEMREPLAY_PUBLISH_DIR"]) / key
        publish_dir(work, dest)
        url = f"{os.environ['MEMREPLAY_PUBLIC_BASE_URL'].rstrip('/')}/{key}/memory.json"
    set_status(mid, "ready", 1.0, manifest_url=url)
    return url


def loop(once: bool = False, poll_s: float = 15.0) -> None:
    root = Path(os.environ.get("MEMREPLAY_WORK") or os.environ.get("WORK") or "work")
    print(f"[worker] polling {os.environ['STDB_HTTP_URL']} / {os.environ['STDB_DATABASE']} every {poll_s:.0f} s")
    if os.environ.get("S3_BUCKET"):
        import boto3  # noqa: F401  fail now, not after a full GPU run
    while True:
        try:
            jobs = pending_jobs()
        except Exception as e:                                   # SpacetimeDB briefly unreachable: try again
            print(f"[worker] poll failed: {e}")
            jobs = []
        for job in jobs:
            mid = int(job["id"])
            print(f"[worker] memory {mid}: {job.get('title')}")
            try:
                print(f"[worker] memory {mid} ready: {process(job, root)}")
            except (Exception, SystemExit) as e:               # stages exit with SystemExit on bad input
                traceback.print_exc()
                try:
                    set_status(mid, "failed", 0.1, error=f"{type(e).__name__}: {e}")
                except Exception:
                    traceback.print_exc()
        if once:
            return
        time.sleep(poll_s)
