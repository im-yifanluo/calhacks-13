// Render a memory from the recorded camera (wearer's view) at several times, portrait 450x800, with headless Chrome.
//   node pipeline/tools/capture.js <memory id> <out dir> [n shots | t1,t2,...]   (needs: npm i -g puppeteer-core, Chrome,
//   and the viewer dev server on http://127.0.0.1:5177; CAPTURE_URL overrides it)
// Prints one JSON line: {id, duration, shots: [{t, path, inGap}]}
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const [, , id, outDir, spec = "6"] = process.argv;
const REPO = path.resolve(__dirname, "..", "..");
const MEM = path.join(REPO, "apps/web/public/memories", id);
const manifest = JSON.parse(fs.readFileSync(path.join(MEM, "memory.json"), "utf8"));
const duration = manifest.timeline.durationSec;
// the viewport must have the clip's aspect: the viewer keeps the vertical FOV and takes the aspect from the window,
// so a 9:16 window on 3:4 glasses footage would crop the sides (and stretch everything 1.33x against the video)
const src = manifest.source || {};
const W = 450, H = src.width && src.height ? Math.round(W * src.height / src.width) : 800;
const gaps = manifest.timeline.gaps || [];
const times = spec.includes(",") ? spec.split(",").map(Number)
  : Array.from({ length: Number(spec) }, (_, k) => +(duration * (k + 0.5) / Number(spec)).toFixed(1));
const inGap = t => gaps.some(([a, b]) => t >= a && t <= b);

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: [...(process.env.SWIFTSHADER ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
      : ["--use-angle=metal", "--enable-gpu-rasterization", "--enable-webgl", "--enable-features=Vulkan,UseSkiaRenderer"]),
      "--ignore-gpu-blocklist", "--no-sandbox", "--autoplay-policy=no-user-gesture-required", `--window-size=${W},${H}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  console.error(`[capture] viewport ${W}x${H} (source ${src.width}x${src.height})`);
  page.on("pageerror", e => console.error("page error:", e.message));
  await page.goto(`${process.env.CAPTURE_URL || "http://127.0.0.1:5177"}/?memory=/memories/${id}/${process.env.MEMFILE || "memory.json"}&mode=free&lod=0`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.getElementById("loading").hidden && window.__memreplayScene, { timeout: 180000 });
  // let the splat upload and sort
  await new Promise(r => setTimeout(r, 6000));
  const info = await page.evaluate(() => {
    const s = window.__memreplayScene;
    const gl = s.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    let splats = 0;
    s.scene.traverse(o => { if (o.packedSplats?.numSplats) splats += o.packedSplats.numSplats; });
    const v = window.memoryReplay;
    if (v.timeline.playing) v.togglePlay();                      // freeze time
    const eyes = document.getElementById("eyes");
    if (!eyes.checked) eyes.click();                            // recorded camera + its field of view
    for (const sel of ["#hud", "header", "aside.scene-meta", "#loading", "#vr-entry", "#joystick", "#room-panel", "#notices"]) {
      document.querySelectorAll(sel).forEach(e => (e.style.display = "none"));
    }
    s.grid.visible = false;
    s.guide.root.visible = false;
    window.dispatchEvent(new Event("resize"));
    return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), splats };
  });
  console.error(`[capture] ${id}: ${info.splats} splats, GL ${info.renderer}`);
  const shots = [];
  for (const t of times) {
    await page.evaluate(t => { const v = window.memoryReplay; if (v.timeline.playing) v.togglePlay(); v.seek(t); }, t);
    await new Promise(r => setTimeout(r, 2500));                // sort + a few frames
    const now = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(window.memoryReplay.timeline.time)))));
    if (Math.abs(now - t) > 0.05) console.error(`[capture] warning: asked t=${t}, viewer at ${now}`);
    const file = path.join(outDir, `${id}_${t.toFixed(1)}.png`);
    await page.screenshot({ path: file });
    shots.push({ t, path: file, inGap: inGap(t) });
    console.error(`[capture] t=${t}s -> ${file}${inGap(t) ? " (tracking lost)" : ""}`);
  }
  await browser.close();
  console.log(JSON.stringify({ id, duration, shots }));
})().catch(e => { console.error(e); process.exit(1); });
