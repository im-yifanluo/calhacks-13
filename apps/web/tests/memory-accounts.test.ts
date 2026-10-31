import { expect, test } from "vitest";
import { Identity } from "spacetimedb";
import { Multiplayer } from "../src/net";
import { sceneAccount, belongsToAccount } from "../src/scenes/store";
import { IDBFactory } from "fake-indexeddb";
import { getImportedScene, saveImportedScene, listImportedScenes } from "../src/scenes/store";

test("libraries are owner scoped while the active party can reference another owner’s memory", () => {
  const alice = new Identity(1n),
    bob = new Identity(2n);
  const rows = [
    { id: 1n, owner: alice },
    { id: 2n, owner: bob },
  ];
  const net = Object.create(Multiplayer.prototype);
  net.identity = alice;
  net.connection = {
    db: { memory: { iter: () => rows, id: { find: (id: bigint) => rows.find((r) => r.id === id) } } },
  };
  Object.defineProperty(net, "room", { value: { memoryId: 2n } });
  expect(net.memories.map((m: any) => m.id)).toEqual([1n]);
  expect(net.memory.id).toBe(2n);
  net.identity = bob;
  expect(net.memories.map((m: any) => m.id)).toEqual([2n]);
  net.identity = undefined;
  expect(net.memories).toEqual([]);
});

test("local imports are bound to server, database and identity, including direct-link access", () => {
  const account = { server: "https://db.example", database: "memos", identity: "a".repeat(64) };
  const owner = sceneAccount(account),
    scene = { account: owner };
  expect(belongsToAccount(scene, owner)).toBe(true);
  for (const other of [
    undefined,
    sceneAccount({ ...account, identity: "b".repeat(64) }),
    sceneAccount({ ...account, database: "other" }),
  ])
    expect(belongsToAccount(scene, other)).toBe(false);
  expect(belongsToAccount({}, owner)).toBe(false); // Legacy unowned imports are never silently claimed.
});

test("IndexedDB saves and direct-link reads isolate two accounts without deleting either library", async () => {
  globalThis.indexedDB = new IDBFactory();
  const a = "account-a",
    b = "account-b";
  await saveImportedScene(
    { id: "alice-scene", title: "Alice scene", files: { "scene.bin": new Blob(["alice"]) } } as any,
    a,
  );
  await saveImportedScene({ id: "bob-scene", title: "Bob scene", files: { "scene.bin": new Blob(["bob"]) } } as any, b);
  expect((await listImportedScenes(a)).map((s) => s.id)).toEqual(["alice-scene"]);
  expect((await listImportedScenes(b)).map((s) => s.id)).toEqual(["bob-scene"]);
  expect(await getImportedScene("alice-scene", b)).toBeUndefined();
  expect(await getImportedScene("alice-scene", "")).toBeUndefined();
  await expect(saveImportedScene({ id: "alice-scene" } as any, b)).rejects.toThrow("another account");
  expect(await (await getImportedScene("alice-scene", a))!.files["scene.bin"].text()).toBe("alice");
});
