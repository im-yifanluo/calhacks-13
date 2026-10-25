// Shared-room panel and presence: connection, name, rooms, library, upload, people and avatars.
// Extracted from jerry's main.ts (origin/stdb/jerry-p4). Playback, takes and grabbing stay in nikko's
// viewer and HUD; net/adapter.ts syncs those with the server while this page is in a room.
import * as THREE from "three";
import type { Identity } from "spacetimedb";
import type { MemoryManifest } from "@memreplay/shared";
import { type Failure, Multiplayer, type Player } from "./net/index.js";
import { NetAdapter } from "./net/adapter.js";
import { validateManifest } from "./loader.js";
import { isTouchDevice } from "./phone-joystick.js";
import { uploadPanel } from "./upload.js";
import { dragToClose } from "./ui.js";
import type { Viewer } from "./viewer.js";

/** main.ts loads this manifest when the URL has no ?memory= (its built-in demo). */
export const DEFAULT_MANIFEST = "/demo/memory.json";
/** sessionStorage: the room URL this tab last reloaded into to open the room's memory. */
export const RELOAD_GUARD_KEY = "memreplay-room-reload";
const NAME_KEY = "memreplay-name";
/** 12.5 Hz: the head-pose rate net.sendPose allows. */
const POSE_INTERVAL_MS = 80;
/** An unchanged pose is re-sent this often, in case a send was dropped. */
const POSE_REFRESH_MS = 1000;
/** How long an informational message stays up (ms). */
export const NOTICE_MS = 6000;

/** LAN HTTP pages have getRandomValues, but not the secure-context-only randomUUID API. */
export function memoryRequestId(): string {
  return crypto.randomUUID?.() ?? Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export interface NoticeOptions {
  /** What the message is about. A later success of the same kind (resolve) clears an error. */
  kind?: string;
  /** Errors stay until a newer message replaces them or their kind succeeds; other messages expire. */
  error?: boolean;
  /** Information that stays until replaced: a page about to reload, a link to copy by hand. */
  persist?: boolean;
}

/**
 * One message slot. A newer message replaces the older one; information expires after NOTICE_MS; an
 * error stays until a newer message replaces it or an action of its kind succeeds. When a message
 * goes, the slot shows `idle()` instead, unless someone else has written over it (`showing` is false).
 */
export class Notice {
  private current?: { text: string; kind?: string; error: boolean };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly display: (text: string, error: boolean) => void,
    private readonly showing: (text: string) => boolean = () => true,
    private readonly idle: () => string = () => "",
  ) {}

  get text(): string {
    return this.current?.text ?? "";
  }
  get error(): boolean {
    return this.current?.error ?? false;
  }

  show(text: string, options: NoticeOptions = {}): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const notice = { text, kind: options.kind, error: !!options.error };
    this.current = notice;
    this.display(text, notice.error);
    if (!notice.error && !options.persist)
      this.timer = setTimeout(() => {
        if (this.current === notice) this.clear();
      }, NOTICE_MS);
  }

  /** An action of this kind succeeded: an error about it is stale. */
  resolve(kind: string): void {
    if (this.current?.error && this.current.kind === kind) this.clear();
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const shown = this.current;
    this.current = undefined;
    if (shown && this.showing(shown.text)) this.display(this.idle(), false);
  }

  /** Stops the expiry timer without touching the display. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The status line's resting text while this page is in a room. */
const roomHint = (code: string) =>
  `In party ${code}. The leader controls time; everyone sees the same take.`;

export type Device = "quest" | "phone" | "desktop";

export const normalizeCode = (code: string | null | undefined) =>
  (code ?? "").trim().toUpperCase();

/** /CODE is canonical. Old ?room= invitations still work; a path code takes precedence. */
export function roomCode(href: string): string {
  const url = new URL(href);
  const match = /^\/([a-z0-9]{7})\/?$/i.exec(url.pathname);
  return normalizeCode(match?.[1] ?? url.searchParams.get("room"));
}

const ROOM_MANIFEST_KEY = "memreplay-room-manifest:";

/** Only a hint for the next load. The database always checks and replaces it after joining. */
export function rememberRoomManifest(storage: Pick<Storage, "setItem">, code: string, manifest: string): void {
  storage.setItem(ROOM_MANIFEST_KEY + normalizeCode(code), manifest);
}

/** Resolve the scene without putting its asset URL in the shared room address. */
export function loadedManifest(href: string, storage?: Pick<Storage, "getItem">): string {
  const url = new URL(href);
  const code = roomCode(href);
  const roomManifest = code ? storage?.getItem(ROOM_MANIFEST_KEY + code) : null;
  return new URL(roomManifest ?? url.searchParams.get("memory") ?? DEFAULT_MANIFEST, url).href;
}

export function sameManifest(a: string, b: string, base: string): boolean {
  return new URL(a, base).href === new URL(b, base).href;
}

/**
 * One server origin: /CODE joins a party, / starts solo. Scene URLs stay in the database.
 */
export function roomUrl(
  href: string,
  code: string | null,
): string {
  const url = new URL(href);
  url.pathname = code ? `/${normalizeCode(code)}` : "/";
  url.search = "";
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
  /** Room from the path or legacy query; cleared when it cannot be joined. */
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
  /** The room panel's message: room actions, the library and connection problems. */
  private readonly panel: Notice;
  /** The room's messages in the viewer's status line (the adapter's and this panel's). */
  private readonly status: Notice;
  /** The last connection failure shown, to notice a new one or its end. */
  private failureSeen?: Failure;
  private memoryKey = "initial";
  private peopleKey = "";
  private sceneRevision?: number;
  private poseSentAt = -Infinity;
  private lastPose: number[] = [];
  private handedness: (string | undefined)[] = [];
  private head = new THREE.Vector3();
  private readonly viewpoint = new THREE.Vector3();
  private headRotation = new THREE.Quaternion();
  private hands = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly ui = {
    panel: $<HTMLDialogElement>("room-panel"),
    toggle: $<HTMLButtonElement>("room-toggle"),
    summary: $("room-summary"),
    connection: $("room-connection"),
    name: $<HTMLInputElement>("player-name"),
    memories: $<HTMLSelectElement>("room-memories"),
    create: $<HTMLButtonElement>("room-create"),
    uploadToggle: $<HTMLButtonElement>("upload-toggle"),
    sceneActions: $("party-scene-actions"),
    attach: $<HTMLButtonElement>("party-attach"),
    cancel: $<HTMLButtonElement>("party-cancel"),
    role: $("party-role"),
    sceneStatus: $("party-scene-status"),
    progress: $<HTMLProgressElement>("party-progress"),
    speedLabel: $("party-speed-label"),
    speed: $<HTMLSelectElement>("party-speed"),
    inviteLabel: $("party-invite-label"),
    invite: $<HTMLInputElement>("party-invite"),
    joinForm: $<HTMLFormElement>("party-join-form"),
    code: $<HTMLInputElement>("room-code"),
    join: $<HTMLButtonElement>("room-join"),
    solo: $<HTMLButtonElement>("room-solo"),
    codeShare: $("party-code-share"),
    currentCode: $("party-current-code"),
    copyCode: $<HTMLButtonElement>("party-copy-code"),
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
    this.panel = new Notice(() => this.render());
    // The viewer writes its own messages to the same line: only clear ours while they are still shown.
    const line = document.getElementById("status");
    this.status = new Notice(
      (text) => host.showStatus(text),
      (text) => !line || line.textContent === text,
      () => (this.adapter ? roomHint(this.room) : ""),
    );
    this.urlRoom = roomCode(location.href);
    const { ui } = this;
    ui.name.value = sessionStorage.getItem(NAME_KEY) || localStorage.getItem(NAME_KEY) || "Guest";
    ui.name.addEventListener("input", () => {
      this.saveName();
      this.profileDirty = true;
    });
    // A non-modal sheet: the memory stays visible and usable behind it.
    ui.toggle.onclick = () => this.expand(!ui.panel.open);
    $("room-close").onclick = () => this.expand(false);
    ui.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        // A fresh visit shows the party-code field; invite links open the scene directly (stdb/jerry-p4).
    this.expand(!this.urlRoom || innerWidth > 650);
        ui.toggle.focus();
      }
    });
    dragToClose(ui.panel, ui.panel.querySelector<HTMLElement>(".sheet-head") ?? ui.panel, () => this.expand(false));
    // A fresh visit shows the party-code field; invite links open the scene directly (stdb/jerry-p4).
    this.expand(!this.urlRoom || innerWidth > 650);
    ui.create.onclick = () => void this.create();
    ui.attach.onclick = () => void this.attachScene();
    ui.cancel.onclick = () => void this.act("scene", "Could not cancel", () => this.net.connection!.reducers.attachPartyMemory({ memoryId: 0n }));
    ui.speed.onchange = () => void this.act("clock", "Could not change speed", () => this.net.connection!.reducers.setPlaybackSpeed({ speed: Number(ui.speed.value) }));
    ui.invite.onclick = () => ui.invite.select();
    ui.joinForm.onsubmit = (event) => {
      event.preventDefault();
      if (!ui.join.disabled) void this.join(ui.code.value, false);
    };
    ui.copyCode.onclick = () => void this.copyCode();
    ui.solo.onclick = () => this.expand(false);
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

  get canControlTime(): boolean {
    return !this.room || (this.net.ready && this.net.canControlTime);
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
    this.panel.dispose();
    this.status.dispose();
    this.net.dispose();
  }

  private onChange(): void {
    const { net } = this;
    if (net.ready && !this.wasReady) this.readyCycle++;
    this.wasReady = net.ready;
    this.showFailure(net.failure);
    this.render();
    if (!net.ready || this.navigating) return;
    if (this.firstReady) {
      this.firstReady = false;
      if (this.urlRoom) void this.join(this.urlRoom, true);
      // The server put this identity back in its old room on connect, but this page has no
      // room address, so it is a solo session: leave, or the others see a ghost.
      else if (net.room)
        void net.attempt(() => net.connection!.reducers.leaveRoom({}), null);
      return;
    }
    if (this.room && !this.busy) {
      if (!net.room && this.rejoinCycle !== this.readyCycle) {
        // Back online but no longer in the room (the server dropped us): rejoin once per connection.
        this.rejoinCycle = this.readyCycle;
        void this.rejoin();
      } else if (net.room && net.memory && this.sceneRevision !== undefined && net.party?.sceneRevision !== this.sceneRevision) {
        rememberRoomManifest(sessionStorage, this.room, net.memory.manifestUrl);
        this.navigate(roomUrl(location.href, this.room), `Opening “${net.memory.title}” for everyone…`);
      } else if (net.room && net.memory && !sameManifest(net.memory.manifestUrl, this.host.manifestUrl, location.href)) {
        this.entered(true);
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
      sessionStorage.setItem(NAME_KEY, name);
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* private mode: the name is still used for this page */
    }
    return name;
  }

  /**
   * One server call for the panel. A failure shows as "<what>: <reason>" and stays until a newer
   * message or a later success of the same kind; it never touches another kind's error.
   */
  private async act(
    kind: string,
    what: string,
    action: () => Promise<unknown>,
  ): Promise<boolean> {
    const error = await this.net.attempt(action, null);
    if (error) this.panel.show(`${what}: ${error}`, { kind, error: true });
    else this.panel.resolve(kind);
    return !error;
  }

  private async demoMemory(): Promise<bigint> {
    const manifestUrl = new URL(DEFAULT_MANIFEST, location.href).href;
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`Demo manifest returned ${response.status}`);
    const manifest = await response.json() as MemoryManifest;
    validateManifest(manifest);
    const existing = this.net.memories.find(m => m.manifestUrl === manifestUrl && m.status === "ready" && m.title === manifest.title);
    if (existing) return existing.id;
    const requestId = memoryRequestId();
    await this.net.connection!.reducers.createMemory({ requestId, title: manifest.title,
      sourceUrl: "", manifestUrl, pipelineIdentity: this.net.identity!,
      durationUs: BigInt(Math.round(manifest.timeline.durationSec * 1e6)) });
    const row = this.net.memories.find(m => m.requestId === requestId);
    if (!row) throw new Error("Demo registration did not arrive; try again");
    return row.id;
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    const selected = this.net.memories.find(m => String(m.id) === this.ui.memories.value);
    this.busy = true;
    this.render();
    const ok = await this.act("room", "Could not create a party", async () => {
      const memoryId = selected?.status === "ready" ? selected.id : await this.demoMemory();
      await this.net.connection!.reducers.createParty({ memoryId, ...this.who() });
      if (selected && selected.status !== "ready")
        await this.net.connection!.reducers.attachPartyMemory({ memoryId: selected.id });
    });
    this.busy = false;
    if (ok) this.entered(false);
    this.render();
  }

  private async attachScene(): Promise<void> {
    if (this.busy || !this.net.isLeader) return;
    const selected = this.ui.memories.value;
    this.busy = true;
    this.render();
    const ok = await this.act("scene", "Could not attach scene", async () => {
      const memoryId = selected === "demo" ? await this.demoMemory() : BigInt(selected);
      await this.net.connection!.reducers.attachPartyMemory({ memoryId });
    });
    this.busy = false;
    if (ok) { this.panel.show("Scene selected. Everyone follows when it is ready."); this.onChange(); }
    this.render();
  }

  private async join(code: string, fromUrl: boolean): Promise<void> {
    const joinCode = normalizeCode(code);
    if (this.busy || this.navigating || !this.net.ready) return;
    if (!/^[A-Z0-9]{7}$/.test(joinCode)) {
      const message = "Enter the host’s 7-character party code (letters and numbers).";
      if (fromUrl) this.abandonJoin(message);
      else this.panel.show(message, { kind: "room", error: true });
      return;
    }
    if (joinCode === this.room) {
      // Joining again would clear this player's object ownership mid-throw on the server.
      return this.panel.show(`You're already in party ${joinCode}.`);
    }
    this.busy = true;
    this.render();
    const error = await this.net.attempt(
      () => this.net.connection!.reducers.joinRoom({ joinCode, ...this.who() }),
      null,
    );
    this.busy = false;
    if (!error) {
      this.panel.resolve("room");
      this.ui.code.value = "";
      this.ui.code.blur();
      this.entered(fromUrl);
      if (innerWidth <= 650 && this.room === joinCode) this.expand(false);
    } else if (fromUrl)
      // Stay a local session, and do not retry this code on reload. A reconnect can put this identity back in its
      // previous room on the server; abandonJoin leaves that too, or the others keep seeing a frozen avatar.
      this.abandonJoin(`Could not join room ${joinCode} (${error}). You're exploring on your own.`);
    else
      this.panel.show(`Could not join party ${joinCode}: ${error}. Check the code and use the same app address as the host.`, {
        kind: "room",
        error: true,
      });
    this.render();
  }

  private async rejoin(): Promise<void> {
    this.busy = true;
    const error = await this.net.attempt(
      () =>
        this.net.connection!.reducers.joinRoom({
          joinCode: this.room,
          ...this.who(),
        }),
      null,
    );
    this.busy = false;
    if (error)
      this.panel.show(`Lost room ${this.room} (${error}). Reload to try again.`, {
        kind: "room",
        error: true,
      });
    else this.panel.resolve("room");
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
    rememberRoomManifest(sessionStorage, code, memory.manifestUrl);
    if (
      !sameManifest(memory.manifestUrl, this.host.manifestUrl, location.href)
    ) {
      // Nikko's viewer loads one manifest at boot: reload into the room's memory.
      const target = roomUrl(location.href, code);
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
    this.sceneRevision = this.net.party?.sceneRevision;
    if (this.adapter) return;
    this.room = this.urlRoom = code;
    // Canonicalize legacy invites and lowercase/trailing-slash paths after joining.
    history.replaceState(history.state, "", roomUrl(location.href, code));
    this.startAdapter();
  }

  /**
   * The server already put us in the room, but this page can't show it: leave again, so the others don't see a
   * ghost avatar, and stay a local session that won't retry this room on reload.
   */
  private abandonJoin(text: string): void {
    void this.net.attempt(() => this.net.connection!.reducers.leaveRoom({}), null);
    this.urlRoom = "";
    this.expand(true);
    history.replaceState(history.state, "", roomUrl(location.href, null));
    this.panel.show(text, { kind: "room", error: true });
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
    const adapter = new NetAdapter(
      this.net,
      viewer,
      (message, options) => this.status.show(message, options),
      (kind) => this.status.resolve(kind),
    );
    this.adapter = adapter;
    this.status.show(roomHint(this.room), { persist: true });
    viewer.setAuthority(adapter);
    adapter.start();
  }

  private async leave(): Promise<void> {
    if (this.busy) return;
    if (this.net.ready && this.net.room) {
      this.busy = true;
      this.render();
      const ok = await this.act("room", "Could not leave the room", () =>
        this.net.connection!.reducers.leaveRoom({}),
      );
      this.busy = false;
      if (!ok) return this.render();
    }
    this.navigate(roomUrl(location.href, null), "Leaving the room…");
  }

  private navigate(url: string, message: string): void {
    this.navigating = true;
    this.panel.show(message, { persist: true });
    this.status.show(message, { persist: true });
    if (url === location.href) location.reload();
    else location.replace(url);
  }

  private async copyLink(): Promise<void> {
    if (!this.room) return;
    const url = roomUrl(location.href, this.room);
    try {
      await navigator.clipboard.writeText(url);
      this.panel.show("Party invite link copied.");
    } catch {
      // Shown until replaced, so it can be copied by hand.
      this.panel.show(url, { persist: true });
    }
  }

  private async copyCode(): Promise<void> {
    if (!this.room) return;
    try {
      await navigator.clipboard.writeText(this.room);
      this.panel.show("Party code copied. Share it with someone using this app.");
    } catch {
      this.panel.show(`Your party code is ${this.room}. Select it above to copy.`, { persist: true });
    }
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
        this.panel.show(`“${existing.title}” is already in the library.`);
        return;
      }
      const response = await fetch(manifestUrl);
      if (!response.ok) throw new Error(`Manifest returned ${response.status}`);
      const manifest = (await response.json()) as MemoryManifest;
      validateManifest(manifest);
      const requestId = memoryRequestId();
      const error = await this.net.attempt(
        () =>
          this.net.connection!.reducers.createMemory({
            requestId,
            title: manifest.title,
            sourceUrl: "",
            manifestUrl,
            pipelineIdentity: this.net.identity!,
            durationUs: BigInt(Math.round(manifest.timeline.durationSec * 1e6)),
          }),
        null,
      );
      if (error) throw new Error(error);
      this.selectRequest = requestId;
      this.memoryKey = "";
      this.panel.show(`Added “${manifest.title}” to the library.`);
    } catch (error) {
      this.panel.show(
        `Could not add it to the library: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "library", error: true },
      );
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
    void this.act("profile", "Could not update your name", () =>
      net.connection!.reducers.joinRoom({
        joinCode: this.room,
        ...this.who(),
      }),
    );
  }

  private expand(open: boolean): void {
    const panel = this.ui.panel;
    if (open && !panel.open) panel.show();
    if (!open && panel.open) panel.close();
    this.ui.toggle.setAttribute("aria-expanded", String(open));
  }

  private showUpload(open: boolean): void {
    this.ui.upload.hidden = !open;
    this.ui.uploadToggle.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.ui.upload.closest("details")?.setAttribute("open", "");
    this.expand(true);
    this.ui.upload.scrollIntoView({ block: "nearest" });
  }

  /** A new connection failure replaces the panel's message; it goes once the connection recovers. */
  private showFailure(failure: Failure | undefined): void {
    if (failure === this.failureSeen) return;
    const previous = this.failureSeen;
    this.failureSeen = failure;
    if (failure)
      this.panel.show(failure.message, { kind: failure.kind, error: true });
    else if (previous) this.panel.resolve(previous.kind);
  }

  private render(): void {
    const { net, ui, panel } = this;
    setText(ui.connection, net.status);
    // One message at a time: the newest, in red when it is an error.
    setText(ui.message, panel.error ? "" : panel.text);
    setText(ui.error, panel.error ? panel.text : "");
    this.renderLibrary();
    const room = net.ready ? net.room : undefined;
    const players = room ? net.players : [];
    const people = `${players.length} ${players.length === 1 ? "person" : "people"}`;
    const label = this.room
      ? room
        ? `Party ${this.room} · ${people}`
        : `Party ${this.room} · reconnecting…`
      : this.urlRoom
        ? `Joining room ${this.urlRoom}…`
        : "Explore solo or join a party";
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
        this.room ? `Party ${this.room} · ${people}` : "Solo session",
      );
      ui.hudLabel.classList.toggle("shared", !!this.room);
    }
    const me = net.identity;
    const peopleKey = `${room?.host.toHexString()}|${net.isLeader}|` + players
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
          if (net.party && p.identity.isEqual(room!.host)) item.append(" · leader");
          else if (net.party && net.isLeader) {
            const transfer = document.createElement("button");
            transfer.textContent = "Make leader";
            transfer.setAttribute("aria-label", `Make ${p.name} leader`);
            transfer.onclick = () => void this.act("leader", "Could not transfer leadership", () => net.connection!.reducers.transferLeadership({ identity: p.identity }));
            item.append(transfer);
          }
          const profile = net.connection?.db.profile.identity.find(p.identity);
          if (profile?.provider === "google") item.append(" · Google");
          return item;
        }),
      );
    }
    const idle = net.ready && !this.busy && !this.navigating;
    ui.create.disabled = !idle;
    ui.create.textContent = this.busy ? "Working…" : "Create party";
    ui.sceneActions.hidden = !net.party || !net.isLeader;
    ui.attach.disabled = !idle;
    ui.cancel.hidden = !net.pendingMemory;
    ui.cancel.disabled = !idle;
    ui.speedLabel.hidden = !net.party;
    ui.speed.disabled = !idle || !net.isLeader;
    ui.speed.value = String(net.timeline?.speed ?? 1);
    ui.inviteLabel.hidden = !this.room;
    ui.invite.value = this.room ? roomUrl(location.href, this.room) : "";
    ui.codeShare.hidden = !this.room;
    setText(ui.currentCode, this.room);
    const leader = players.find(p => p.identity.isEqual(room!.host));
    setText(ui.role, net.party ? net.isLeader ? "You are the leader · control playback below." : `${leader?.name || "The leader"} controls time. Look around and grab objects while paused.` : "");
    const pending = net.pendingMemory;
    ui.progress.hidden = !pending;
    ui.progress.value = pending?.progress ?? 0;
    setText(ui.sceneStatus, pending
      ? `${pending.title} · ${pending.status} ${Math.round(pending.progress * 100)}%. ${pending.status === "uploaded" ? "Waiting for a reconstruction worker. " : ""}${pending.error || "The current scene stays available until the new one is ready."}`
      : net.party ? `Viewing ${net.memory?.title}. ${net.memory?.manifestUrl.includes("/demo/memory.json") ? "Synthetic demo; not reconstructed from video." : ""}`
      : "Synthetic demo available. Create a party and share its link. No reconstruction worker is required to test multiplayer.");
    ui.join.disabled = !idle;
    ui.solo.hidden = !!this.room || !!this.urlRoom;
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
    // Prefixed so an empty library still renders once (its hint).
    const key = `library:${memories
      .map((m) => `${m.id}:${m.title}:${m.status}:${m.progress}`)
      .join("|")}`;
    if (key === this.memoryKey) return;
    this.memoryKey = key;
    const previous = select.value;
    select.replaceChildren(new Option("Synthetic demo · ready to play", "demo"));
    for (const m of memories) {
      const option = new Option(
        `#${m.id} ${m.title} · ${m.status} ${Math.round(m.progress * 100)}%`,
        m.id.toString(),
      );
      option.title = m.manifestUrl || m.sourceUrl;
      option.disabled = false;
      select.add(option);
    }
    const ready = memories;
    const requested = ready.find((m) => m.requestId === this.selectRequest);
    if (requested) this.selectRequest = "";
    const keep = ready.find((m) => m.id.toString() === previous);
    const choice = requested ?? keep;
    select.value = choice ? choice.id.toString() : "demo";
  }
}
