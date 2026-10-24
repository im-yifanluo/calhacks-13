"""May the pipeline worker download this memory's sourceUrl?

Any client can call create_memory with any sourceUrl and assign the row to the worker, so
the worker must not trust the URL. It downloads only what the upload service issued:

  service.mjs (S3/R2)   ASSET_BASE_URL/videos/<owner>/<uuid>.<mp4|mov|webm>
  npm run upload:local  PUBLIC_ORIGIN/api/local-media/videos/<owner>/<uuid>.<ext>

and caps the download: at most MAX_SOURCE_BYTES (the upload limit; check Content-Length,
then count the bytes), a few minutes in total, no redirects.

    sys.path.insert(0, "scripts")  # from the repo root
    from source_check import allowed_source
    if not allowed_source(row_source_url, os.environ["ASSET_BASE_URL"], owner=row_owner_hex):
        ...report the memory as failed...

CLI: python3 scripts/source_check.py URL BASE [OWNER]  (exit 0 allowed, 1 refused)
"""
import re
import sys
from urllib.parse import urlsplit

MAX_SOURCE_BYTES = 2 * 1024**3  # service.mjs refuses larger uploads

# The key service.mjs's metadata() makes: videos/<uploader identity>/<request UUID>.<ext>.
KEY = re.compile(
    r"videos/([0-9a-f]{64})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|mov|webm)",
    re.IGNORECASE,
)


def allowed_source(url, base, owner=None):
    """True if url is an upload key directly under base (and, if given, owner's own key).

    owner is the memory row's owner identity, as hex with or without 0x. Pass it: a row can
    then only point at its owner's own uploads.
    """
    if not isinstance(url, str) or not isinstance(base, str):
        return False
    # No query, fragment, backslash, whitespace or control characters anywhere.
    if any(c in "?#\\" or ord(c) <= 32 or ord(c) == 127 for c in url):
        return False
    u, b = urlsplit(url), urlsplit(base.strip())
    if b.scheme.lower() not in ("http", "https") or not b.netloc or b.query or b.fragment:
        return False  # not a usable base
    # Same scheme, host and port; a userinfo trick changes the netloc.
    if u.scheme.lower() != b.scheme.lower() or u.netloc.lower() != b.netloc.lower():
        return False
    prefix = b.path.rstrip("/") + "/"
    if not u.path.startswith(prefix):
        return False
    # The key's alphabet has no "%" or "..": nothing can escape the prefix.
    match = KEY.fullmatch(u.path[len(prefix):])
    if not match:
        return False
    return owner is None or match.group(1).lower() == str(owner).lower().removeprefix("0x")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit("usage: python3 scripts/source_check.py URL BASE [OWNER]")
    ok = allowed_source(*sys.argv[1:])
    print("allowed" if ok else "refused")
    sys.exit(0 if ok else 1)
