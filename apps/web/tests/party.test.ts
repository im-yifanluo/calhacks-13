import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { Identity } from "spacetimedb";
import { Notice, NOTICE_MS } from "../src/party/notice";
import { Avatars, deviceKind, handVisible, HIDE_NEAR_M, playerColor } from "../src/party/presence";
import {
  claimReload,
  loadedManifest,
  normalizeCode,
  RELOAD_GUARD_KEY,
  rememberRoomManifest,
  resolveManifestUrl,
  roomCode,
  roomUrl,
  sameManifest,
} from "../src/party/routes";
import type { Player } from "../src/net";

describe("messages", () => {
  afterEach(() => vi.useRealTimers());

  test("information expires after about 6 s; a newer message replaces an older one", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const panel = new Notice((text, error) => shown.push(`${error ? "error" : "info"}: ${text}`));
    panel.show("Added “Kitchen” to the library.");
    expect(NOTICE_MS).toBeGreaterThanOrEqual(5000);
    expect(NOTICE_MS).toBeLessThanOrEqual(7000);
    vi.advanceTimersByTime(NOTICE_MS - 100);
    expect(panel.text).toBe("Added “Kitchen” to the library.");
    // The later error replaces it, instead of sitting next to it.
    panel.show("Could not add it to the library: Expected an HTTP(S) asset URL", { kind: "library", error: true });
    expect(shown.at(-1)).toBe("error: Could not add it to the library: Expected an HTTP(S) asset URL");
    vi.advanceTimersByTime(60_000); // errors do not expire, and the replaced message's timer does nothing
    expect([panel.text, panel.error]).toEqual(["Could not add it to the library: Expected an HTTP(S) asset URL", true]);
    panel.show("Room link copied.");
    expect(panel.error).toBe(false);
    vi.advanceTimersByTime(NOTICE_MS);
    expect(panel.text).toBe("");
    expect(shown.at(-1)).toBe("info: ");
    panel.show("https://example.test/?room=ABC1234", { persist: true }); // a link to copy by hand
    vi.advanceTimersByTime(60_000);
    expect(panel.text).toBe("https://example.test/?room=ABC1234");
  });

  test("an error clears once an action of the same kind succeeds, and not before", () => {
    const panel = new Notice(() => {});
    panel.show("Could not join room ZZZ9999: Room not found", { kind: "room", error: true });
    panel.resolve("library");
    expect(panel.text).toBe("Could not join room ZZZ9999: Room not found");
    panel.resolve("room");
    expect(panel.text).toBe("");
    panel.show("Added “Kitchen” to the library.", { kind: "library" });
    panel.resolve("library"); // a success never clears information early
    expect(panel.text).toBe("Added “Kitchen” to the library.");
  });

  test("the shared status line returns to the room hint, but never wipes the viewer's own message", () => {
    vi.useFakeTimers();
    const hint = "In room ABC1234. Pause to grab and throw; everyone sees the same take.";
    let line = "";
    const status = new Notice(
      (text) => (line = text),
      (text) => line === text,
      () => hint,
    );
    status.show(hint, { persist: true });
    vi.advanceTimersByTime(NOTICE_MS * 3);
    expect(line).toBe(hint);
    status.show("You no longer hold the ball: the room released it.", { kind: "hold" });
    vi.advanceTimersByTime(NOTICE_MS);
    expect(line).toBe(hint);
    status.show("Could not change the shared clock: Wait for objects to settle or release them first", {
      kind: "clock",
      error: true,
    });
    vi.advanceTimersByTime(60_000);
    expect(line).toMatch(/^Could not change the shared clock/);
    status.resolve("clock"); // the next play, pause or seek went through
    expect(line).toBe(hint);
    status.show("Could not grab the ball: Object is owned by another player", { kind: "grab", error: true });
    line = "Holding ball. Move and release to throw."; // the viewer wrote over it
    status.resolve("grab");
    expect(line).toBe("Holding ball. Move and release to throw.");
    status.show("Ignored an unreadable part of a recorded throw of the ball.", { kind: "data" });
    line = "Recording this throw. Play the take to replay it, or switch to Original.";
    vi.advanceTimersByTime(NOTICE_MS);
    expect(line).toBe("Recording this throw. Play the take to replay it, or switch to Original.");
  });
});

const page = "http://127.0.0.1:5184/";

describe("room URLs and manifests", () => {
  test("a renamed site resolves old scene links and cached room manifests on its new origin", () => {
    vi.stubEnv("VITE_ASSET_ORIGIN_ALIASES", "https://old.example");
    try {
      const base = "https://memos.example/ABC1234";
      const old = "https://old.example/demo/memory.json?take=1";
      const current = "https://memos.example/demo/memory.json?take=1";
      expect(resolveManifestUrl(old, base)).toBe(current);
      expect(sameManifest(old, current, base)).toBe(true);
      expect(loadedManifest(base, { getItem: () => old })).toBe(current);
      expect(resolveManifestUrl("https://cdn.example/memory.json", base)).toBe("https://cdn.example/memory.json");
      expect(resolveManifestUrl("https://old.example.evil.test/memory.json", base)).toBe(
        "https://old.example.evil.test/memory.json",
      );
      expect(resolveManifestUrl("http://old.example/memory.json", base)).toBe("http://old.example/memory.json");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the loaded manifest is ?memory=, else the demo default, made absolute", () => {
    expect(loadedManifest(page)).toBe(`${page}demo/memory.json`);
    expect(loadedManifest(`${page}?memory=/local/a/memory.json&room=X`)).toBe(`${page}local/a/memory.json`);
    expect(loadedManifest(`${page}?memory=${encodeURIComponent("https://cdn.example/m/memory.json")}`)).toBe(
      "https://cdn.example/m/memory.json",
    );
  });

  test("a relative manifest equals its absolute form; another file or query does not", () => {
    expect(sameManifest("/mock/memory.json", `${page}mock/memory.json`, page)).toBe(true);
    expect(sameManifest("/mock/memory.json", `${page}mock/memory.json?copy=2`, page)).toBe(false);
    expect(sameManifest("/mock/memory.json", "https://other.example/mock/memory.json", page)).toBe(false);
  });

  test("party addresses use /CODE and leaving always returns to the server root", () => {
    const local = `${page}?memory=%2Flocal%2Fa.json#x`;
    expect(roomUrl(local, "ABC1234")).toBe(`${page}ABC1234`);
    expect(roomUrl(`${page}?room=ABC1234`, null)).toBe(page);
    expect(roomUrl(`${page}ABC1234?memory=/local/a.json#x`, null)).toBe(page);
    expect(roomUrl(`${page}upload?room=OLD`, " new1234 ")).toBe(`${page}NEW1234`);
    expect(roomUrl(`${page}ABC1234/`, "XYZ1234")).toBe(`${page}XYZ1234`);
  });

  test("direct paths and legacy links resolve the same room; unrelated paths stay solo", () => {
    expect(roomCode(`${page}abc1234/`)).toBe("ABC1234");
    expect(roomCode(`${page}?room=abc1234`)).toBe("ABC1234");
    expect(roomCode(`${page}ABC1234?room=XYZ1234`)).toBe("ABC1234");
    for (const path of ["", "upload", "capture.html", "assets/app.js", "ABC1234/extra", "abc"]) {
      expect(roomCode(page + path)).toBe("");
    }
  });

  test("a clean room address reloads its database-selected scene, without leaking into solo or another room", () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    expect(loadedManifest(`${page}ABC1234`, storage)).toBe(`${page}demo/memory.json`);
    rememberRoomManifest(storage, "abc1234", "https://cdn.example/scene/memory.json");
    expect(loadedManifest(`${page}ABC1234`, storage)).toBe("https://cdn.example/scene/memory.json");
    expect(loadedManifest(page, storage)).toBe(`${page}demo/memory.json`);
    expect(loadedManifest(`${page}XYZ1234`, storage)).toBe(`${page}demo/memory.json`);
    rememberRoomManifest(storage, "ABC1234", "https://cdn.example/next/memory.json");
    expect(loadedManifest(`${page}ABC1234`, storage)).toBe("https://cdn.example/next/memory.json");
    expect(roomUrl(`${page}ABC1234`, "ABC1234")).toBe(`${page}ABC1234`);
  });

  test("claimReload allows one automatic reload per target", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(claimReload(storage, "a")).toBe(true);
    expect(store.get(RELOAD_GUARD_KEY)).toBe("a");
    expect(claimReload(storage, "a")).toBe(false);
    expect(claimReload(storage, "b")).toBe(true);
  });

  test("room codes are trimmed and upper-cased", () => {
    expect(normalizeCode(" 0083v54 ")).toBe("0083V54");
    expect(normalizeCode(null)).toBe("");
  });
});

describe("presence", () => {
  test("device labels", () => {
    expect(deviceKind(true, "Mozilla/5.0 (Macintosh)", false)).toBe("quest");
    expect(deviceKind(false, "Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/38", false)).toBe("quest");
    expect(deviceKind(false, "Mozilla/5.0 (iPhone)", true)).toBe("phone");
    expect(deviceKind(false, "Mozilla/5.0 (Macintosh)", false)).toBe("desktop");
  });

  test("hands only for headset rows that differ from the head", () => {
    const head = new THREE.Vector3(0, 1.6, 0);
    expect(handVisible("quest", head, new THREE.Vector3(0.3, 1.2, -0.2))).toBe(true);
    expect(handVisible("quest", head, head.clone())).toBe(false); // not tracked: head sent
    expect(handVisible("quest", head, new THREE.Vector3(0, 0, 0))).toBe(false); // default row
    expect(handVisible("desktop", head, new THREE.Vector3(0.3, 1.2, -0.2))).toBe(false);
  });

  test("player colors are readable on the dark scene", () => {
    const hsl = { h: 0, s: 0, l: 0 };
    for (const value of [0, 0x000001, 0x123456, 0xffffff]) {
      playerColor(value).getHSL(hsl);
      expect(hsl.l).toBeCloseTo(0.62, 2);
    }
  });

  describe("avatars", () => {
    afterEach(() => vi.unstubAllGlobals());
    const player = (id: bigint, extra: Partial<Player> = {}): Player => ({
      identity: new Identity(id),
      roomId: 1n,
      name: `P${id}`,
      device: "desktop",
      color: 0x336699,
      online: true,
      hx: 1,
      hy: 1.6,
      hz: 2,
      hqx: 0,
      hqy: 0,
      hqz: 0,
      hqw: 1,
      lx: 1,
      ly: 1.6,
      lz: 2,
      rx: 1,
      ry: 1.6,
      rz: 2,
      ...extra,
    });

    test("one avatar per other online player, snapped first, then smoothed, then removed", () => {
      vi.stubGlobal("document", {
        createElement: () => ({ width: 0, height: 0, getContext: () => null }),
      });
      const scene = new THREE.Scene();
      const avatars = new Avatars(scene);
      const me = player(1n);
      const other = player(2n, { device: "quest", lx: 0.7, ly: 1.2, lz: 1.8 });
      avatars.update([me, other, player(3n, { online: false })], me.identity, 1 / 60);
      expect(avatars.size).toBe(1);
      const root = avatars.group.children[0];
      const [head, left, right] = root.children;
      expect(head.position.toArray()).toEqual([1, 1.6, 2]);
      expect(left.visible).toBe(true); // tracked left hand
      expect(right.visible).toBe(false); // right row equals the head
      avatars.update([me, { ...other, hx: 2 }], me.identity, 1 / 60);
      expect(head.position.x).toBeGreaterThan(1);
      expect(head.position.x).toBeLessThan(2);
      avatars.update([me], me.identity, 1 / 60);
      expect(avatars.size).toBe(0);
      expect(avatars.group.children).toHaveLength(0);
      avatars.dispose();
      expect(scene.getObjectByName("avatars")).toBeUndefined();
    });

    test("an avatar sitting on your own camera is hidden until one of you moves", () => {
      vi.stubGlobal("document", {
        createElement: () => ({ width: 0, height: 0, getContext: () => null }),
      });
      const avatars = new Avatars(new THREE.Scene());
      const me = player(1n);
      const other = player(2n); // head at (1, 1.6, 2), where a fresh client's camera also starts
      avatars.update([me, other], me.identity, 1 / 60, new THREE.Vector3(1, 1.6, 2));
      const root = avatars.group.children[0];
      expect(root.visible).toBe(false);
      avatars.update([me, other], me.identity, 1 / 60, new THREE.Vector3(1, 1.6, 2 + HIDE_NEAR_M + 0.1));
      expect(root.visible).toBe(true);
      avatars.update([me, other], me.identity, 1 / 60); // no viewpoint: always shown
      expect(root.visible).toBe(true);
      avatars.dispose();
    });
  });
});
