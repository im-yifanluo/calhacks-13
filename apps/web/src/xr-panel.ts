import * as THREE from "three";
import type { Viewer } from "./viewer.js";

export type PanelAction = "play" | "restart" | "previous" | "next" | "original" | "recenter" | "collapse" | "expand" | "help" | "library" | "exit" | "seek";
export interface PanelRegion { action: PanelAction; x: number; y: number; width: number; height: number }
export const PANEL_WIDTH = 1200;
export const PANEL_HEIGHT = 840;
const region = (action: PanelAction, x: number, y: number, width: number, height: number): PanelRegion => ({ action, x, y, width, height });
const navigation = [region("recenter", 48, 716, 260, 76), region("library", 324, 716, 260, 76), region("exit", 600, 716, 260, 76), region("help", 876, 716, 276, 76)];
const transport = [region("seek", 48, 204, 1104, 88), region("play", 48, 320, 352, 92), region("restart", 416, 320, 352, 92), region("original", 784, 320, 368, 92), region("previous", 48, 466, 136, 92), region("next", 1016, 466, 136, 92)];
const collapse = region("collapse", 1008, 40, 144, 76);
const expand = region("expand", 360, 716, 480, 88);

export function panelRegions(compact: boolean, help: boolean): readonly PanelRegion[] {
  return compact ? [expand] : help ? [collapse, ...navigation] : [collapse, ...transport, ...navigation];
}

export function hitPanel(u: number, v: number, compact = false, help = false): PanelRegion | undefined {
  const x = u * PANEL_WIDTH, y = (1 - v) * PANEL_HEIGHT;
  return panelRegions(compact, help).find(r => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
}

export function timelineFraction(u: number): number {
  return THREE.MathUtils.clamp((u * PANEL_WIDTH - 48) / 1104, 0, 1);
}

/** Position relative to the user's eyes, preserving a level panel for seated and standing viewers. */
export function placePanel(panel: THREE.Object3D, head: THREE.Object3D): void {
  const position = head.getWorldPosition(new THREE.Vector3());
  const rotation = new THREE.Euler().setFromQuaternion(head.getWorldQuaternion(new THREE.Quaternion()), "YXZ");
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation.y);
  position.add(new THREE.Vector3(0, -0.22, -1.4).applyQuaternion(yaw));
  if (panel.parent) {
    panel.parent.updateWorldMatrix(true, false);
    panel.position.copy(panel.parent.worldToLocal(position));
    panel.quaternion.copy(panel.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(yaw));
  } else { panel.position.copy(position); panel.quaternion.copy(yaw); }
  panel.updateWorldMatrix(false, true);
}

export function runPlaybackAction(viewer: Viewer, action: PanelAction, fraction = 0): void {
  if (viewer.held) return;
  const timeline = viewer.timeline;
  switch (action) {
    case "play": viewer.togglePlay(); break;
    case "restart": viewer.seek(0); break;
    case "original": viewer.selectBranch("original"); break;
    case "seek": viewer.seek(fraction * timeline.duration); break;
    case "previous":
    case "next": {
      const index = timeline.branches.findIndex(b => b.id === timeline.activeId);
      const direction = action === "next" ? 1 : -1;
      const next = (index + direction + timeline.branches.length) % timeline.branches.length;
      viewer.selectBranch(timeline.branches[next].id); break;
    }
  }
}

export class XRPanel {
  readonly canvas = document.createElement("canvas");
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  compact = false;
  help = false;
  hover: PanelAction | null = null;
  private context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private previous = "";

  constructor() {
    this.canvas.width = PANEL_WIDTH; this.canvas.height = PANEL_HEIGHT;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("The headset controls need a canvas context.");
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false; this.texture.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.12, 0.784), new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.mesh.renderOrder = 1000; this.mesh.visible = false;
  }

  hit(raycaster: THREE.Raycaster): { uv: THREE.Vector2; distance: number; region: PanelRegion | undefined } | undefined {
    if (!this.mesh.visible) return;
    this.mesh.updateWorldMatrix(true, false);
    const hit = raycaster.intersectObject(this.mesh)[0];
    if (!hit?.uv) return;
    const region = hitPanel(hit.uv.x, hit.uv.y, this.compact, this.help);
    // The collapsed panel is transparent outside its restore button.
    if (this.compact && !region) return;
    return { uv: hit.uv, distance: hit.distance, region };
  }

  draw(viewer: Viewer, notice: string, target: string): void {
    const tl = viewer.timeline;
    const state = viewer.held ? "Holding" : viewer.recording ? "Recording throw" : tl.playing ? "Playing" : "Paused";
    const signature = JSON.stringify([Math.floor(tl.time * 10), tl.activeId, tl.branches.length, state, notice, target, this.hover, this.compact, this.help]);
    if (signature === this.previous) return;
    this.previous = signature;
    const ctx = this.context;
    ctx.clearRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    if (this.compact) { this.button(expand, "Show controls", false); this.texture.needsUpdate = true; return; }
    this.box(0, 0, PANEL_WIDTH, PANEL_HEIGHT, "#f4f2eb", 24);
    this.text("MEMORY REPLAY", 48, 66, 24, "#686b60", 600);
    this.text(viewer.memory.manifest.title, 48, 120, 39, "#282b25", 500, 910);
    this.button(collapse, "Hide");
    if (this.help) {
      this.text("Make a different take", 48, 214, 38, "#282b25", 500);
      const instructions = [
        ["01", "Pause at the moment you want to change."],
        ["02", "Point at an object. Hold grip, or pinch with hands."],
        ["03", "Move, then release. Your edit makes a new take."],
        ["04", "Press Play to replay it. Original is always kept."],
      ];
      instructions.forEach(([number, label], i) => {
        this.text(number, 48, 290 + i * 64, 27, "#b44827", 600);
        this.text(label, 112, 290 + i * 64, 29, "#282b25", 400, 1028);
      });
      this.text("A / X  Play or pause     B / Y  Hide or show controls", 48, 582, 26, "#686b60");
      this.text("Left stick  Walk     Right stick  Turn     Click right stick  Recenter", 48, 628, 25, "#686b60");
      this.text("Library returns to the browser. Choose a memory, then enter VR again.", 48, 670, 23, "#686b60");
    } else {
      this.text(state, 48, 182, 26, "#b44827", 600);
      this.text(`${tl.time.toFixed(1)} / ${tl.duration.toFixed(1)} s`, 920, 182, 26, "#686b60");
      this.box(48, 240, 1104, 12, "#c4c6ba", 6);
      const progress = THREE.MathUtils.clamp(tl.time / tl.duration, 0, 1);
      if (progress > 0) this.box(48, 240, 1104 * progress, 12, "#b44827", 6);
      for (const branch of tl.branches.slice(1)) {
        this.box(46 + branch.forkTime / tl.duration * 1104, 264, 4, 14, "#b44827", 2);
      }
      ctx.fillStyle = this.hover === "seek" ? "#7d301c" : "#b44827";
      ctx.beginPath(); ctx.arc(48 + 1104 * progress, 246, this.hover === "seek" ? 20 : 15, 0, Math.PI * 2); ctx.fill();
      for (const r of transport) {
        if (r.action === "seek") continue;
        const label = r.action === "play" ? (tl.playing ? "Pause" : "Play") : r.action === "restart" ? "Restart" : r.action === "original" ? "Original" : r.action === "previous" ? "‹" : "›";
        this.button(r, label, r.action === "play", !!viewer.held || ((r.action === "next" || r.action === "previous") && tl.branches.length < 2));
      }
      this.text("TAKE", 210, 484, 21, "#686b60", 600);
      this.text(tl.active.name, 210, 530, 34, "#282b25", 500, 620);
      this.text(`${tl.branches.findIndex(b => b.id === tl.activeId) + 1} / ${tl.branches.length}`, 872, 520, 25, "#686b60");
      const prompt = viewer.held ? `Holding ${viewer.held.definition.label} · release to throw` : target ? `${target} · ${tl.playing ? "pause to grab" : "hold grip or pinch to grab"}` : "Pause. Move an object. See what happens next.";
      this.text(prompt, 48, 612, 29, "#282b25", 500, 1104);
      this.text(notice, 48, 658, 23, "#686b60", 400, 1104);
    }
    for (const r of navigation) this.button(r, r.action === "recenter" ? "Recenter" : r.action === "library" ? "Library ↗" : r.action === "exit" ? "Leave VR" : this.help ? "Back" : "How to use");
    this.texture.needsUpdate = true;
  }

  private box(x: number, y: number, width: number, height: number, fill: string, radius = 12): void {
    this.context.fillStyle = fill; this.context.beginPath(); this.context.roundRect(x, y, width, height, radius); this.context.fill();
  }

  private text(value: string, x: number, y: number, size: number, fill: string, weight = 400, maxWidth?: number): void {
    const ctx = this.context; ctx.font = `${weight} ${size}px system-ui, sans-serif`; ctx.fillStyle = fill;
    let line = value;
    if (maxWidth && ctx.measureText(line).width > maxWidth) {
      while (line.length && ctx.measureText(`${line}…`).width > maxWidth) line = line.slice(0, -1);
      line += "…";
    }
    ctx.fillText(line, x, y);
  }

  private button(r: PanelRegion, label: string, primary = false, disabled = false): void {
    const hover = this.hover === r.action && !disabled;
    this.context.globalAlpha = disabled ? 0.4 : 1;
    this.box(r.x, r.y, r.width, r.height, primary ? hover ? "#913a20" : "#b44827" : hover ? "#d8dbce" : "#e6e7de");
    this.context.textAlign = "center";
    this.text(label, r.x + r.width / 2, r.y + r.height / 2 + 11, 31, primary ? "#fffaf4" : "#282b25", 500);
    this.context.textAlign = "left"; this.context.globalAlpha = 1;
  }

  dispose(): void {
    this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose();
  }
}
