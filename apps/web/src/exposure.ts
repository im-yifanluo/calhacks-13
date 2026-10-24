import type { Keyframe } from "@memreplay/shared";

/**
 * Replay the camera's auto-exposure in wearer's view. The room splat has one exposure (the average frame); the
 * phone's exposure and white balance moved from frame to frame, and each camera keyframe carries the per-channel
 * gain and bias (`e: [gr, gg, gb, br, bg, bb]`, sRGB) that map the splat's colours onto that frame. A CSS colour
 * matrix on the canvas applies it to the whole picture, so the renderer is untouched (and XR, which never uses
 * wearer's view, is unaffected).
 */
const FILTER_ID = "memreplay-exposure";
let matrix: SVGFEColorMatrixElement | null = null;
let lastValues = "";

function ensureFilter(): SVGFEColorMatrixElement {
  if (matrix) return matrix;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
  svg.style.position = "absolute"; svg.style.pointerEvents = "none";
  const filter = document.createElementNS(ns, "filter");
  filter.setAttribute("id", FILTER_ID);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  matrix = document.createElementNS(ns, "feColorMatrix");
  matrix.setAttribute("type", "matrix");
  matrix.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0");
  filter.appendChild(matrix);
  svg.appendChild(filter);
  document.body.appendChild(svg);
  return matrix;
}

/** The exposure recorded nearest to `time` (keyframes without one count as neutral). */
export function exposureAt(track: Keyframe[], time: number): number[] | null {
  if (track.length === 0) return null;
  let lo = 0, hi = track.length - 1;
  while (lo < hi) {                                   // first keyframe with t >= time
    const mid = (lo + hi) >> 1;
    if (track[mid].t < time) lo = mid + 1; else hi = mid;
  }
  const k = lo > 0 && Math.abs(track[lo - 1].t - time) < Math.abs(track[lo].t - time) ? lo - 1 : lo;
  return track[k].e ?? null;
}

export function applyExposure(el: HTMLElement, track: Keyframe[], time: number): void {
  const e = exposureAt(track, time);
  if (!e) { clearExposure(el); return; }
  const [gr, gg, gb, br, bg, bb] = e;
  const values = `${gr} 0 0 0 ${br}  0 ${gg} 0 0 ${bg}  0 0 ${gb} 0 ${bb}  0 0 0 1 0`;
  const m = ensureFilter();
  if (values !== lastValues) { m.setAttribute("values", values); lastValues = values; }
  const css = `url(#${FILTER_ID})`;
  if (el.style.filter !== css) el.style.filter = css;
}

export function clearExposure(el: HTMLElement): void {
  if (el.style.filter) el.style.filter = "";
}
