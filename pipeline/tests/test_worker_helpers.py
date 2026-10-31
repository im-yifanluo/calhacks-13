"""The worker's standard-library helpers, run as standalone scripts (`python -I`) like the worker host runs them:
memreplay/status.py against a stub of SpacetimeDB's reducer endpoint, and memreplay/source_check.py."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "memreplay"


def run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-I", *args], capture_output=True, text=True, timeout=20, env=env or {}, check=False
    )


@pytest.fixture
def stdb():
    """A stub SpacetimeDB that records reducer calls and answers with `reply` (code, body)."""
    state = {"received": [], "reply": (200, b"")}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            state["received"].append(
                {"url": self.path, "auth": self.headers["Authorization"], "args": json.loads(body)}
            )
            code, payload = state["reply"]
            self.send_response(code)
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["env"] = {
        "STDB_HTTP_URL": f"http://127.0.0.1:{server.server_address[1]}/",
        "STDB_DATABASE": "memory-replay",
        "PIPELINE_TOKEN": "worker-token",
    }
    yield state
    server.shutdown()
    server.server_close()


def status(*args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return run(str(PACKAGE / "status.py"), *args, env=env)


def test_status_reports_and_prints_the_reducers_reason(stdb):
    ok = status("12", "processing", "--progress", "0.5", env=stdb["env"])
    assert ok.returncode == 0
    assert "Status accepted: 200" in ok.stdout
    assert stdb["received"][0] == {
        "url": "/v1/database/memory-replay/call/set_memory_status",
        "auth": "Bearer worker-token",
        "args": [12, "processing", 0.5, "", ""],
    }

    # A rejected status (SpacetimeDB answers 530 with the reducer's reason): exit 1.
    stdb["reply"] = (530, b"Progress cannot go backwards")
    rejected = status("12", "processing", "--progress", "0.2", env=stdb["env"])
    assert rejected.returncode == 1
    assert "Status rejected (530): Progress cannot go backwards" in rejected.stderr


def test_status_sends_the_tail_of_long_errors_in_utf16_units(stdb):
    # The reducer rejects errors over 2000 UTF-16 units: send the traceback's tail.
    traceback = "x" * 2500 + "END"
    assert status("12", "failed", "--progress", "0.3", "--error", traceback, env=stdb["env"]).returncode == 0
    sent = stdb["received"][-1]["args"][4]
    assert len(sent) == 2000
    assert sent.endswith("xEND")
    # Characters outside the BMP count twice in JavaScript, as in the reducer.
    status("12", "failed", "--progress", "0.3", "--error", "😀" * 1500, env=stdb["env"])
    assert len(stdb["received"][-1]["args"][4].encode("utf-16-le")) // 2 == 2000


def test_status_rejects_bad_arguments_and_missing_settings_without_a_request(stdb):
    for progress in ("nan", "1.5"):
        assert status("12", "processing", "--progress", progress, env=stdb["env"]).returncode == 2
    unset = status("12", "processing", "--progress", "0.5", env={"STDB_HTTP_URL": stdb["env"]["STDB_HTTP_URL"]})
    assert unset.returncode == 2
    assert "STDB_DATABASE, PIPELINE_TOKEN" in unset.stderr
    assert stdb["received"] == []


def test_status_reports_an_unreachable_database():
    with socket.socket() as probe:  # a port that nothing listens on once the probe closes
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env = {"STDB_HTTP_URL": f"http://127.0.0.1:{port}/", "STDB_DATABASE": "memory-replay", "PIPELINE_TOKEN": "t"}
    down = status("12", "processing", "--progress", "0.5", env=env)
    assert down.returncode == 1
    assert "SpacetimeDB unreachable" in down.stderr


OWNER = "a" * 64
KEY = f"videos/{OWNER}/00000000-0000-4000-8000-000000000001"
BASE = "https://assets.example.test"
LOCAL = "http://127.0.0.1:5173/api/local-media"  # upload:local's media route


def check(url: str, base: str = BASE, owner: str | None = None) -> int:
    return run(str(PACKAGE / "source_check.py"), url, base, *([owner] if owner else [])).returncode


@pytest.mark.parametrize(
    ("url", "base", "owner"),
    [
        (f"{BASE}/{KEY}.mp4", BASE, None),
        (f"{BASE}/{KEY}.mov", f"{BASE}/", f"0x{OWNER}"),
        (f"{LOCAL}/{KEY}.webm", f"{LOCAL}/", None),
    ],
)
def test_source_check_allows_upload_keys_under_the_asset_base(url, base, owner):
    assert check(url, base, owner) == 0


@pytest.mark.parametrize(
    "url",
    [
        f"{BASE}/{KEY}.mp4?download=1",
        f"{BASE}/{KEY}.mp4#t=1",
        f"{BASE}/{KEY}.txt",
        f"{BASE}/videos/{OWNER}/../{KEY}.mp4",
        f"{BASE}/videos/%2e%2e/{KEY}.mp4",
        f"{BASE}.evil.test/{KEY}.mp4",
        f"https://evil.test@assets.example.test/{KEY}.mp4",
        f"http://assets.example.test/{KEY}.mp4",
        f"{BASE}:8443/{KEY}.mp4",
        "http://169.254.169.254/latest/meta-data/",
        f"http://127.0.0.1:5173/{KEY}.mp4",  # under the origin but not the media route
    ],
)
def test_source_check_refuses_everything_else(url):
    assert check(url) == 1


def test_source_check_requires_the_memorys_owner():
    assert check(f"{BASE}/{KEY}.mp4", BASE, "b" * 64) == 1


def test_source_check_imports_for_the_worker():
    from memreplay.source_check import MAX_SOURCE_BYTES, allowed_source

    assert allowed_source(f"{BASE}/{KEY}.mp4", BASE)
    assert MAX_SOURCE_BYTES == 2 * 1024**3
