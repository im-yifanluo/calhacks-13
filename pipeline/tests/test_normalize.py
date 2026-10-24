import shutil
import subprocess

import pytest

from memreplay.normalize import probe, run


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="requires FFmpeg")
def test_normalized_hdr_clip_has_sdr_frame_tags(tmp_path):
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=30",
        "-t", "0.2", "-c:v", "libx264", "-color_primaries", "bt2020",
        "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", str(tmp_path / "clip.mov"),
    ], check=True)
    run(tmp_path)
    stream = probe(tmp_path / "input/clip.mp4")["streams"][0]
    assert stream["color_transfer"] == "bt709"
    assert stream["color_primaries"] == "bt709"
    assert stream["color_space"] == "bt709"
    assert stream["color_range"] == "tv"
