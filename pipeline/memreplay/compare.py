"""memreplay compare <memory dir> --video <clip.mp4> --shot <t>=<render.png> ...

Score viewer renders against the video: for each (time, screenshot) pair, the original frame at that time is
resized to the screenshot's size, and PSNR / SSIM / a colour-histogram match are computed over the whole frame and
over the centre third (the part the recorded camera saw sharpest). Writes <memory dir>/compare.jpg (rows: original |
render | abs difference) and <memory dir>/compare.json. The judge reads both.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import cv2
import numpy as np


def frame_at(video: Path, t: float, size: tuple[int, int]) -> np.ndarray:
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-ss",
        f"{t:.3f}",
        "-i",
        str(video),
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-",
    ]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    return cv2.resize(img, size, interpolation=cv2.INTER_AREA)


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    a = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float64)
    b = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = cv2.GaussianBlur(a, (11, 11), 1.5), cv2.GaussianBlur(b, (11, 11), 1.5)
    s_aa = cv2.GaussianBlur(a * a, (11, 11), 1.5) - mu_a**2
    s_bb = cv2.GaussianBlur(b * b, (11, 11), 1.5) - mu_b**2
    s_ab = cv2.GaussianBlur(a * b, (11, 11), 1.5) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + c1) * (2 * s_ab + c2)) / ((mu_a**2 + mu_b**2 + c1) * (s_aa + s_bb + c2))
    return float(m.mean())


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse == 0 else float(10 * np.log10(255**2 / mse))


def hist_match(a: np.ndarray, b: np.ndarray) -> float:
    """Colour-distribution similarity (0-1), insensitive to small misalignments."""
    ha = cv2.calcHist([cv2.cvtColor(a, cv2.COLOR_BGR2HSV)], [0, 1], None, [18, 8], [0, 180, 0, 256])
    hb = cv2.calcHist([cv2.cvtColor(b, cv2.COLOR_BGR2HSV)], [0, 1], None, [18, 8], [0, 180, 0, 256])
    cv2.normalize(ha, ha)
    cv2.normalize(hb, hb)
    return float(cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL))


BG = np.array([30, 21, 12])  # the viewer's page/scene background (#0c151e), BGR


def autocrop(img: np.ndarray) -> np.ndarray:
    """The canvas sits top-left; anything beyond it is the page background. Crop to the content's bounding box
    extended to the origin (the scene's own background has the same colour, so only the far edges are trimmed)."""
    diff = np.abs(img.astype(int) - BG).sum(2) > 24
    ys, xs = np.nonzero(diff)
    if len(ys) < 100:
        return img
    return img[: int(ys.max()) + 1, : int(xs.max()) + 1]


def centre(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    return img[h // 6 : 5 * h // 6, w // 3 : 2 * w // 3]


def run(mdir: Path, video: Path, shots: list[tuple[float, Path]], label: str = "") -> dict:
    mdir = Path(mdir)
    rows, results = [], []
    for t, shot in shots:
        render = cv2.imread(str(shot), cv2.IMREAD_COLOR)
        if render is None:
            raise SystemExit(f"cannot read {shot}")
        render = autocrop(render)
        h, w = render.shape[:2]
        orig = frame_at(video, t, (w, h))
        diff = cv2.absdiff(orig, render)
        r = {
            "t": t,
            "psnr": round(psnr(orig, render), 2),
            "ssim": round(ssim(orig, render), 3),
            "hist": round(hist_match(orig, render), 3),
            "centre_psnr": round(psnr(centre(orig), centre(render)), 2),
            "centre_ssim": round(ssim(centre(orig), centre(render)), 3),
            "centre_hist": round(hist_match(centre(orig), centre(render)), 3),
        }
        results.append(r)
        strip = np.concatenate([orig, render, cv2.convertScaleAbs(diff, alpha=2.0)], axis=1)
        cv2.putText(
            strip,
            f"t={t:.1f}s  PSNR {r['psnr']}  SSIM {r['ssim']}  centre SSIM {r['centre_ssim']}",
            (8, 22),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        rows.append(strip)
    w0 = rows[0].shape[1]
    rows = [r if r.shape[1] == w0 else cv2.resize(r, (w0, int(r.shape[0] * w0 / r.shape[1]))) for r in rows]
    grid = np.concatenate(rows, axis=0)
    if label:
        cv2.putText(
            grid, label, (8, grid.shape[0] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (160, 255, 220), 2, cv2.LINE_AA
        )
    cv2.imwrite(str(mdir / "compare.jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 88])
    summary = {k: round(float(np.mean([r[k] for r in results])), 3) for k in results[0] if k != "t"}
    out = {"label": label, "frames": results, "mean": summary}
    (mdir / "compare.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(summary))
    return out
