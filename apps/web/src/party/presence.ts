import * as THREE from "three";
import type { Identity } from "spacetimedb";
import type { Player } from "../net";

// How the other players appear (heads, hands, name tags) and which device this player reports.

export type Device = "quest" | "phone" | "desktop";

export function deviceKind(presenting: boolean, userAgent: string, touch: boolean): Device {
  if (presenting || /OculusBrowser|Quest/i.test(userAgent)) return "quest";
  return touch ? "phone" : "desktop";
}

/** A readable avatar color from the server's per-identity u32. */
export function playerColor(value: number): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(value & 0xffffff).getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, 0.65, 0.62);
}

/** Hands are shown only for headset players whose hand rows differ from the head (others send the head). */
export function handVisible(device: string, head: THREE.Vector3, hand: THREE.Vector3): boolean {
  const d = hand.distanceTo(head);
  return device === "quest" && d > 0.05 && d < 1.5;
}

interface Avatar {
  root: THREE.Group;
  head: THREE.Group;
  left: THREE.Mesh;
  right: THREE.Mesh;
  label: THREE.Sprite;
  material: THREE.MeshStandardMaterial;
  labelKey: string;
  fresh: boolean;
}

/** Avatars closer than this to your own camera are hidden: everyone starts at the same camera pose, so another
 * player who hasn't moved yet would otherwise sit on your camera and cover the view. */
export const HIDE_NEAR_M = 0.6;

/** Head spheres (with a visor showing where they look), hands and name tags for the other players. */
export class Avatars {
  readonly group = new THREE.Group();
  private items = new Map<string, Avatar>();
  private headGeometry = new THREE.SphereGeometry(0.12, 20, 14);
  private visorGeometry = new THREE.BoxGeometry(0.15, 0.045, 0.05);
  private handGeometry = new THREE.SphereGeometry(0.04, 12, 8);
  private visorMaterial = new THREE.MeshBasicMaterial({ color: 0x0a0a0f });
  private position = new THREE.Vector3();
  private rotation = new THREE.Quaternion();
  private hand = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.group.name = "avatars";
    scene.add(this.group);
  }

  get size(): number {
    return this.items.size;
  }

  /** viewpoint: your camera's world position, to hide avatars that sit on it. */
  update(players: Player[], self: Identity | undefined, dt: number, viewpoint?: THREE.Vector3): void {
    const seen = new Set<string>();
    const k = 1 - Math.exp(-Math.max(0, dt) * 12);
    for (const p of players) {
      if (!p.online || (self && p.identity.isEqual(self))) continue;
      const id = p.identity.toHexString();
      seen.add(id);
      const avatar = this.items.get(id) ?? this.create(id);
      const color = playerColor(p.color);
      avatar.material.color.copy(color);
      const labelKey = `${p.name}|${p.device}|${color.getHexString()}`;
      if (labelKey !== avatar.labelKey) {
        avatar.labelKey = labelKey;
        this.drawLabel(avatar.label, p.name, p.device, color);
      }
      this.position.set(p.hx, p.hy, p.hz);
      this.rotation.set(p.hqx, p.hqy, p.hqz, p.hqw);
      if (this.rotation.lengthSq() < 1e-6) this.rotation.identity();
      this.rotation.normalize();
      const head = avatar.head;
      if (avatar.fresh) {
        head.position.copy(this.position);
        head.quaternion.copy(this.rotation);
      } else {
        head.position.lerp(this.position, k);
        head.quaternion.slerp(this.rotation, k);
      }
      avatar.label.position.copy(head.position).y += 0.27;
      avatar.root.visible = !viewpoint || head.position.distanceTo(viewpoint) > HIDE_NEAR_M;
      for (const [mesh, x, y, z] of [
        [avatar.left, p.lx, p.ly, p.lz],
        [avatar.right, p.rx, p.ry, p.rz],
      ] as const) {
        this.hand.set(x, y, z);
        mesh.visible = handVisible(p.device, this.position, this.hand);
        if (!mesh.visible) continue;
        if (avatar.fresh) mesh.position.copy(this.hand);
        else mesh.position.lerp(this.hand, k);
      }
      avatar.fresh = false;
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) this.remove(id);
  }

  private create(id: string): Avatar {
    const root = new THREE.Group();
    root.name = `avatar-${id.slice(0, 8)}`;
    const material = new THREE.MeshStandardMaterial({ roughness: 0.5 });
    const head = new THREE.Group();
    head.add(new THREE.Mesh(this.headGeometry, material));
    const visor = new THREE.Mesh(this.visorGeometry, this.visorMaterial);
    visor.position.set(0, 0.015, -0.1); // cameras look down -Z
    head.add(visor);
    const left = new THREE.Mesh(this.handGeometry, material);
    const right = new THREE.Mesh(this.handGeometry, material);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    label.scale.set(0.6, 0.15, 1);
    root.add(head, left, right, label);
    this.group.add(root);
    const avatar = {
      root,
      head,
      left,
      right,
      label,
      material,
      labelKey: "",
      fresh: true,
    };
    this.items.set(id, avatar);
    return avatar;
  }

  private drawLabel(sprite: THREE.Sprite, name: string, device: string, color: THREE.Color) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "rgba(22, 22, 28, 0.82)";
      ctx.beginPath();
      ctx.roundRect(8, 16, 496, 96, 40);
      ctx.fill();
      ctx.fillStyle = `#${color.getHexString()}`;
      ctx.beginPath();
      ctx.arc(64, 64, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ededf0";
      ctx.font = "600 44px Inter, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(`${name} · ${device}`, 100, 66, 390);
    }
    const material = sprite.material;
    material.map?.dispose();
    material.map = new THREE.CanvasTexture(canvas);
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.needsUpdate = true;
  }

  private remove(id: string) {
    const avatar = this.items.get(id);
    if (!avatar) return;
    avatar.root.removeFromParent();
    avatar.material.dispose();
    avatar.label.material.map?.dispose();
    avatar.label.material.dispose();
    this.items.delete(id);
  }

  clear(): void {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.headGeometry.dispose();
    this.visorGeometry.dispose();
    this.handGeometry.dispose();
    this.visorMaterial.dispose();
  }
}
