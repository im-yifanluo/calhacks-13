// Shared-room panel and presence: connection, name, rooms, library, upload, people and avatars.
// Extracted from jerry's main.ts (origin/stdb/jerry-p4). Playback, takes and grabbing stay in nikko's
// viewer and HUD; net/adapter.ts syncs those with the server while this page is in a room.
import * as THREE from "three";
import type { Identity } from "spacetimedb";
import type { MemoryManifest } from "@memreplay/shared";
import { Multiplayer, type Player } from "./net/index.js";
import { NetAdapter } from "./net/adapter.js";
import { validateManifest } from "./loader.js";
import { isTouchDevice } from "./phone-joystick.js";
import { uploadPanel } from "./upload.js";
import type { Viewer } from "./viewer.js";

/** main.ts loads this manifest when the URL has no ?memory= (its built-in demo). */
export const DEFAULT_MANIFEST = "/mock/memory.json";
/** sessionStorage: the room URL this tab last reloaded into to open the room's memory. */
export const RELOAD_GUARD_KEY = "memreplay-room-reload";
const NAME_KEY = "memreplay-name";
/** 12.5 Hz: the head-pose rate net.sendPose allows. */
const POSE_INTERVAL_MS = 80;
/** An unchanged pose is re-sent this often, in case a send was dropped. */
const POSE_REFRESH_MS = 1000;

export type Device = "quest" | "phone" | "desktop";

export const normalizeCode = (code: string | null | undefined) =>
  (code ?? "").trim().toUpperCase();

/** The manifest this page loaded, as main.ts picks it: ?memory=, else the demo default. Absolute. */
export function loadedManifest(href: string): string {
  const url = new URL(href);
  return new URL(url.searchParams.get("memory") ?? DEFAULT_MANIFEST, url).href;
}

export function sameManifest(a: string, b: string, base: string): boolean {
  return new URL(a, base).href === new URL(b, base).href;
}

/**
 * This page's URL for room `code` (null: no room). `memory` replaces ?memory= when the room shows
 * another memory; otherwise the page's own ?memory= is kept, so a copied link opens the same scene.
 */
export function roomUrl(
  href: string,
  code: string | null,
  memory?: string,
): string {
  const url = new URL(href);
  if (url.pathname === "/upload") url.pathname = "/";
  if (memory !== undefined) url.searchParams.set("memory", memory);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  url.hash = "";
  return url.href;
}

/** One automatic reload per target URL per tab, so a manifest that never matches cannot loop. */
export function claimReload(
  storage: Pick<Storage, "getItem" | "setItem">,
  target: string,
): boolean {
  if (storage.getItem(RELOAD_GUARD_KEY) === target) return false;
  storage.setItem(RELOAD_GUARD_KEY, target);
  return true;
}

export function deviceKind(
  presenting: boolean,
  userAgent: string,
  touch: boolean,
): Device {
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
export function handVisible(
  device: string,
  head: THREE.Vector3,
  hand: THREE.Vector3,
): boolean {
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
  private visorMaterial = new THREE.MeshBasicMaterial({ color: 0x0c151e });
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
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthWrite: false }),
    );
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

  private drawLabel(
    sprite: THREE.Sprite,
    name: string,
    device: string,
    color: THREE.Color,
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#101e29d9";
      ctx.beginPath();
      ctx.roundRect(8, 16, 496, 96, 40);
      ctx.fill();
      ctx.fillStyle = `#${color.getHexString()}`;
      ctx.beginPath();
      ctx.arc(64, 64, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e7f0f3";
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

export interface SessionHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** The user camera. In VR it sits under the rig; its world pose is the head pose. */
  camera: THREE.PerspectiveCamera;
  /** The manifest main.ts loads, as written (?memory=, or the demo default). */
  manifestUrl: string;
  /** Shows a message in the viewer's status line. */
  showStatus(message: string): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const setText = (element: Element | null, text: string) => {
  if (element && element.textContent !== text) element.textContent = text;
};

/**
 * Owns the multiplayer connection and the room panel. While this page is in a room it installs
 * NetAdapter as the viewer's authority; outside a room the viewer stays a local session. Every
 * room change other than the first join of a fresh page reloads, so local takes never mix with a
 * room's takes and the adapter never has to be removed.
 */
export class Session {
  readonly net = new Multiplayer();
  adapter?: NetAdapter;
  private viewer?: Viewer;
  private readonly avatars: Avatars;
  /** ?room= of this page; cleared when that room cannot be joined. */
  private urlRoom: string;
  /** The room this page is in ("" while it is a local session). */
  private room = "";
  private busy = false;
  private adding = false;
  private navigating = false;
  private firstReady = true;
  private wasReady = false;
  private readyCycle = 0;
  private rejoinCycle = 0;
  private profileDirty = false;
  private selectRequest = "";
  private message = "";
  private memoryKey = "";
  private peopleKey = "";
  private poseSentAt = -Infinity;
  private lastPose: number[] = [];
  private handedness: (string | undefined)[] = [];
  private head = new THREE.Vector3();
  private readonly viewpoint = new THREE.Vector3();
  private headRotation = new THREE.Quaternion();
  private hands = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly ui = {
    panel: $("room-panel"),
    toggle: $<HTMLButtonElement>("room-toggle"),
    summary: $("room-summary"),
    connection: $("room-connection"),
    name: $<HTMLInputElement>("player-name"),
    memories: $<HTMLSelectElement>("room-memories"),
    create: $<HTMLButtonElement>("room-create"),
    uploadToggle: $<HTMLButtonElement>("upload-toggle"),
    code: $<HTMLInputElement>("room-code"),
    join: $<HTMLButtonElement>("room-join"),
    label: $("room-label"),
    people: $("room-people"),
    copy: $<HTMLButtonElement>("room-copy-link"),
    leave: $<HTMLButtonElement>("room-leave"),
    libraryUrl: $<HTMLInputElement>("library-url"),
    libraryAdd: $<HTMLButtonElement>("library-add"),
    upload: $("upload-panel"),
    libraryErrors: $("library-errors"),
    message: $("room-message"),
    error: $("room-error"),
    hudLabel: document.querySelector<HTMLElement>(".local-label"),
  };

  constructor(private readonly host: SessionHost) {
    this.avatars = new Avatars(host.scene);
    this.urlRoom = normalizeCode(
      new URL(location.href).searchParams.get("room"),
    );
    const { ui } = this;
    ui.name.value = localStorage.getItem(NAME_KEY) || "Guest";
    ui.name.addEventListener("change", () => {
      this.saveName();
      this.profileDirty = true;
    });
    ui.toggle.onclick = () =>
      this.expand(ui.panel.classList.contains("collapsed"));
    this.expand(innerWidth > 650);
    ui.create.onclick = () => void this.create();
    ui.join.onclick = () => void this.join(ui.code.value, false);
    ui.code.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !ui.join.disabled)
        void this.join(ui.code.value, false);
    });
    ui.leave.onclick = () => void this.leave();
    ui.copy.onclick = () => void this.copyLink();
    ui.libraryAdd.onclick = () => void this.addToLibrary();
    uploadPanel(this.net, ui.upload);
    ui.uploadToggle.onclick = () => this.showUpload(ui.upload.hidden);
    if (location.pathname === "/upload") this.showUpload(true);
    // Players are labelled by device: re-send it when entering or leaving VR.
    host.renderer.xr.addEventListener(
      "sessionstart",
      () => (this.profileDirty = true),
    );
    host.renderer.xr.addEventListener(
      "sessionend",
      () => (this.profileDirty = true),
    );
    for (const index of [0, 1]) {
      const controller = host.renderer.xr.getController(index);
      controller.addEventListener("connected", (event) => {
        this.handedness[index] = (
          event as unknown as { data?: XRInputSource }
        ).data?.handedness;
      });
      controller.addEventListener(
        "disconnected",
        () => (this.handedness[index] = undefined),
      );
    }
    this.net.addEventListener("change", () => this.onChange());
    this.net.connect();
    this.render();
  }

  /** Called by main.ts once the viewer exists. */
  attach(viewer: Viewer): void {
    this.viewer = viewer;
    this.startAdapter();
    this.render();
  }

  /** Per frame, after the camera moved: avatars, own head pose, pending profile re-send. */
  update(dt: number): void {
    if (!this.room) this.avatars.clear();
    else if (this.net.ready && this.net.room)
      this.avatars.update(this.net.players, this.net.identity, dt, this.host.camera.getWorldPosition(this.viewpoint));
    this.sendPose();
    if (this.profileDirty) this.resendProfile();
  }

  dispose(): void {
    this.adapter?.dispose();
    this.avatars.dispose();
    this.net.dispose();
  }

  private onChange(): void {
    const { net } = this;
    if (net.ready && !this.wasReady) this.readyCycle++;
    this.wasReady = net.ready;
    this.render();
    if (!net.ready || this.navigating) return;
    if (this.firstReady) {
      this.firstReady = false;
      if (this.urlRoom) void this.join(this.urlRoom, true);
      // The server put this identity back in its old room on connect, but this page has no
      // ?room=, so it is a local session: leave, or the others see a ghost.
      else if (net.room)
        void net.run(() => net.connection!.reducers.leaveRoom({}), false);
      return;
    }
    if (this.room && !this.busy) {
      if (!net.room && this.rejoinCycle !== this.readyCycle) {
        // Back online but no longer in the room (the server dropped us): rejoin once per connection.
        this.rejoinCycle = this.readyCycle;
        void this.rejoin();
      } else if (net.room && !this.adapter) this.startAdapter();
    }
  }

  private who(): { name: string; device: Device } {
    return {
      name: this.saveName(),
      device: deviceKind(
        this.host.renderer.xr.isPresenting,
        navigator.userAgent,
        isTouchDevice(),
      ),
    };
  }

  private saveName(): string {
    const name = this.ui.name.value.trim().slice(0, 40) || "Guest";
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* private mode: the name is still used for this page */
    }
    return name;
  }

  private async create(): Promise<void> {
    const value = this.ui.memories.value;
    if (!value || this.busy) return;
    this.busy = true;
    this.render();
    const ok = await this.net.run(() =>
      this.net.connection!.reducers.createRoom({
        memoryId: BigInt(value),
        ...this.who(),
      }),
    );
    this.busy = false;
    if (ok) this.entered(false);
    this.render();
  }

  private async join(code: string, fromUrl: boolean): Promise<void> {
    const joinCode = normalizeCode(code);
    if (!joinCode || this.busy) return;
    if (joinCode === this.room) {
      // Joining again would clear this player's object ownership mid-throw on the server.
      this.message = `You're already in room ${joinCode}.`;
      return this.render();
    }
    this.busy = true;
    this.render();
    const ok = await this.net.run(() =>
      this.net.connection!.reducers.joinRoom({ joinCode, ...this.who() }),
    );
    this.busy = false;
    if (ok) this.entered(fromUrl);
    else if (fromUrl)
      // Stay a local session, and do not retry this code on reload. A reconnect can put this identity back in its
      // previous room on the server; abandonJoin leaves that too, or the others keep seeing a frozen avatar.
      this.abandonJoin(`Could not join room ${joinCode}. You're exploring on your own.`);
    this.render();
  }

  private async rejoin(): Promise<void> {
    this.busy = true;
    const ok = await this.net.run(
      () =>
        this.net.connection!.reducers.joinRoom({
          joinCode: this.room,
          ...this.who(),
        }),
      false,
    );
    this.busy = false;
    if (!ok) this.message = `Lost room ${this.room}. Reload to try again.`;
    this.render();
  }

  /** After a successful create or join: open the room's memory, then start syncing. */
  private entered(fromUrl: boolean): void {
    const room = this.net.room,
      memory = this.net.memory;
    if (!room || !memory) {
      this.abandonJoin(
        "Joined, but the room's memory is missing from the library. You're exploring on your own.",
      );
      return;
    }
    const code = room.joinCode;
    if (
      !sameManifest(memory.manifestUrl, this.host.manifestUrl, location.href)
    ) {
      // Nikko's viewer loads one manifest at boot: reload into the room's memory.
      const target = roomUrl(location.href, code, memory.manifestUrl);
      if (fromUrl && !claimReload(sessionStorage, target)) {
        this.abandonJoin(
          `Room ${code} shows “${memory.title}”, but this page could not open it (${memory.manifestUrl}). You're exploring on your own.`,
        );
        return;
      }
      sessionStorage.setItem(RELOAD_GUARD_KEY, target);
      this.navigate(target, `Opening “${memory.title}” for room ${code}…`);
      return;
    }
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
    if (this.room && this.room !== code) {
      this.navigate(roomUrl(location.href, code), `Switching to room ${code}…`);
      return;
    }
    if (this.adapter) return;
    this.room = this.urlRoom = code;
    this.message = "";
    // Keep ?room= in the address bar, so a reload rejoins and the link can be shared.
    history.replaceState(history.state, "", roomUrl(location.href, code));
    this.startAdapter();
  }

  /**
   * The server already put us in the room, but this page can't show it: leave again, so the others don't see a
   * ghost avatar, and stay a local session that won't retry this room on reload.
   */
  private abandonJoin(text: string): void {
    void this.net.run(() => this.net.connection!.reducers.leaveRoom({}), false);
    this.urlRoom = "";
    history.replaceState(history.state, "", roomUrl(location.href, null));
    this.message = text;
  }

  private startAdapter(): void {
    const viewer = this.viewer;
    if (!viewer || this.adapter || !this.room || this.navigating) return;
    if (!this.net.ready || !this.net.room) return; // onChange retries once connected
    if (
      viewer.timeline.branches.length > 1 ||
      viewer.busy ||
      viewer.recording
    ) {
      // Local takes must not mix with the room's: start over from a fresh viewer.
      this.navigate(
        roomUrl(location.href, this.room),
        `Joining room ${this.room}; local takes are cleared…`,
      );
      return;
    }
    this.host.showStatus(
      `In room ${this.room}. Pause to grab and throw; everyone sees the same take.`,
    );
    const adapter = new NetAdapter(this.net, viewer, (message) =>
      this.host.showStatus(message),
    );
    this.adapter = adapter;
    viewer.setAuthority(adapter);
    adapter.start();
  }

  private async leave(): Promise<void> {
    if (this.busy) return;
    if (this.net.ready && this.net.room) {
      this.busy = true;
      this.render();
      const ok = await this.net.run(() =>
        this.net.connection!.reducers.leaveRoom({}),
      );
      this.busy = false;
      if (!ok) return this.render();
    }
    this.navigate(roomUrl(location.href, null), "Leaving the room…");
  }

  private navigate(url: string, message: string): void {
    this.navigating = true;
    this.message = message;
    this.host.showStatus(message);
    this.render();
    if (url === location.href) location.reload();
    else location.replace(url);
  }

  private async copyLink(): Promise<void> {
    if (!this.room) return;
    const url = roomUrl(location.href, this.room);
    try {
      await navigator.clipboard.writeText(url);
      this.message = "Room link copied.";
    } catch {
      this.message = url;
    }
    this.render();
  }

  private async addToLibrary(): Promise<void> {
    if (this.adding) return;
    this.adding = true;
    this.render();
    try {
      const manifestUrl = new URL(
        this.ui.libraryUrl.value.trim() || DEFAULT_MANIFEST,
        location.href,
      ).href;
      const existing = this.net.memories.find(
        (m) => m.manifestUrl === manifestUrl && m.status === "ready",
      );
      if (existing) {
        this.ui.memories.value = existing.id.toString();
        this.message = `“${existing.title}” is already in the library.`;
        return;
      }
      const response = await fetch(manifestUrl);
      if (!response.ok) throw new Error(`Manifest returned ${response.status}`);
      const manifest = (await response.json()) as MemoryManifest;
      validateManifest(manifest);
      const requestId =
        crypto.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const ok = await this.net.run(() =>
        this.net.connection!.reducers.createMemory({
          requestId,
          title: manifest.title,
          sourceUrl: "",
          manifestUrl,
          pipelineIdentity: this.net.identity!,
          durationUs: BigInt(Math.round(manifest.timeline.durationSec * 1e6)),
        }),
      );
      if (ok) {
        this.selectRequest = requestId;
        this.memoryKey = "";
        this.message = `Added “${manifest.title}” to the library.`;
      }
    } catch (error) {
      this.net.report(error);
    } finally {
      this.adding = false;
      this.render();
    }
  }

  private sendPose(): void {
    const { net, host } = this;
    if (!this.room || !net.ready || !net.room) return;
    const now = performance.now();
    if (now - this.poseSentAt < POSE_INTERVAL_MS) return;
    // World pose: in VR the camera sits under the rig, and getWorld* includes the rig.
    host.camera.getWorldPosition(this.head);
    host.camera.getWorldQuaternion(this.headRotation);
    const xr = host.renderer.xr;
    for (const [slot, side] of [
      [0, "left"],
      [1, "right"],
    ] as const) {
      const out = this.hands[slot].copy(this.head);
      if (!xr.isPresenting) continue;
      const index = this.handedness.indexOf(side);
      const controller = xr.getController(index >= 0 ? index : slot);
      if (controller.visible) controller.getWorldPosition(out);
    }
    const [left, right] = this.hands;
    const pose = {
      hx: this.head.x,
      hy: this.head.y,
      hz: this.head.z,
      hqx: this.headRotation.x,
      hqy: this.headRotation.y,
      hqz: this.headRotation.z,
      hqw: this.headRotation.w,
      lx: left.x,
      ly: left.y,
      lz: left.z,
      rx: right.x,
      ry: right.y,
      rz: right.z,
    };
    const values = Object.values(pose);
    if (!values.every(Number.isFinite)) return;
    const changed = values.some(
      (v, i) => !(Math.abs(v - (this.lastPose[i] ?? NaN)) <= 0.001),
    );
    if (!changed && now - this.poseSentAt < POSE_REFRESH_MS) return;
    this.poseSentAt = now;
    this.lastPose = values;
    net.sendPose(pose);
  }

  /** Re-send name and device (joinRoom with the same code). Waits until we own no object: joining clears ownership. */
  private resendProfile(): void {
    const { net } = this;
    if (!this.room || !net.ready || !net.room || this.busy) return;
    if (this.viewer && (this.viewer.busy || this.viewer.recording)) return;
    const me = net.identity;
    if (
      me &&
      [...net.connection!.db.objectState.iter()].some((o) =>
        o.simOwner?.isEqual(me),
      )
    )
      return;
    this.profileDirty = false;
    void net.run(
      () =>
        net.connection!.reducers.joinRoom({
          joinCode: this.room,
          ...this.who(),
        }),
      false,
    );
  }

  private expand(open: boolean): void {
    this.ui.panel.classList.toggle("collapsed", !open);
    this.ui.toggle.setAttribute("aria-expanded", String(open));
  }

  private showUpload(open: boolean): void {
    this.ui.upload.hidden = !open;
    this.ui.uploadToggle.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.expand(true);
    this.ui.upload.scrollIntoView({ block: "nearest" });
  }

  private render(): void {
    const { net, ui } = this;
    setText(ui.connection, net.status);
    setText(ui.error, net.error);
    setText(ui.message, this.message);
    this.renderLibrary();
    const room = net.ready ? net.room : undefined;
    const players = room ? net.players : [];
    const people = `${players.length} ${players.length === 1 ? "person" : "people"}`;
    const label = this.room
      ? room
        ? `Room ${this.room} · ${people}`
        : `Room ${this.room} · reconnecting…`
      : this.urlRoom
        ? `Joining room ${this.urlRoom}…`
        : "Explore solo or join a room";
    setText(ui.label, label);
    setText(
      ui.summary,
      this.room
        ? `${this.room} · ${people}`
        : this.urlRoom
          ? "Joining…"
          : "Solo",
    );
    if (ui.hudLabel) {
      setText(
        ui.hudLabel,
        this.room ? `Shared room ${this.room} · ${people}` : "Local session",
      );
      ui.hudLabel.classList.toggle("shared", !!this.room);
    }
    const me = net.identity;
    const peopleKey = players
      .map(
        (p) => `${p.identity.toHexString()}:${p.name}:${p.device}:${p.color}`,
      )
      .join("|");
    if (peopleKey !== this.peopleKey) {
      this.peopleKey = peopleKey;
      ui.people.replaceChildren(
        ...players.map((p) => {
          const item = document.createElement("li");
          const dot = document.createElement("span");
          dot.className = "dot";
          dot.style.background = `#${playerColor(p.color).getHexString()}`;
          item.append(
            dot,
            `${p.name} (${p.device})${me && p.identity.isEqual(me) ? " · you" : ""}`,
          );
          return item;
        }),
      );
    }
    const idle = net.ready && !this.busy && !this.navigating;
    ui.create.disabled = !idle || !ui.memories.value;
    ui.join.disabled = !idle;
    ui.libraryAdd.disabled = !net.ready || this.adding;
    ui.libraryAdd.textContent = this.adding ? "Adding…" : "Add to library";
    ui.copy.disabled = !this.room;
    ui.leave.disabled = !this.room || this.busy || this.navigating;
    setText(
      ui.libraryErrors,
      net.memories
        .filter((m) => m.error)
        .map((m) => `${m.title}: ${m.error}`)
        .join("\n"),
    );
  }

  private renderLibrary(): void {
    const select = this.ui.memories;
    const memories = this.net.memories;
    const key = memories
      .map((m) => `${m.id}:${m.title}:${m.status}:${m.progress}`)
      .join("|");
    if (key === this.memoryKey) return;
    this.memoryKey = key;
    const previous = select.value;
    select.replaceChildren();
    for (const m of memories) {
      const option = new Option(
        `#${m.id} ${m.title} · ${m.status} ${Math.round(m.progress * 100)}%`,
        m.id.toString(),
      );
      option.title = m.manifestUrl || m.sourceUrl;
      option.disabled = m.status !== "ready";
      select.add(option);
    }
    const ready = memories.filter((m) => m.status === "ready");
    const requested = ready.find((m) => m.requestId === this.selectRequest);
    if (requested) this.selectRequest = "";
    const keep = ready.find((m) => m.id.toString() === previous);
    const choice = requested ?? keep ?? ready.at(-1);
    select.value = choice ? choice.id.toString() : "";
  }
}
