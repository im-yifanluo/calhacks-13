import * as THREE from "three";

/**
 * The in-VR control panel: a canvas drawn onto a plane that floats a little below your line of sight and follows you
 * lazily (it re-centres only when you turn or walk away from it, so it never swims with every head movement).
 * Layout, hit testing and the follow rule are plain functions, so they can be tested without a headset.
 */

/** Canvas size in pixels and the plane's size in metres (same aspect ratio). */
export const PANEL = { width: 1024, height: 384, metersWide: 0.96, metersHigh: 0.36 } as const;

export type PanelAction = "play" | "back" | "forward" | "scrub" | "prev-take" | "next-take" | "original";
export interface Region { id: PanelAction; x: number; y: number; w: number; h: number }

/** Clickable regions in canvas pixels, origin top-left. */
export const REGIONS: readonly Region[] = [
  { id: "play", x: 24, y: 20, w: 176, h: 88 },
  { id: "back", x: 216, y: 20, w: 128, h: 88 },
  { id: "forward", x: 360, y: 20, w: 128, h: 88 },
  { id: "scrub", x: 24, y: 124, w: 976, h: 72 },
  { id: "prev-take", x: 24, y: 212, w: 88, h: 88 },
  { id: "next-take", x: 712, y: 212, w: 88, h: 88 },
  { id: "original", x: 816, y: 212, w: 184, h: 88 },
];
/** The scrubber track's ends inside its region, so the knob never touches the region's edge. */
const TRACK = { x0: 56, x1: 968, y: 160 };

/** What the panel shows. */
export interface PanelState {
  playing: boolean;
  time: number;
  duration: number;
  take: string;
  takeIndex: number;
  takeCount: number;
  /** Fork times of the takes on the current path, in seconds, drawn as marks on the scrubber. */
  forks: number[];
  status: string;
  room: string;
  holding: boolean;
}

/** Which region a ray hit, from the plane's uv (three's PlaneGeometry: origin bottom-left). */
export function hitRegion(u: number, v: number): PanelAction | null {
  const x = u * PANEL.width, y = (1 - v) * PANEL.height;
  return REGIONS.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)?.id ?? null;
}

/** The time a point on the scrubber stands for, clamped to the clip. */
export function scrubTime(u: number, duration: number): number {
  const x = u * PANEL.width;
  const ratio = Math.min(1, Math.max(0, (x - TRACK.x0) / (TRACK.x1 - TRACK.x0)));
  return ratio * duration;
}

/** Comfortable spot for the panel: 0.85 m ahead along the horizontal view direction, 0.3 m below the eyes. */
export const FOLLOW = { distance: 0.85, drop: 0.3, maxAngleDeg: 35, maxMove: 0.5 } as const;

export function panelTarget(head: THREE.Vector3, forward: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(head).addScaledVector(forward, FOLLOW.distance).setY(head.y - FOLLOW.drop);
}

/**
 * Lazy follow: re-centre when the panel is more than 35° off the horizontal view direction, or the head has moved more
 * than 0.5 m from where it was when the panel was last placed. `forward` is the head's horizontal unit forward.
 */
export function needsRecenter(panel: THREE.Vector3, head: THREE.Vector3, forward: THREE.Vector3, placedFrom: THREE.Vector3): boolean {
  const dx = panel.x - head.x, dz = panel.z - head.z, length = Math.hypot(dx, dz);
  if (length < 1e-6) return true;
  const cos = (dx * forward.x + dz * forward.z) / length;
  if (cos < Math.cos(FOLLOW.maxAngleDeg * Math.PI / 180)) return true;
  return Math.hypot(head.x - placedFrom.x, head.z - placedFrom.z) > FOLLOW.maxMove;
}

const COLOR = {
  background: "rgba(13, 26, 34, 0.94)", border: "#2b4756", button: "#1b3341", hover: "#2c5466", press: "#8ce5dd",
  text: "#ffffff", quiet: "#b6c7cf", accent: "#8ce5dd", track: "#2a4250", fork: "#ffd27a",
};

export class VRPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  hover: PanelAction | null = null;
  pressed: PanelAction | null = null;
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private drawn = "";
  private placed = false;
  private placedFrom = new THREE.Vector3();
  private target = new THREE.Vector3();
  private look = new THREE.Vector3();
  private moving = false;

  constructor(parent: THREE.Object3D) {
    this.canvas.width = PANEL.width; this.canvas.height = PANEL.height;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    // Drawn last and over everything, so splats or objects passing in front never hide the controls.
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL.metersWide, PANEL.metersHigh), material);
    this.mesh.renderOrder = 1000; this.mesh.visible = false; this.mesh.name = "vr-panel";
    parent.add(this.mesh);
  }

  /** Hide it and forget where it was; the next follow() places it in front of the head at once. */
  reset(): void { this.mesh.visible = false; this.placed = false; this.moving = false; }

  /** Keep the panel in reach: placed at once the first time, then eased to a new spot only when needed. */
  follow(head: THREE.Vector3, forward: THREE.Vector3, dt: number): void {
    this.mesh.visible = true;
    if (!this.placed || needsRecenter(this.mesh.position, head, forward, this.placedFrom)) {
      panelTarget(head, forward, this.target); this.placedFrom.copy(head); this.moving = this.placed; this.placed = true;
      if (!this.moving) this.mesh.position.copy(this.target);
    }
    if (this.moving) {
      const k = 1 - Math.exp(-Math.max(0, dt) * 10);
      this.mesh.position.lerp(this.target, k);
      if (this.mesh.position.distanceTo(this.target) < 0.002) { this.mesh.position.copy(this.target); this.moving = false; }
    }
    // Face the eyes, tilted back a little because it sits below them.
    this.look.copy(head); this.mesh.lookAt(this.look);
  }

  /** Redraw only when something on it changed. */
  draw(state: PanelState): void {
    const key = JSON.stringify([state, this.hover, this.pressed]);
    if (key === this.drawn) return;
    this.drawn = key;
    const ctx = this.context, { width, height } = PANEL;
    ctx.clearRect(0, 0, width, height);
    roundRect(ctx, 4, 4, width - 8, height - 8, 28); ctx.fillStyle = COLOR.background; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = COLOR.border; ctx.stroke();
    const button = (id: PanelAction, label: string, size = 34) => {
      const r = REGIONS.find(region => region.id === id)!;
      const pressed = this.pressed === id, hover = this.hover === id;
      roundRect(ctx, r.x, r.y, r.w, r.h, 18);
      ctx.fillStyle = pressed ? COLOR.press : hover ? COLOR.hover : COLOR.button; ctx.fill();
      if (hover && !pressed) { ctx.lineWidth = 3; ctx.strokeStyle = COLOR.accent; ctx.stroke(); }
      ctx.fillStyle = pressed ? "#0d1a22" : COLOR.text; ctx.font = `600 ${size}px sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 2);
    };
    button("play", state.playing ? "❚❚  PAUSE" : "▶  PLAY");
    button("back", "−1 s");
    button("forward", "+1 s");
    // Time, right-aligned on the first row.
    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillStyle = COLOR.text; ctx.font = "600 40px sans-serif";
    ctx.fillText(`${state.time.toFixed(1)} / ${state.duration.toFixed(1)} s`, 1000, 64);
    // Scrubber: track, progress, take fork marks, knob.
    const scrub = REGIONS.find(region => region.id === "scrub")!;
    if (this.hover === "scrub" || this.pressed === "scrub") {
      roundRect(ctx, scrub.x, scrub.y, scrub.w, scrub.h, 18); ctx.fillStyle = COLOR.button; ctx.fill();
    }
    const ratio = state.duration > 0 ? Math.min(1, Math.max(0, state.time / state.duration)) : 0;
    const knobX = TRACK.x0 + ratio * (TRACK.x1 - TRACK.x0);
    ctx.lineCap = "round"; ctx.lineWidth = 14;
    ctx.strokeStyle = COLOR.track; ctx.beginPath(); ctx.moveTo(TRACK.x0, TRACK.y); ctx.lineTo(TRACK.x1, TRACK.y); ctx.stroke();
    ctx.strokeStyle = COLOR.accent; ctx.beginPath(); ctx.moveTo(TRACK.x0, TRACK.y); ctx.lineTo(knobX, TRACK.y); ctx.stroke();
    ctx.fillStyle = COLOR.fork;
    for (const fork of state.forks) {
      const x = TRACK.x0 + Math.min(1, Math.max(0, fork / state.duration)) * (TRACK.x1 - TRACK.x0);
      ctx.beginPath(); ctx.moveTo(x, TRACK.y - 22); ctx.lineTo(x + 9, TRACK.y - 13); ctx.lineTo(x, TRACK.y - 4); ctx.lineTo(x - 9, TRACK.y - 13); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = COLOR.text; ctx.beginPath(); ctx.arc(knobX, TRACK.y, this.pressed === "scrub" ? 20 : 16, 0, Math.PI * 2); ctx.fill();
    // Takes: ◀ name ▶ and Original.
    button("prev-take", "◀", 38);
    button("next-take", "▶", 38);
    button("original", "ORIGINAL", 30);
    ctx.textAlign = "center"; ctx.fillStyle = COLOR.text; ctx.font = "600 36px sans-serif";
    ctx.fillText(fit(ctx, state.take, 560), 412, 244);
    ctx.fillStyle = COLOR.quiet; ctx.font = "26px sans-serif";
    ctx.fillText(state.takeCount > 1 ? `take ${state.takeIndex + 1} of ${state.takeCount}` : "the original recording", 412, 282);
    // Status (left) and room (right).
    ctx.textBaseline = "middle"; ctx.font = "26px sans-serif";
    ctx.textAlign = "right"; ctx.fillStyle = COLOR.quiet;
    const room = fit(ctx, state.room, 300); ctx.fillText(room, 1000, 340);
    const roomWidth = ctx.measureText(room).width;
    ctx.textAlign = "left"; ctx.fillStyle = state.holding ? COLOR.accent : COLOR.text;
    ctx.fillText(fit(ctx, state.status, 976 - roomWidth - 32), 24, 340);
    this.texture.needsUpdate = true;
  }

  setDimmed(dimmed: boolean): void { this.mesh.material.opacity = dimmed ? 0.4 : 1; }

  dispose(): void {
    this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Shorten text with an ellipsis so it fits `max` pixels in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
  return `${cut}…`;
}
