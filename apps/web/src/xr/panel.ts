import * as THREE from "three";

/**
 * The in-VR control panel: a canvas drawn onto a plane, styled as dark glass. It opens 1.1 m ahead and 0.5 m below the
 * eyes (about 24° down) and follows lazily: it re-centres only when you turn more than 30° or step 0.5 m away, and never
 * while you point at it. Drag the bar under it to put it anywhere (the thumbstick pushes it away or pulls it closer); it
 * then stays where you left it until you bring it back (click the right thumbstick, or press B or Y twice).
 * The panel is a child of the rig, so thumbstick moves and snap turns carry it along.
 * Sizes follow the VR design brief: about 33° wide, ~31 canvas px per degree, targets of 2.6° and up, text of 0.8° and up.
 * Layout, hit testing and the follow rule are plain functions, so they can be tested without a headset.
 */

/** Canvas size in layout pixels and the plane's width in metres; the height keeps the canvas aspect. */
export const PANEL = { width: 1024, height: 512, metersWide: 0.74 } as const;
/**
 * The canvas is drawn at 1.5× its layout size (1536 × 768, about 2,000 px per metre): sharper text on the Quest's
 * lenses, while a redraw still uploads only 4.5 MB. Layout and hit testing stay in layout pixels.
 */
const SUPERSAMPLE = 1.5;
export const PANEL_METERS_HIGH = (PANEL.metersWide * PANEL.height) / PANEL.width;

export type PanelAction =
  | "play"
  | "back"
  | "forward"
  | "scrub"
  | "prev-take"
  | "next-take"
  | "original"
  | "help"
  | "hide"
  | "show"
  | "exit"
  | "summon";
/** full: the controls. help: how to use it. compact: hidden, leaving a small "Show controls" pill. */
export type PanelMode = "full" | "help" | "compact";
export interface Region {
  id: PanelAction;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The glass body inside a 24 px transparent margin (room for its shadow). Rays outside it pass through. */
export const BODY = { x: 24, y: 24, w: 976, h: 464, radius: 28 } as const;
const HELP: Region = { id: "help", x: 760, y: 40, w: 112, h: 80 };
const HIDE: Region = { id: "hide", x: 888, y: 40, w: 96, h: 80 };

/** Clickable regions in canvas pixels, origin top-left; at least 16 px apart. */
export const REGIONS: readonly Region[] = [
  HELP,
  HIDE,
  { id: "play", x: 40, y: 136, w: 200, h: 96 },
  { id: "back", x: 256, y: 144, w: 112, h: 80 },
  { id: "forward", x: 384, y: 144, w: 112, h: 80 },
  { id: "scrub", x: 40, y: 248, w: 944, h: 80 },
  { id: "prev-take", x: 40, y: 344, w: 80, h: 80 },
  { id: "next-take", x: 632, y: 344, w: 80, h: 80 },
  { id: "original", x: 728, y: 344, w: 256, h: 80 },
];
export const HELP_REGIONS: readonly Region[] = [HELP, HIDE, { id: "exit", x: 728, y: 344, w: 256, h: 80 }];
export const COMPACT_REGIONS: readonly Region[] = [{ id: "show", x: 332, y: 392, w: 360, h: 96 }];
/** The scrubber track's ends inside its region, so the knob never touches the region's edge. */
const TRACK = { x0: 72, x1: 952, y: 288 };

export function regionsFor(mode: PanelMode): readonly Region[] {
  return mode === "full" ? REGIONS : mode === "help" ? HELP_REGIONS : COMPACT_REGIONS;
}

const canvasPoint = (u: number, v: number) => ({ x: u * PANEL.width, y: (1 - v) * PANEL.height });
const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Which region a ray hit, from the plane's uv (three's PlaneGeometry: origin bottom-left). */
export function hitRegion(u: number, v: number, mode: PanelMode = "full"): PanelAction | null {
  const p = canvasPoint(u, v);
  return regionsFor(mode).find((r) => inside(p, r))?.id ?? null;
}

/** Whether a ray at this uv stops at the panel (the glass body; in compact mode only the pill), or passes through. */
export function blocksRay(u: number, v: number, mode: PanelMode = "full"): boolean {
  return mode === "compact" ? hitRegion(u, v, mode) !== null : inside(canvasPoint(u, v), BODY);
}

/** The time a point on the scrubber stands for, clamped to the clip. */
export function scrubTime(u: number, duration: number): number {
  const x = u * PANEL.width;
  const ratio = Math.min(1, Math.max(0, (x - TRACK.x0) / (TRACK.x1 - TRACK.x0)));
  return ratio * duration;
}

/** Where the panel opens: 1.1 m ahead along the horizontal view direction and 0.5 m below the eyes (about 24° down). */
export const FOLLOW = { distance: 1.1, drop: 0.5, maxAngleDeg: 30, maxMove: 0.5 } as const;
/** Dragging: how near and far the panel may go, and how fast the thumbstick pushes it, m/s. */
export const DRAG = { minDistance: 0.6, maxDistance: 3, pushSpeed: 1.2 } as const;
/**
 * Where a dragged panel may sit, around the eyes: 0.6–3 m away and from 55° below to 20° above eye level, so it can't
 * be lost overhead or on the floor (the brief: gaze is comfortable from 10° above to 60° below the horizon).
 */
export const PLACE = { minDistance: 0.6, maxDistance: 3, minPitchDeg: -55, maxPitchDeg: 20 } as const;
/** A pinned panel out of view (more than 55° from the gaze) for 2.5 s offers a "Bring controls here" pill in front. */
export const SUMMON = { afterSec: 2.5, offAngleDeg: 55, distance: 1.0, drop: 0.42, metersWide: 0.3 } as const;

/** Keep a world position `p` inside the PLACE band around `eye` (in place). */
export function clampPlacement(p: THREE.Vector3, eye: THREE.Vector3): THREE.Vector3 {
  const dx = p.x - eye.x,
    dy = p.y - eye.y,
    dz = p.z - eye.z;
  const yaw = Math.atan2(dx, dz);
  const pitch = THREE.MathUtils.clamp(
    Math.atan2(dy, Math.hypot(dx, dz)),
    (PLACE.minPitchDeg * Math.PI) / 180,
    (PLACE.maxPitchDeg * Math.PI) / 180,
  );
  const r = THREE.MathUtils.clamp(Math.hypot(dx, dy, dz), PLACE.minDistance, PLACE.maxDistance);
  const horizontal = r * Math.cos(pitch);
  return p.set(eye.x + Math.sin(yaw) * horizontal, eye.y + r * Math.sin(pitch), eye.z + Math.cos(yaw) * horizontal);
}

export function panelTarget(head: THREE.Vector3, forward: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out
    .copy(head)
    .addScaledVector(forward, FOLLOW.distance)
    .setY(head.y - FOLLOW.drop);
}

/**
 * Lazy follow: re-centre when the panel is more than 30° off the horizontal view direction, or the head has moved more
 * than 0.5 m from where it was when the panel was last placed. `forward` is the head's horizontal unit forward.
 */
export function needsRecenter(
  panel: THREE.Vector3,
  head: THREE.Vector3,
  forward: THREE.Vector3,
  placedFrom: THREE.Vector3,
): boolean {
  const dx = panel.x - head.x,
    dz = panel.z - head.z,
    length = Math.hypot(dx, dz);
  if (length < 1e-6) return true;
  const cos = (dx * forward.x + dz * forward.z) / length;
  if (cos < Math.cos((FOLLOW.maxAngleDeg * Math.PI) / 180)) return true;
  return Math.hypot(head.x - placedFrom.x, head.z - placedFrom.z) > FOLLOW.maxMove;
}

/** What the panel shows. */
export interface PanelState {
  title: string;
  playing: boolean;
  time: number;
  duration: number;
  take: string;
  takeIndex: number;
  takeCount: number;
  /** Fork times of the takes on the current path, in seconds, drawn as marks on the scrubber. */
  forks: number[];
  /** Stretches where the recording lost tracking, [from, to] seconds, drawn on the scrubber. */
  gaps: [number, number][];
  status: string;
  room: string;
  holding: boolean;
}

/**
 * The web's frosted glass (glass.css), redrawn for a headset. There is no blur here, so the fill is denser: 0.78 at the
 * top to 0.86 at the bottom keeps text, quiet text included, above 4.5:1 over a white splat. Text is off-white (#EDEDF0, not #FFF) and the
 * primary fill no lighter than #DCDCE0 at rest (#E8E8EC on hover), so bright shapes do not glare through the lenses. White is the one primary
 * action, as on the web; colour only for meaning.
 */
const COLOR = {
  fillTop: "rgba(22, 22, 28, 0.78)",
  fillBottom: "rgba(22, 22, 28, 0.86)",
  text: "#ededf0",
  quiet: "rgba(237, 237, 240, 0.82)",
  primary: "#dcdce0",
  primaryHover: "#e8e8ec",
  primaryPressed: "#c4c4ca",
  onPrimary: "#121216",
  ring: "rgba(237, 237, 240, 0.9)",
  chip: "rgba(255, 255, 255, 0.12)",
  chipHover: "rgba(255, 255, 255, 0.18)",
  chipPressed: "rgba(255, 255, 255, 0.24)",
  track: "rgba(255, 255, 255, 0.2)",
  progress: "#ededf0",
  live: "#34d27b",
  fork: "#ffd27a",
  gap: "rgba(255, 150, 130, 0.8)",
};
const FONT = "-apple-system, BlinkMacSystemFont, Inter, system-ui, 'Segoe UI', Roboto, sans-serif";
/** The grab bar under the panel: drawn size and (larger, invisible) ray target, metres. */
/** The bar sits just under the plane, about 2 cm below the glass edge (the canvas keeps a 24 px clear margin). */
const BAR = { width: 0.12, height: 0.012, hitWidth: 0.26, hitHeight: 0.06, drop: 0.004 } as const;

export type PanelHit =
  | { kind: "bar"; distance: number; point: THREE.Vector3 }
  | { kind: "panel"; action: PanelAction | null; u: number; distance: number; point: THREE.Vector3 };

export class VRPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  hover: PanelAction | "bar" | null = null;
  pressed: PanelAction | null = null;
  mode: PanelMode = "full";
  /** Placed by hand: it stays where it was dropped until recenter(). */
  pinned = false;
  private bar: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private barTarget: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** "Bring controls here": shown in front while a pinned panel is out of view. */
  readonly summon: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private summonCanvas = document.createElement("canvas");
  private summonTexture: THREE.CanvasTexture;
  private summonDrawn = "";
  private outOfView = 0;
  private summonPlaced = false;
  private summonFrom = new THREE.Vector3();
  private summonTarget = new THREE.Vector3();
  private toPanel = new THREE.Vector3();
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private drawn = "";
  private placed = false;
  private moving = false;
  private dragging: { distance: number; offset: THREE.Vector3 } | null = null;
  private placedFrom = new THREE.Vector3();
  private target = new THREE.Vector3();
  private eye = new THREE.Vector3();
  private grabPoint = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private rotation = new THREE.Quaternion();

  constructor(parent: THREE.Object3D, anisotropy = 1) {
    this.canvas.width = PANEL.width * SUPERSAMPLE;
    this.canvas.height = PANEL.height * SUPERSAMPLE;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    // Drawn last and over everything (the guided-mode fog is 1000), so splats or objects passing in front never hide it.
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL.metersWide, PANEL_METERS_HIGH), material);
    this.mesh.renderOrder = 1010;
    this.mesh.visible = false;
    this.mesh.name = "vr-panel";
    const barY = -PANEL_METERS_HIGH / 2 - BAR.drop;
    this.bar = new THREE.Mesh(
      new THREE.PlaneGeometry(BAR.width, BAR.height),
      new THREE.MeshBasicMaterial({
        map: pillTexture(),
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.bar.position.set(0, barY, 0.001);
    this.bar.renderOrder = 1011;
    this.bar.name = "vr-panel-bar";
    // Invisible but hit by rays: material.visible only skips drawing.
    this.barTarget = new THREE.Mesh(
      new THREE.PlaneGeometry(BAR.hitWidth, BAR.hitHeight),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.barTarget.position.set(0, barY, 0);
    this.mesh.add(this.bar, this.barTarget);
    parent.add(this.mesh);
    this.summonCanvas.width = 512 * SUPERSAMPLE;
    this.summonCanvas.height = 128 * SUPERSAMPLE;
    this.summonTexture = new THREE.CanvasTexture(this.summonCanvas);
    this.summonTexture.colorSpace = THREE.SRGBColorSpace;
    this.summonTexture.anisotropy = anisotropy;
    this.summon = new THREE.Mesh(
      new THREE.PlaneGeometry(SUMMON.metersWide, SUMMON.metersWide / 4),
      new THREE.MeshBasicMaterial({
        map: this.summonTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.summon.renderOrder = 1010;
    this.summon.visible = false;
    this.summon.name = "vr-panel-summon";
    parent.add(this.summon);
  }

  /** Hide it and forget where it was; the next follow() places it in front of the head at once. */
  reset(): void {
    this.mesh.visible = false;
    this.placed = false;
    this.moving = false;
    this.pinned = false;
    this.dragging = null;
    this.mode = "full";
    this.hover = null;
    this.pressed = null;
    this.hideSummon();
  }

  /** Bring it back in front of you at the next follow(), following again. */
  recenter(): void {
    this.placed = false;
    this.moving = false;
    this.pinned = false;
    this.dragging = null;
    this.hideSummon();
  }

  private hideSummon(): void {
    this.summon.visible = false;
    this.summonPlaced = false;
    this.outOfView = 0;
  }

  get isDragging(): boolean {
    return this.dragging !== null;
  }

  /** What a ray hits on the panel: the grab bar, a region, a blank part of the glass, or nothing (null). */
  hit(raycaster: THREE.Raycaster): PanelHit | null {
    const summon = this.summon.visible ? raycaster.intersectObject(this.summon, false)[0] : undefined;
    const panel = this.hitPanel(raycaster);
    if (summon?.uv && (!panel || summon.distance < panel.distance))
      return { kind: "panel", action: "summon", u: summon.uv.x, distance: summon.distance, point: summon.point };
    return panel;
  }

  private hitPanel(raycaster: THREE.Raycaster): PanelHit | null {
    if (!this.mesh.visible) return null;
    this.mesh.updateWorldMatrix(true, true);
    if (this.mode !== "compact") {
      const bar = raycaster.intersectObject(this.barTarget, false)[0];
      if (bar) return { kind: "bar", distance: bar.distance, point: bar.point };
    }
    const hit = raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv || !blocksRay(hit.uv.x, hit.uv.y, this.mode)) return null;
    return {
      kind: "panel",
      action: hitRegion(hit.uv.x, hit.uv.y, this.mode),
      u: hit.uv.x,
      distance: hit.distance,
      point: hit.point,
    };
  }

  /**
   * Keep the panel in reach: placed at once the first time, then eased to a new spot only when needed. `head` and
   * `forward` are in the panel's parent (rig) space. `hold` freezes it, while a ray points at it or a scrub is on.
   */
  follow(head: THREE.Vector3, forward: THREE.Vector3, dt: number, hold = false): void {
    this.mesh.visible = true;
    if (this.dragging || this.pinned) return;
    if (!this.placed || (!hold && needsRecenter(this.mesh.position, head, forward, this.placedFrom))) {
      panelTarget(head, forward, this.target);
      this.placedFrom.copy(head);
      this.moving = this.placed;
      this.placed = true;
      if (!this.moving) this.mesh.position.copy(this.target);
    }
    if (this.moving) {
      // Eases in about 0.4 s with no overshoot.
      const k = 1 - Math.exp(-Math.max(0, dt) * 10);
      this.mesh.position.lerp(this.target, k);
      if (this.mesh.position.distanceTo(this.target) < 0.002) {
        this.mesh.position.copy(this.target);
        this.moving = false;
      }
    }
    // Face the eyes, tilted back a little because it sits below them.
    this.mesh.parent?.updateWorldMatrix(true, false);
    this.mesh.lookAt(this.mesh.parent ? this.mesh.parent.localToWorld(this.eye.copy(head)) : this.eye.copy(head));
  }

  /** Start dragging from a ray hit on the bar: the grabbed spot stays under the ray. */
  beginDrag(ray: THREE.Ray, point: THREE.Vector3): void {
    this.mesh.updateWorldMatrix(true, false);
    this.dragging = { distance: ray.origin.distanceTo(point), offset: this.mesh.worldToLocal(point.clone()) };
    this.moving = false;
  }

  /** Follow the ray while dragging, facing `eye` (world space). `push` in [-1, 1] moves it away (+) or closer (−). */
  dragTo(ray: THREE.Ray, eye: THREE.Vector3, push: number, dt: number): void {
    const drag = this.dragging;
    if (!drag) return;
    if (Math.abs(push) > 0.2)
      drag.distance = THREE.MathUtils.clamp(
        drag.distance + push * DRAG.pushSpeed * dt,
        DRAG.minDistance,
        DRAG.maxDistance,
      );
    ray.at(drag.distance, this.grabPoint);
    const parent = this.mesh.parent;
    // Twice: turning to face the eyes moves the grabbed spot, so place it again with the new turn.
    for (let i = 0; i < 2; i++) {
      this.mesh.getWorldQuaternion(this.rotation);
      this.offset.copy(drag.offset).applyQuaternion(this.rotation);
      this.target.subVectors(this.grabPoint, this.offset);
      clampPlacement(this.target, eye);
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parent.worldToLocal(this.target);
      }
      this.mesh.position.copy(this.target);
      this.mesh.updateWorldMatrix(true, false);
      this.mesh.lookAt(eye);
      this.mesh.updateWorldMatrix(true, false);
    }
  }

  /** Drop it where it is; it stays there. */
  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = null;
    this.pinned = true;
    this.placed = true;
  }

  /**
   * While a pinned panel has been out of view for a moment, offer "Bring controls here" low in front of you (it follows
   * lazily, like the panel). `head`, `forward` (horizontal) and `gaze` (the view direction) are in the rig's space.
   */
  updateSummon(head: THREE.Vector3, forward: THREE.Vector3, gaze: THREE.Vector3, dt: number): void {
    const lost =
      this.pinned &&
      !this.dragging &&
      this.mesh.visible &&
      this.mode !== "compact" &&
      this.toPanel.subVectors(this.mesh.position, head).angleTo(gaze) > (SUMMON.offAngleDeg * Math.PI) / 180;
    this.outOfView = lost ? this.outOfView + Math.max(0, dt) : 0;
    if (this.outOfView < SUMMON.afterSec) {
      this.summon.visible = false;
      this.summonPlaced = false;
      return;
    }
    this.summon.visible = true;
    const spot = this.summonTarget;
    if (!this.summonPlaced || needsRecenter(this.summon.position, head, forward, this.summonFrom)) {
      spot
        .copy(head)
        .addScaledVector(forward, SUMMON.distance)
        .setY(head.y - SUMMON.drop);
      this.summonFrom.copy(head);
      if (!this.summonPlaced) this.summon.position.copy(spot);
      this.summonPlaced = true;
    }
    this.summon.position.lerp(spot, 1 - Math.exp(-Math.max(0, dt) * 10));
    this.summon.parent?.updateWorldMatrix(true, false);
    this.summon.lookAt(this.summon.parent ? this.summon.parent.localToWorld(this.eye.copy(head)) : this.eye.copy(head));
    const hover = this.hover === "summon";
    const key = String(hover);
    if (key === this.summonDrawn) return;
    this.summonDrawn = key;
    const ctx = this.summonCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(SUPERSAMPLE, 0, 0, SUPERSAMPLE, 0, 0);
    ctx.clearRect(0, 0, 512, 128);
    glass(ctx, 12, 12, 488, 104, 52);
    if (hover) {
      roundRect(ctx, 12, 12, 488, 104, 52);
      ctx.fillStyle = COLOR.chipHover;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = COLOR.ring;
      ctx.stroke();
    }
    ctx.textAlign = "center";
    text(ctx, "Bring controls here", 256, 64, `600 40px ${FONT}`, COLOR.text);
    ctx.textAlign = "left";
    this.summonTexture.needsUpdate = true;
  }

  /** Redraw only when something on it changed. */
  draw(state: PanelState): void {
    const ratio = state.duration > 0 ? Math.min(1, Math.max(0, state.time / state.duration)) : 0;
    const knob = Math.round(TRACK.x0 + ratio * (TRACK.x1 - TRACK.x0));
    // Keyed on the 0.1 s clock text, not the knob's pixel: during playback it redraws at most 10 times a second.
    const key = JSON.stringify([
      this.mode,
      this.hover,
      this.pressed,
      state.title,
      state.playing,
      timeText(state),
      state.take,
      state.takeIndex,
      state.takeCount,
      state.forks,
      state.gaps,
      state.status,
      state.room,
    ]);
    this.bar.material.opacity = this.hover === "bar" || this.dragging ? 0.95 : 0.55;
    this.bar.scale.x = this.hover === "bar" || this.dragging ? 1.25 : 1;
    this.bar.visible = this.mode !== "compact";
    if (key === this.drawn) return;
    this.drawn = key;
    const ctx = this.context;
    ctx.setTransform(SUPERSAMPLE, 0, 0, SUPERSAMPLE, 0, 0);
    ctx.clearRect(0, 0, PANEL.width, PANEL.height);
    if (this.mode === "compact") {
      const pill = COMPACT_REGIONS[0];
      glass(ctx, pill.x + 8, pill.y + 8, pill.w - 16, pill.h - 16, (pill.h - 16) / 2);
      this.chip(pill, "Show controls", { size: 30 });
      this.texture.needsUpdate = true;
      return;
    }
    glass(ctx, BODY.x, BODY.y, BODY.w, BODY.h, BODY.radius);
    // Header: the memory's title, Help and Hide.
    text(
      ctx,
      fit(ctx, this.mode === "help" ? "How to use" : state.title, 680, `600 36px ${FONT}`),
      56,
      80,
      `600 36px ${FONT}`,
      COLOR.text,
    );
    this.chip(HELP, this.mode === "help" ? "Back" : "Help");
    this.chip(HIDE, "Hide");
    if (this.mode === "help") this.drawHelp();
    else this.drawControls(state, ratio, knob);
    this.texture.needsUpdate = true;
  }

  private drawControls(state: PanelState, ratio: number, knobX: number): void {
    const ctx = this.context;
    this.chip(REGIONS[2], state.playing ? "Pause" : "Play", {
      primary: true,
      icon: state.playing ? "pause" : "play",
      size: 34,
    });
    this.chip(REGIONS[3], "−1 s");
    this.chip(REGIONS[4], "+1 s");
    ctx.textAlign = "right";
    text(ctx, timeText(state), 984, 184, `600 40px ${FONT}`, COLOR.text);
    ctx.textAlign = "left";
    // Scrubber: track, lost-tracking gaps, progress, take fork marks, knob.
    const scrub = REGIONS[5],
      active = this.hover === "scrub" || this.pressed === "scrub";
    if (active) {
      roundRect(ctx, scrub.x + 8, scrub.y + 8, scrub.w - 16, scrub.h - 16, 20);
      ctx.fillStyle = COLOR.chip;
      ctx.fill();
    }
    const at = (t: number) =>
      TRACK.x0 + Math.min(1, Math.max(0, state.duration > 0 ? t / state.duration : 0)) * (TRACK.x1 - TRACK.x0);
    ctx.lineCap = "round";
    ctx.lineWidth = 10;
    line(ctx, TRACK.x0, TRACK.x1, TRACK.y, COLOR.track);
    line(ctx, TRACK.x0, TRACK.x0 + ratio * (TRACK.x1 - TRACK.x0), TRACK.y, COLOR.progress);
    ctx.lineCap = "butt";
    for (const [from, to] of state.gaps) line(ctx, at(from), Math.max(at(to), at(from) + 4), TRACK.y, COLOR.gap);
    ctx.fillStyle = COLOR.fork;
    for (const fork of state.forks) {
      roundRect(ctx, at(fork) - 3, TRACK.y - 30, 6, 28, 3);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(knobX, TRACK.y, this.pressed === "scrub" ? 21 : 18, 0, Math.PI * 2);
    // Canvas shadows ignore the transform, so they are scaled by hand.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 8 * SUPERSAMPLE;
    ctx.shadowOffsetY = 2 * SUPERSAMPLE;
    ctx.fillStyle = COLOR.text;
    ctx.fill();
    ctx.restore();
    if (active) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = COLOR.ring;
      ctx.stroke();
    }
    // Takes: ‹ name › and Original.
    const single = state.takeCount < 2;
    this.chip(REGIONS[6], "", { icon: "left", disabled: single });
    this.chip(REGIONS[7], "", { icon: "right", disabled: single });
    this.chip(REGIONS[8], "Original", { disabled: state.takeIndex === 0 });
    ctx.textAlign = "center";
    text(ctx, fit(ctx, state.take, 480, `600 32px ${FONT}`), 376, 372, `600 32px ${FONT}`, COLOR.text);
    text(
      ctx,
      state.takeCount > 1 ? `take ${state.takeIndex + 1} of ${state.takeCount}` : "no takes yet: pause and throw",
      376,
      408,
      `500 24px ${FONT}`,
      COLOR.quiet,
    );
    // Status (left) and room (right).
    ctx.textAlign = "right";
    const roomFont = `500 24px ${FONT}`,
      room = fit(ctx, state.room, 300, roomFont);
    text(ctx, room, 984, 456, roomFont, COLOR.quiet);
    ctx.font = roomFont;
    const roomWidth = ctx.measureText(room).width;
    ctx.textAlign = "left";
    const statusFont = `600 26px ${FONT}`;
    // A small dot says whether time runs (green) or is frozen (amber), next to the status line.
    ctx.beginPath();
    ctx.arc(64, 456, 7, 0, Math.PI * 2);
    ctx.fillStyle = state.playing ? COLOR.live : COLOR.fork;
    ctx.fill();
    text(ctx, fit(ctx, state.status, 928 - roomWidth - 48, statusFont), 80, 456, statusFont, COLOR.text);
  }

  private drawHelp(): void {
    const ctx = this.context;
    const lines = [
      "Pause with A or X, then point at an object.",
      "Hold grip or pinch to grab. Move, then let go to throw.",
      "Each throw makes a new take; ‹ › switch takes.",
      "Drag the bar under this panel to move it.",
      "B or Y hides it; click the right stick to bring it back.",
    ];
    lines.forEach((line, i) => text(ctx, line, 56, 168 + i * 40, `500 28px ${FONT}`, i < 3 ? COLOR.text : COLOR.quiet));
    text(ctx, "Left stick walks · right stick turns", 56, 384, `500 24px ${FONT}`, COLOR.quiet);
    this.chip(HELP_REGIONS[2], "Exit VR");
  }

  /** A button: a chip drawn 8 px inside its hit region, lighter on hover, accent when pressed. */
  private chip(
    r: Region,
    label: string,
    options: { primary?: boolean; icon?: "play" | "pause" | "left" | "right"; disabled?: boolean; size?: number } = {},
  ): void {
    const ctx = this.context;
    const hover = this.hover === r.id && !options.disabled,
      pressed = this.pressed === r.id && !options.disabled;
    const inset = pressed ? 10 : 8;
    ctx.save();
    ctx.globalAlpha = options.disabled ? 0.35 : 1;
    roundRect(ctx, r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, Math.min(24, (r.h - inset * 2) / 2));
    const filled = !!options.primary;
    ctx.fillStyle = filled
      ? pressed
        ? COLOR.primaryPressed
        : hover
          ? COLOR.primaryHover
          : COLOR.primary
      : pressed
        ? COLOR.chipPressed
        : hover
          ? COLOR.chipHover
          : COLOR.chip;
    ctx.fill();
    if (hover && filled) {
      // On the light fill a ring reads only outside it.
      const out = 5,
        rr = Math.min(24, (r.h - inset * 2) / 2) + out;
      roundRect(ctx, r.x + inset - out, r.y + inset - out, r.w - (inset - out) * 2, r.h - (inset - out) * 2, rr);
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR.ring;
      ctx.stroke();
    } else if (hover) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR.ring;
      ctx.stroke();
    }
    const ink = filled ? COLOR.onPrimary : COLOR.text;
    const cx = r.x + r.w / 2,
      cy = r.y + r.h / 2;
    const font = `600 ${options.size ?? 30}px ${FONT}`;
    if (options.icon === "left" || options.icon === "right") {
      chevron(ctx, cx, cy, options.icon === "left" ? -1 : 1, ink);
    } else if (options.icon) {
      ctx.font = font;
      const width = ctx.measureText(label).width,
        iconWidth = 26,
        gap = 14;
      const x0 = cx - (iconWidth + gap + width) / 2;
      glyph(ctx, options.icon, x0, cy, ink);
      ctx.textAlign = "left";
      text(ctx, label, x0 + iconWidth + gap, cy, font, ink);
    } else {
      ctx.textAlign = "center";
      text(ctx, label, cx, cy, font, ink);
    }
    ctx.restore();
    ctx.textAlign = "left";
  }

  setDimmed(dimmed: boolean): void {
    this.mesh.material.opacity = dimmed ? 0.45 : 1;
  }

  dispose(): void {
    this.summon.removeFromParent();
    this.summon.geometry.dispose();
    this.summon.material.dispose();
    this.summonTexture.dispose();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.bar.geometry.dispose();
    this.bar.material.map?.dispose();
    this.bar.material.dispose();
    this.barTarget.geometry.dispose();
    this.barTarget.material.dispose();
  }
}

function timeText(state: PanelState): string {
  return `${state.time.toFixed(1)} / ${state.duration.toFixed(1)} s`;
}

/**
 * Faux glass (a real blur costs an extra scene render per eye): a soft shadow outside the shape only, a dark fill that
 * deepens towards the bottom, a sheen over the top half and a 2 px rim that is brighter at the top.
 */
function glass(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 32 * SUPERSAMPLE;
  ctx.shadowOffsetY = 6 * SUPERSAMPLE;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
  // Cut the shape (and the shadow under it) back out, so the fill keeps its own translucency.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
  const fill = ctx.createLinearGradient(0, y, 0, y + h);
  fill.addColorStop(0, COLOR.fillTop);
  fill.addColorStop(1, COLOR.fillBottom);
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  const sheen = ctx.createLinearGradient(0, y, 0, y + h / 2);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.06)");
  sheen.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = sheen;
  ctx.fill();
  const rim = ctx.createLinearGradient(0, y, 0, y + h);
  rim.addColorStop(0, "rgba(255, 255, 255, 0.42)");
  rim.addColorStop(1, "rgba(255, 255, 255, 0.14)");
  roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, r - 1.5);
  ctx.lineWidth = 3;
  ctx.strokeStyle = rim;
  ctx.stroke();
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, font: string, color: string): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(value, x, y + 1);
}

function line(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

function chevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, direction: -1 | 1, color: string): void {
  ctx.save();
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - 6 * direction, cy - 14);
  ctx.lineTo(cx + 8 * direction, cy);
  ctx.lineTo(cx - 6 * direction, cy + 14);
  ctx.stroke();
  ctx.restore();
}

/** Play triangle or pause bars, 26 px wide, left edge at x. */
function glyph(ctx: CanvasRenderingContext2D, icon: "play" | "pause", x: number, cy: number, color: string): void {
  ctx.fillStyle = color;
  if (icon === "play") {
    ctx.beginPath();
    ctx.moveTo(x + 2, cy - 15);
    ctx.lineTo(x + 26, cy);
    ctx.lineTo(x + 2, cy + 15);
    ctx.closePath();
    ctx.fill();
  } else {
    roundRect(ctx, x + 2, cy - 15, 8, 30, 2);
    ctx.fill();
    roundRect(ctx, x + 16, cy - 15, 8, 30, 2);
    ctx.fill();
  }
}

/** The grab bar's look: a white pill on a small canvas. */
function pillTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    roundRect(ctx, 2, 2, 252, 28, 14);
    ctx.fillStyle = COLOR.text;
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shorten text with an ellipsis so it fits `max` pixels in `font`. */
function fit(ctx: CanvasRenderingContext2D, value: string, max: number, font?: string): string {
  if (font) ctx.font = font;
  if (ctx.measureText(value).width <= max) return value;
  let cut = value;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
  return `${cut}…`;
}
