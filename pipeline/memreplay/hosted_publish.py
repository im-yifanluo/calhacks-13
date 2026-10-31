"""Publish Runpod outputs through memos' worker-authenticated multipart R2 bridge."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never forward the worker's bearer credential to another host.


def request(path: str, body=None, *, method=None, raw=False):
    base = os.environ["MEMREPLAY_UPLOAD_API"].rstrip("/")
    url = urllib.parse.urlsplit(base)
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost")):
        raise ValueError("MEMREPLAY_UPLOAD_API must use HTTPS (or localhost for tests)")
    if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("MEMREPLAY_UPLOAD_API must be an origin")
    data = body if raw else json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Bearer " + os.environ["PIPELINE_TOKEN"], "User-Agent": "memos-pipeline/1.0"}
    if data is not None:
        headers.update(
            {
                "Content-Type": "application/octet-stream" if raw else "application/json",
                "Content-Length": str(len(data)),
            }
        )
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                base + path, data=data, headers=headers, method=method or ("POST" if data is not None else "GET")
            )
            with opener.open(req, timeout=120) as response:
                return json.loads(response.read(65536))
        except urllib.error.HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                # URLs may contain signed tickets. Do not put them in logs.
                raise RuntimeError(f"Memos pipeline API returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise RuntimeError("Memos pipeline API is unreachable") from None
        time.sleep(2**attempt)


def preflight():
    config = request("/api/pipeline/config")
    for name, env in (
        ("server", "STDB_HTTP_URL"),
        ("database", "STDB_DATABASE"),
        ("workerIdentity", "PIPELINE_IDENTITY"),
    ):
        if config.get(name, "").rstrip("/") != os.environ.get(env, "").rstrip("/"):
            raise RuntimeError(f"Upload service and worker disagree on {env}")
    return config


def publish_hosted(work: Path, memory_id: int) -> str:
    from .worker import viewer_files

    files = viewer_files(work)
    # Publish the primary manifest last, after all its referenced files are readable.
    files.sort(key=lambda f: f.name == "memory.json")
    manifest_url = None
    for file in files:
        upload = request(
            "/api/pipeline/assets/start",
            {"memoryId": str(memory_id), "path": file.relative_to(work).as_posix(), "size": file.stat().st_size},
        )
        try:
            parts = []
            with file.open("rb") as source:
                for number in range(1, upload["partCount"] + 1):
                    chunk = source.read(upload["partBytes"])
                    path = "/api/pipeline/assets/part?" + urllib.parse.urlencode(
                        {"ticket": upload["ticket"], "part": number}
                    )
                    parts.append(request(path, chunk, method="PUT", raw=True))
            complete = request("/api/pipeline/assets/complete", {"ticket": upload["ticket"], "parts": parts})
            if file.name == "memory.json":
                manifest_url = complete["assetUrl"]
        except Exception:
            try:
                request("/api/pipeline/assets/abort", {"ticket": upload["ticket"]})
            except Exception:
                pass
            raise
    if not manifest_url:
        raise RuntimeError("No memory.json was generated")
    return manifest_url


if __name__ == "__main__":
    config = preflight()
    print(f"PASS worker authentication and destination: {config['database']}")
