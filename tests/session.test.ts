import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { Identity } from "spacetimedb";
import {
  Avatars,
  claimReload,
  deviceKind,
  handVisible,
  loadedManifest,
  normalizeCode,
  playerColor,
  RELOAD_GUARD_KEY,
  roomUrl,
  sameManifest,
} from "../apps/web/src/session";
import type { Player } from "../apps/web/src/net";

const page = "http://127.0.0.1:5184/";

describe("room URLs and manifests", () => {
  test("the loaded manifest is ?memory=, else the demo default, made absolute", () => {
    expect(loadedManifest(page)).toBe(`${page}mock/memory.json`);
    expect(loadedManifest(`${page}?memory=/local/a/memory.json&room=X`)).toBe(
      `${page}local/a/memory.json`,
    );
    expect(
      loadedManifest(
        `${page}?memory=${encodeURIComponent("https://cdn.example/m/memory.json")}`,
      ),
    ).toBe("https://cdn.example/m/memory.json");
  });

  test("a relative manifest equals its absolute form; another file or query does not", () => {
    expect(
      sameManifest("/mock/memory.json", `${page}mock/memory.json`, page),
    ).toBe(true);
    expect(
      sameManifest("/mock/memory.json", `${page}mock/memory.json?copy=2`, page),
    ).toBe(false);
    expect(
      sameManifest(
        "/mock/memory.json",
        "https://other.example/mock/memory.json",
        page,
      ),
    ).toBe(false);
  });

  test("roomUrl sets or clears ?room= and keeps the page's memory unless told otherwise", () => {
    const local = `${page}?memory=%2Flocal%2Fa.json#x`;
    expect(roomUrl(local, "ABC1234")).toBe(
      `${page}?memory=%2Flocal%2Fa.json&room=ABC1234`,
    );
    expect(roomUrl(`${page}?room=ABC1234`, null)).toBe(page);
    const moved = new URL(
      roomUrl(`${page}upload?room=OLD`, "NEW", "http://h/m.json"),
    );
    expect(moved.pathname).toBe("/");
    expect(moved.searchParams.get("memory")).toBe("http://h/m.json");
    expect(moved.searchParams.get("room")).toBe("NEW");
    // The reloaded page must load exactly the room's manifest.
    expect(loadedManifest(moved.href)).toBe("http://h/m.json");
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
    expect(
      deviceKind(
        false,
        "Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/38",
        false,
      ),
    ).toBe("quest");
    expect(deviceKind(false, "Mozilla/5.0 (iPhone)", true)).toBe("phone");
    expect(deviceKind(false, "Mozilla/5.0 (Macintosh)", false)).toBe("desktop");
  });

  test("hands only for headset rows that differ from the head", () => {
    const head = new THREE.Vector3(0, 1.6, 0);
    expect(handVisible("quest", head, new THREE.Vector3(0.3, 1.2, -0.2))).toBe(
      true,
    );
    expect(handVisible("quest", head, head.clone())).toBe(false); // not tracked: head sent
    expect(handVisible("quest", head, new THREE.Vector3(0, 0, 0))).toBe(false); // default row
    expect(
      handVisible("desktop", head, new THREE.Vector3(0.3, 1.2, -0.2)),
    ).toBe(false);
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
      avatars.update(
        [me, other, player(3n, { online: false })],
        me.identity,
        1 / 60,
      );
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
  });
});
