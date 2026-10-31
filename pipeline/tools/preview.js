// Render one snapshot of each memory's Gaussian-splat scene, for the memory cards in the library and the viewer.
//   node pipeline/tools/preview.js [id ...]        (default: every apps/web/public/memories/<id> with a memory.json)
// For each memory it renders the scene from the recorded camera (wearer's view) at several tracked moments (the scoring
// capture's moments from compare.json, plus fixed shares of the clip), scores each render on the band a card shows
// (sharpness and contrast up; blown-out or near-black frames down; how well the render matched the video breaks ties),
// and saves the best as apps/web/public/memories/<id>/preview.jpg next to memory.json, where the cards look for it.
// Uses capture.js, so it needs the same things: puppeteer-core, Chrome, and the viewer dev server (CAPTURE_URL, default
// http://127.0.0.1:5177). JPEG conversion uses sips (macOS) or ImageMagick's convert.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const REPO = path.resolve(__dirname, "..", "..");
const MEMORIES = path.join(REPO, "apps/web/public/memories");
const args = process.argv.slice(2);
const ids = args.length
  ? args
  : fs
      .readdirSync(MEMORIES)
      .filter((id) => fs.existsSync(path.join(MEMORIES, id, "memory.json")))
      .sort();
/** The band of a portrait render that the landscape card art shows (object-position: center 45%). */
const BAND = { centre: 0.45, height: 0.32 };

/** Candidate moments, off any stretch where tracking was lost, each with how well the render matched the video (0–1). */
function candidates(id, manifest) {
  const duration = manifest.timeline.durationSec,
    gaps = manifest.timeline.gaps || [];
  const clear = (t) => t >= 0 && t <= duration && !gaps.some(([a, b]) => t >= a - 0.5 && t <= b + 0.5);
  const out = new Map();
  try {
    const compare = JSON.parse(fs.readFileSync(path.join(MEMORIES, id, "compare.json"), "utf8"));
    for (const f of compare.frames || []) {
      const t = +Number(f.t).toFixed(1);
      if (Number.isFinite(t) && clear(t))
        out.set(t, ((f.centre_ssim ?? f.ssim ?? 0.5) + (f.centre_hist ?? f.hist ?? 0.5)) / 2);
    }
  } catch {
    /* no scores for this memory */
  }
  for (const share of [0.25, 0.4, 0.55, 0.7]) {
    const t = +(duration * share).toFixed(1);
    if (clear(t) && ![...out.keys()].some((k) => Math.abs(k - t) < 1)) out.set(t, null);
  }
  if (!out.size) out.set(+(duration * 0.4).toFixed(1), null);
  return [...out].map(([t, fidelity]) => ({ t, fidelity }));
}

/** Looks of one render, measured in the page on a downscaled copy of the card's band. */
async function looks(page, file) {
  const data = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  return page.evaluate(
    async (data, band) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const w = 192,
        h = Math.round((w * image.height) / image.width),
        top = Math.round(h * (band.centre - band.height / 2)),
        bh = Math.round(h * band.height);
      const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, w, h);
      const px = ctx.getImageData(0, top, w, bh).data,
        lum = new Float32Array(w * bh);
      for (let i = 0; i < lum.length; i++)
        lum[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      let sum = 0,
        sq = 0,
        edges = 0,
        clipped = 0,
        dark = 0;
      for (let y = 0; y < bh; y++)
        for (let x = 0; x < w; x++) {
          const v = lum[y * w + x];
          sum += v;
          sq += v * v;
          if (v > 245) clipped++;
          if (v < 22) dark++;
          if (x + 1 < w) edges += Math.abs(v - lum[y * w + x + 1]);
          if (y + 1 < bh) edges += Math.abs(v - lum[(y + 1) * w + x]);
        }
      const n = lum.length,
        mean = sum / n;
      return {
        mean,
        contrast: Math.sqrt(Math.max(0, sq / n - mean * mean)),
        edges: edges / n,
        clipped: clipped / n,
        dark: dark / n,
      };
    },
    data,
    BAND,
  );
}

/** Sharp, contrasty, neither blown out nor black; the video match only breaks near-ties. */
const score = (l, fidelity) =>
  l.edges / 12 + l.contrast / 60 - 1.5 * l.clipped - 1.2 * l.dark + 0.3 * (fidelity ?? 0.5);

function toJpeg(png, jpg) {
  try {
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", "960", png, "--out", jpg], {
      stdio: "ignore",
    });
    return;
  } catch {
    /* not macOS */
  }
  execFileSync("convert", [png, "-resize", "960x960>", "-quality", "82", jpg], { stdio: "ignore" });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage();
  let failed = 0;
  for (const id of ids) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memreplay-preview-"));
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(MEMORIES, id, "memory.json"), "utf8"));
      const moments = candidates(id, manifest);
      const out = execFileSync(
        "node",
        [path.join(__dirname, "capture.js"), id, tmp, `${moments.map((m) => m.t).join(",")},`],
        {
          env: { ...process.env, SCALE: process.env.SCALE || "2" },
          stdio: ["ignore", "pipe", "inherit"],
          timeout: 600000,
        },
      ).toString();
      const shots = JSON.parse(out.trim().split("\n").pop()).shots;
      let best = null;
      for (const shot of shots) {
        const moment = moments.find((m) => Math.abs(m.t - shot.t) < 0.05);
        const l = await looks(page, shot.path),
          s = score(l, moment?.fidelity);
        if (!best || s > best.score) best = { ...shot, score: s, looks: l };
      }
      toJpeg(best.path, path.join(MEMORIES, id, "preview.jpg"));
      const l = best.looks;
      console.log(
        `${id}: t=${best.t}s of ${shots.length} (edges ${l.edges.toFixed(1)}, contrast ${l.contrast.toFixed(0)}, clipped ${(l.clipped * 100).toFixed(0)}%, dark ${(l.dark * 100).toFixed(0)}%) -> ${path.relative(REPO, path.join(MEMORIES, id, "preview.jpg"))}`,
      );
    } catch (error) {
      failed++;
      console.error(`${id}: failed: ${String(error.message || error).split("\n")[0]}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
