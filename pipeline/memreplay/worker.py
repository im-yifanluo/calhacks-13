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
import urllib.error
import urllib.request
from pathlib import Path

PROGRESS = {
    "normalize": 0.15,
    "nouns": 0.2,
    "vipe": 0.55,
    "world": 0.6,
    "l0": 0.7,
    "objects": 0.8,
    "background": 0.92,
    "refine": 0.94,
    "bake": 0.95,
    "layers": 0.97,
}


def viewer_files(work: Path) -> list[Path]:
    """memory.json, memory.static.json and every file they reference (relative URLs)."""
    work = Path(work)
    files = []
    for name in ("memory.json", "memory.static.json"):
        if not (work / name).exists():
            continue
        m = json.loads((work / name).read_text())
        files.append(name)

        def refs(value):
            if isinstance(value, dict):
                if value.get("kind") == "splat-sequence":
                    for i in range(value["frameCount"]):
                        yield value["urlPattern"].replace("{frame}", str(i))
                for key, child in value.items():
                    if key in ("url", "colliderUrl", "audioUrl", "videoUrl") and child:
                        yield child
                    elif isinstance(child, (dict, list)):
                        yield from refs(child)
            elif isinstance(value, list):
                for child in value:
                    if isinstance(child, (dict, list)):
                        yield from refs(child)

        for ref in refs(m):
            if (
                not isinstance(ref, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]*", ref)
                or any(p in ("", ".", "..") for p in ref.split("/"))
            ):
                raise ValueError("Scene assets must use safe relative paths")
            file = work / ref
            if not file.is_file() or not file.stat().st_size or work.resolve() not in file.resolve().parents:
                raise ValueError(f"Missing or unsafe scene asset: {ref}")
            files.append(ref)
    return [work / f for f in dict.fromkeys(files)]


def publish_dir(work: Path, dest: Path) -> list[Path]:
    work, dest = Path(work), Path(dest)
    out = []
    for f in sorted(viewer_files(work), key=lambda p: p.name == "memory.json"):
        rel = f.relative_to(work)
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest / rel)
        out.append(dest / rel)
    return out


CONTENT_TYPES = {
    ".json": "application/json",
    ".m4a": "audio/mp4",
    ".spz": "application/octet-stream",
    ".ply": "application/octet-stream",
    ".glb": "model/gltf-binary",
    ".bin": "application/octet-stream",
}


def publish_s3(work: Path, prefix: str) -> str:
    """Upload to the bucket; returns the public manifest URL."""
    import boto3

    s3 = boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT"], region_name=os.environ.get("S3_REGION", "auto"))
    bucket = os.environ["S3_BUCKET"]
    for f in sorted(viewer_files(work), key=lambda p: p.name == "memory.json"):
        key = f"{prefix.rstrip('/')}/{f.relative_to(work).as_posix()}"
        s3.upload_file(
            str(f),
            bucket,
            key,
            ExtraArgs={
                "ContentType": CONTENT_TYPES.get(f.suffix, "application/octet-stream"),
                "CacheControl": "public, max-age=3600",
            },
        )
    return f"{os.environ['ASSET_BASE_URL'].rstrip('/')}/{prefix.rstrip('/')}/memory.json"


# --- SpacetimeDB over HTTP ------------------------------------------------------------------------------
def _stdb(path: str, body) -> bytes:
    base = os.environ["STDB_HTTP_URL"].rstrip("/")
    data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{base}/v1/database/{os.environ['STDB_DATABASE']}/{path}",
        data=data,
        method="POST",
        headers={
            "Authorization": "Bearer " + os.environ["PIPELINE_TOKEN"],
            "User-Agent": "memos-pipeline/1.0",
            "Content-Type": "text/plain" if isinstance(body, str) else "application/json",
        },
    )
    opener = urllib.request.build_opener(_NoRedirect)
    for attempt in range(3):
        try:
            with opener.open(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2**attempt)


def set_status(memory_id: int, status: str, progress: float, manifest_url: str = "", error: str = "") -> None:
    """The set_memory_status reducer call that memreplay/status.py makes by hand."""
    _stdb("call/set_memory_status", [memory_id, status, round(progress, 3), manifest_url, error[:500]])


def _identity_hex(v) -> str:
    if isinstance(v, dict):
        v = next(iter(v.values()), "")
    if isinstance(v, list):
        v = v[0] if v else ""
    return str(v).lower().removeprefix("0x")


def _source_check():
    """source_check.py next to this file: only download what the upload service issued. Loaded by path, so this
    module keeps working when it is itself loaded as a bare file (scripts/test-connection-worker.py)."""
    import importlib.util

    path = Path(__file__).resolve().with_name("source_check.py")
    spec = importlib.util.spec_from_file_location("source_check", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def download(url: str, dest: Path, max_bytes: int, timeout_s: float = 300.0) -> None:
    """Capped download: Content-Length checked, bytes counted, no redirects, overall time limit."""
    opener = urllib.request.build_opener(_NoRedirect)
    t0 = time.time()
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "memos-pipeline/1.0"}), timeout=30) as r:
        if int(r.headers.get("Content-Length") or 0) > max_bytes:
            raise RuntimeError("source is larger than the upload limit")
        n = 0
        with open(dest, "wb") as f:
            while chunk := r.read(1 << 20):
                n += len(chunk)
                if n > max_bytes or time.time() - t0 > timeout_s:
                    raise RuntimeError("source too large or too slow")
                f.write(chunk)


def pending_jobs(memory_id: int | None = None) -> list[dict]:
    """Rows of the public memory table with status 'uploaded' assigned to this worker. Test uploads (the
    uploader assigned the row to itself: pipelineIdentity == owner) are skipped."""
    me = os.environ.get("PIPELINE_IDENTITY", "").lower().removeprefix("0x")
    if not re.fullmatch(r"[a-f0-9]{64}", me):
        raise ValueError("PIPELINE_IDENTITY is required; never poll another worker's jobs")
    if memory_id is not None and (not isinstance(memory_id, int) or memory_id < 1):
        raise ValueError("memory_id must be a positive integer")
    query = "SELECT * FROM memory WHERE status = 'uploaded'"
    if memory_id is not None:
        query += f" AND id = {memory_id}"
    raw = json.loads(_stdb("sql", query))
    jobs = []
    for stmt in raw:
        cols = [
            e["name"]["some"] if isinstance(e.get("name"), dict) else e.get("name") for e in stmt["schema"]["elements"]
        ]
        for row in stmt["rows"]:
            r = dict(zip(cols, row))
            pid = _identity_hex(r.get("pipelineIdentity", r.get("pipeline_identity")))
            if pid and pid == _identity_hex(r.get("owner")):
                continue
            if pid == me:
                jobs.append(r)
    return jobs


def process(job: dict, root: Path) -> str:
    from .cli import STAGES, merge, run_stage

    mid = int(job["id"])
    rid = re.sub(r"[^A-Za-z0-9_-]", "", str(job.get("requestId") or job.get("request_id") or ""))[:36]
    key = f"{mid}-{rid}" if rid else str(mid)  # ids restart after a database reset
    work = root / f"memory-{key}"
    work.mkdir(parents=True, exist_ok=True)
    progress = 0.1
    set_status(mid, "processing", progress)
    src = job.get("sourceUrl") or job.get("source_url")
    sc = _source_check()
    base = os.environ.get("ASSET_BASE_URL") or os.environ.get("PUBLIC_ORIGIN", "").rstrip("/") + "/api/local-media"
    if not sc.allowed_source(src, base, owner=_identity_hex(job.get("owner")) or None):
        raise RuntimeError("sourceUrl is not an upload issued by the upload service")
    seen = (work / "source.txt").read_text().strip() if (work / "source.txt").exists() else None
    if seen != src or not (work / "clip.mov").exists():  # new clip (or a different one under this key)
        download(src, work / "clip.mov", sc.MAX_SOURCE_BYTES)
        (work / "source.txt").write_text(src)
    for name in STAGES:
        run_stage(name, work)
        progress = max(progress, PROGRESS.get(name, progress))  # stages added later (refine, bake) keep the last value
        set_status(mid, "processing", progress)
    merge(work, job.get("title") or f"Memory {mid}", str(mid), "uploaded-clip")
    merge(work, job.get("title") or f"Memory {mid}", str(mid), "uploaded-clip", static=True)
    if os.environ.get("MEMREPLAY_UPLOAD_API"):
        from .hosted_publish import publish_hosted

        url = publish_hosted(work, mid)
    elif os.environ.get("S3_BUCKET"):
        url = publish_s3(work, f"memories/{key}")
    else:
        dest = Path(os.environ["MEMREPLAY_PUBLISH_DIR"]) / key
        publish_dir(work, dest)
        url = f"{os.environ['MEMREPLAY_PUBLIC_BASE_URL'].rstrip('/')}/{key}/memory.json"
    set_status(mid, "ready", 1.0, manifest_url=url)
    return url


def loop(once: bool = False, poll_s: float = 15.0, memory_id: int | None = None) -> None:
    root = Path(os.environ.get("MEMREPLAY_WORK") or os.environ.get("WORK") or "work")
    print(f"[worker] polling {os.environ['STDB_HTTP_URL']} / {os.environ['STDB_DATABASE']} every {poll_s:.0f} s")
    if os.environ.get("MEMREPLAY_UPLOAD_API"):
        from .hosted_publish import preflight

        preflight()  # Refuse expensive reconstruction if auth/storage configuration disagrees.
    elif os.environ.get("S3_BUCKET"):
        import boto3  # noqa: F401  fail now, not after a full GPU run
    while True:
        try:
            jobs = pending_jobs(memory_id)
        except Exception as e:  # SpacetimeDB briefly unreachable: try again
            print(f"[worker] poll failed: {e}")
            if once:
                raise
            jobs = []
        failures = []
        for job in jobs:
            mid = int(job["id"])
            print(f"[worker] memory {mid}: {job.get('title')}")
            try:
                print(f"[worker] memory {mid} ready: {process(job, root)}")
            except (Exception, SystemExit) as e:  # stages exit with SystemExit on bad input
                failures.append(mid)
                traceback.print_exc()
                try:
                    set_status(mid, "failed", 0.1, error=f"{type(e).__name__}: {e}")
                except Exception:
                    traceback.print_exc()
        if once:
            if failures:
                raise RuntimeError(f"Processing failed for memories {failures}")
            if memory_id is not None and not jobs:
                raise RuntimeError(f"Memory {memory_id} is not queued for this worker")
            return
        time.sleep(poll_s)
