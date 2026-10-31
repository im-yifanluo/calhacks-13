"""Report a memory's pipeline status to SpacetimeDB (the worker handoff).

Calls the set_memory_status reducer over authenticated HTTP. Only the memory's assigned
pipeline identity may do that, so the worker's token stays on the GPU host.

Environment:
  STDB_HTTP_URL   SpacetimeDB root, e.g. http://127.0.0.1:3055, or the app's public URL plus
                  /stdb (the Vite dev server proxies it).
  STDB_DATABASE   the app's database, e.g. memory-replay.
  PIPELINE_TOKEN  the worker identity's token:
                  - with `npm run upload:local`: "token" in data/uploads/.worker-identity.json,
                    minted on the service's first start;
                  - with service.mjs: "token" from `curl -X POST $STDB_HTTP_URL/v1/identity`,
                    whose "identity" is the service's PIPELINE_IDENTITY.

Exit codes: 0 accepted; 1 rejected (the HTTP status and the reducer's reason are printed) or
SpacetimeDB unreachable; 2 bad arguments or settings.
"""

import argparse
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# set_memory_status rejects longer errors. The reducer is TypeScript, so it counts UTF-16
# code units, not Python characters.
MAX_ERROR = 2000


def error_tail(text, limit=MAX_ERROR):
    """The last `limit` UTF-16 units of text: a traceback ends with the actual failure."""
    text = text[-limit:]
    while len(text.encode("utf-16-le")) // 2 > limit:
        text = text[1:]
    return text


def report(memory_id, status, progress, manifest_url="", error="", *, base, database, token, timeout=30):
    """Call set_memory_status and return the HTTP status.

    Raises urllib.error.HTTPError when SpacetimeDB rejects the call (the body is the reason),
    and OSError or http.client.HTTPException when it cannot be reached.
    """
    request = urllib.request.Request(
        f"{base.rstrip('/')}/v1/database/{urllib.parse.quote(database, safe='')}/call/set_memory_status",
        data=json.dumps([memory_id, status, progress, manifest_url, error_tail(error)]).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status


def main(argv=None):
    p = argparse.ArgumentParser(description="Report a memory's pipeline status to SpacetimeDB.")
    p.add_argument("memory_id", type=int)
    p.add_argument("status", choices=["processing", "ready", "failed"])
    p.add_argument("--progress", type=float, required=True, help="0 to 1; cannot go backwards while processing")
    p.add_argument("--manifest-url", default="", help="absolute http(s) URL of memory.json; required for ready")
    p.add_argument("--error", default="", help=f"failure reason; only its last {MAX_ERROR} characters are sent")
    a = p.parse_args(argv)
    if not 0 <= a.progress <= 1:  # also rejects nan
        p.error("--progress must be between 0 and 1")
    missing = [name for name in ("STDB_HTTP_URL", "STDB_DATABASE", "PIPELINE_TOKEN") if not os.environ.get(name)]
    if missing:
        p.error("set " + ", ".join(missing) + " in the environment")
    base = os.environ["STDB_HTTP_URL"]
    if urllib.parse.urlsplit(base).scheme not in ("http", "https"):
        p.error("STDB_HTTP_URL must be an http(s) URL")
    try:
        code = report(
            a.memory_id,
            a.status,
            a.progress,
            a.manifest_url,
            a.error,
            base=base,
            database=os.environ["STDB_DATABASE"],
            token=os.environ["PIPELINE_TOKEN"],
        )
    except urllib.error.HTTPError as e:  # before OSError: an HTTPError is a URLError
        try:
            reason = e.read().decode("utf-8", "replace").strip()[:1000]
        except (OSError, http.client.HTTPException):
            reason = ""
        print(f"Status rejected ({e.code}): {reason or e.reason}", file=sys.stderr)
        return 1
    except (OSError, http.client.HTTPException) as e:  # URLError, timeouts, resets
        print(f"SpacetimeDB unreachable at {base}: {getattr(e, 'reason', None) or e}", file=sys.stderr)
        return 1
    print("Status accepted:", code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
