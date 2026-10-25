"""CPU-only contract checks; these do not claim to test reconstruction."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from memreplay.worker import viewer_files, pending_jobs
from memreplay.hosted_publish import publish_hosted, preflight


class HostedWorkerTests(unittest.TestCase):
    def test_assets_include_tracks_colliders_and_sequence_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = {"background": {"url": "room.spz"}, "camera": {"track": {"url": "camera.json"}},
                        "objects": [{"visual": {"kind": "splat-sequence", "urlPattern": "frame{frame}.spz", "frameCount": 2},
                                     "collider": {"url": "mesh.glb"}}]}
            (root / "memory.json").write_text(json.dumps(manifest))
            for name in ["room.spz", "camera.json", "frame0.spz", "frame1.spz", "mesh.glb"]:
                (root / name).write_bytes(b"fixture")
            self.assertEqual(len(viewer_files(root)), 6)
            (root / "frame1.spz").unlink()
            with self.assertRaises(ValueError):
                viewer_files(root)
            manifest["background"]["url"] = "../secret.json"
            (root / "memory.json").write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                viewer_files(root)

    def test_worker_never_polls_all_identities_when_unconfigured(self):
        with patch.dict(os.environ, {"PIPELINE_IDENTITY": ""}), patch("memreplay.worker._stdb", return_value=b"[]"):
            with self.assertRaises(ValueError):
                pending_jobs()

    def test_preflight_rejects_another_database(self):
        with patch.dict(os.environ, {"STDB_HTTP_URL": "https://db.example", "STDB_DATABASE": "memos", "PIPELINE_IDENTITY": "b" * 64}), \
             patch("memreplay.hosted_publish.request", return_value={"server": "https://db.example", "database": "wrong"}):
            with self.assertRaises(RuntimeError):
                preflight()

    def test_publish_manifest_last_and_abort_on_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "memory.json").write_text('{"background":{"url":"room.spz"}}')
            (root / "room.spz").write_bytes(b"1234567")
            calls = []
            def api(path, body=None, **kwargs):
                calls.append((path, body))
                if path.endswith('/start'):
                    return {"ticket": body['path'], "partCount": 1, "partBytes": 1024}
                if '/part?' in path:
                    return {"partNumber": 1, "etag": "ok"}
                return {"assetUrl": "https://memos.example/media/" + body['ticket']}
            with patch("memreplay.hosted_publish.request", side_effect=api):
                self.assertTrue(publish_hosted(root, 6).endswith('/memory.json'))
            self.assertEqual([b['path'] for p, b in calls if p.endswith('/start')], ['room.spz', 'memory.json'])


if __name__ == '__main__':
    unittest.main()
