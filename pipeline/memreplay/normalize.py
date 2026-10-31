"""S1 normalize: any phone or glasses clip -> input/clip.mp4 (upright, constant 30 fps, long side 1280 px,
SDR BT.709, no audio), input/audio.m4a and input/frames.json.

iPhones record HDR (HLG, BT.2020, 10 bit). Decoding that as if it were SDR gives flat, washed-out colours,
and neither the Mac's nor the pod's ffmpeg has zscale for a proper conversion. So we tone-map with a 3D LUT
that we generate here; ffmpeg's built-in lut3d filter applies it anywhere.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

from .handoff import CaptureInfo, FramesInfo, Nouns

FPS = 30
LONG_SIDE = 1280
SOURCE_NAMES = ("clip.mov", "clip.mp4", "clip.MOV", "clip.MP4")


def find_source(work: Path) -> Path:
    for n in SOURCE_NAMES:
        if (work / n).exists():
            return work / n
    raise SystemExit(f"no clip.mov / clip.mp4 in {work}")


def probe(path: Path) -> dict:
    out = subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)])
    return json.loads(out)


# --- HLG -> SDR LUT ---------------------------------------------------------------------------------
_A, _B, _C = 0.17883277, 0.28466892, 0.55991073
_BT2020_TO_709 = np.array([[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]])


def _hlg_inverse_oetf(e: np.ndarray) -> np.ndarray:
    return np.where(e <= 0.5, (e**2) / 3.0, (np.exp((e - _C) / _A) + _B) / 12.0)


def _srgb_oetf(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


# Fitted (Oct 24) to how macOS/iOS show these clips: AVFoundation's SDR rendering of 16 frames from iPhone HDR,
# Ray-Ban Meta exports and outdoor clips; mean error 3 levels of 255 (the previous curve, which put HLG reference
# white at 85 %, was 36 levels too bright and flat). See docs/reports/vision-pipeline.md, "Colour of the input".
HLG_SYSTEM_GAMMA = 0.8478  # OOTF exponent on scene luminance
HLG_EXPOSURE = 1.0233  # scene-linear 1.0 (full HLG signal) -> SDR white
HLG_KNEE = 0.9451  # soft shoulder above this (linear)
HLG_SATURATION = 1.0084


def hlg_to_sdr(rgb: np.ndarray) -> np.ndarray:
    """HLG BT.2020 signal (0..1, full range) -> sRGB/BT.709 signal (0..1), matching Apple's SDR rendering."""
    e = _hlg_inverse_oetf(np.clip(rgb, 0, 1))  # scene light, 0..1
    ys = np.clip(e @ np.array([0.2627, 0.6780, 0.0593]), 1e-6, None)[..., None]
    lin = (e * ys ** (HLG_SYSTEM_GAMMA - 1)) @ _BT2020_TO_709.T  # OOTF, then BT.2020 -> BT.709 primaries
    y = (lin @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    lin = np.clip((y + HLG_SATURATION * (lin - y)) * HLG_EXPOSURE, 0, None)
    knee = HLG_KNEE
    lin = np.where(lin > knee, knee + (1 - knee) * np.tanh((lin - knee) / (1 - knee)), lin)
    return _srgb_oetf(lin)


def write_hlg_lut(path: Path, n: int = 33) -> Path:
    g = np.linspace(0, 1, n)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")  # .cube: red changes fastest
    rgb = np.stack([r, gg, b], axis=-1).reshape(-1, 3)
    out = hlg_to_sdr(rgb)
    lines = [f"LUT_3D_SIZE {n}"] + [f"{x:.6f} {y:.6f} {z:.6f}" for x, y, z in out]
    path.write_text("\n".join(lines) + "\n")
    return path


# --- the stage ---------------------------------------------------------------------------------------
def run(work: Path, eye_height_m: float | None = None, nouns: list[str] | None = None, crf: int = 16) -> FramesInfo:
    work = Path(work)
    src = find_source(work)
    info = probe(src)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    transfer = v.get("color_transfer", "")
    (work / "input").mkdir(parents=True, exist_ok=True)

    scale = f"scale='if(gt(iw,ih),{LONG_SIDE},-2)':'if(gt(iw,ih),-2,{LONG_SIDE})':flags=lanczos"
    if transfer == "arib-std-b67":  # HLG (iPhone HDR): tone-map to SDR
        lut = write_hlg_lut(work / "input" / "hlg_to_sdr.cube")
        vf = (
            f"fps={FPS},{scale}:in_color_matrix=bt2020:in_range=tv:out_range=pc,format=rgb48le,"
            f"lut3d=file='{lut}':interp=tetrahedral,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
        )
    else:
        if transfer == "smpte2084":
            print("[normalize] warning: PQ HDR input is converted without tone mapping; colours will look flat")
        vf = f"fps={FPS},{scale}:out_color_matrix=bt709:out_range=tv,format=yuv420p"
    # ffmpeg applies the phone's rotation flag while decoding, so the output is upright with no flag.
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(src),
            "-vf",
            vf,
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            str(crf),
            "-preset",
            "medium",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-movflags",
            "+faststart",
            str(work / "input" / "clip.mp4"),
        ],
        check=True,
    )
    if has_audio:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-i",
                str(src),
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                str(work / "input" / "audio.m4a"),
            ],
            check=True,
        )

    s = json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-count_frames",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,nb_read_frames",
                "-of",
                "json",
                str(work / "input" / "clip.mp4"),
            ]
        )
    )["streams"][0]
    n = int(s["nb_read_frames"])
    frames = FramesInfo(
        source=src.name, fps=FPS, width=int(s["width"]), height=int(s["height"]), frame_count=n, duration_sec=n / FPS
    )
    (work / "input" / "frames.json").write_text(frames.model_dump_json(indent=2))
    if nouns is not None:  # otherwise the nouns step (Claude) writes it
        (work / "nouns.json").write_text(Nouns(nouns=nouns).model_dump_json(indent=2))
    if eye_height_m is not None:
        (work / "capture.json").write_text(CaptureInfo(eye_height_m=eye_height_m).model_dump_json(indent=2))
    return frames


def contact_sheet(work: Path, out: Path, n: int = 8, width: int = 200) -> Path:
    """n evenly spaced frames of input/clip.mp4 side by side, for a quick look."""
    frames = FramesInfo.model_validate_json((Path(work) / "input" / "frames.json").read_text())
    step = max(1, frames.frame_count // n)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(Path(work) / "input" / "clip.mp4"),
            "-vf",
            f"select='not(mod(n\\,{step}))',scale={width}:-2,tile={n}x1",
            "-frames:v",
            "1",
            str(out),
        ],
        check=True,
    )
    return out


if __name__ == "__main__":  # python -m memreplay.normalize <work> : quick manual run
    import sys

    print(run(Path(sys.argv[1])).model_dump_json(indent=2))
