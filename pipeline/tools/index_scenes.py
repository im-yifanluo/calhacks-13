#!/usr/bin/env python3
"""Index the scenes copied into apps/web/public/memories/<id>/ for local development.

Writes apps/web/public/memories/index.json, which the viewer's dev seeding (apps/web/src/library/dev-seed.ts) and the
local scenes page (/scenes/index.html) read. Run it after pulling or publishing scenes into that folder:

    python pipeline/tools/index_scenes.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

MEMORIES = Path(__file__).resolve().parents[2] / "apps/web/public/memories"


def scene(directory: Path) -> dict | None:
    """One scene folder: its manifests, title, length and the optional preview and render-vs-video grid."""
    manifests = [name for name in ("memory.json", "memory.static.json") if (directory / name).is_file()]
    if not manifests:
        return None
    manifest = json.loads((directory / manifests[0]).read_text())
    asset = lambda name: f"/memories/{directory.name}/{name}" if (directory / name).is_file() else None  # noqa: E731
    return {
        "id": directory.name,
        "title": manifest.get("title") or directory.name,
        "seconds": round(manifest.get("timeline", {}).get("durationSec", 0)),
        "dynamic": "memory.json" in manifests,
        "static": "memory.static.json" in manifests,
        "preview": asset("preview.jpg"),
        "grid": asset("compare.jpg"),
    }


def main() -> None:
    folders = sorted(path for path in MEMORIES.iterdir() if path.is_dir()) if MEMORIES.is_dir() else []
    scenes = [entry for entry in map(scene, folders) if entry]
    MEMORIES.mkdir(parents=True, exist_ok=True)
    index = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "scenes": scenes}
    (MEMORIES / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    print(f"Indexed {len(scenes)} scene(s) in {MEMORIES / 'index.json'}")


if __name__ == "__main__":
    main()
