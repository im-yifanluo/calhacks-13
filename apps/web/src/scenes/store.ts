import type { ImportedScene } from "./bundle";
import { savedAccount, type AccountKey } from "../account/key";
export type OwnedScene = ImportedScene & { account: string };
export function sceneAccount(
  account: Pick<AccountKey, "server" | "database" | "identity"> | undefined,
): string | undefined {
  return account ? JSON.stringify([account.server, account.database, account.identity]) : undefined;
}
export function belongsToAccount(scene: { account?: string }, account: string | undefined) {
  return !!account && scene.account === account;
}
const DB = "memos-local-scenes-v1";
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("scenes", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Local storage is unavailable. Allow website storage or use a normal browser tab."));
  });
}
async function query<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("scenes", mode),
        req = run(tx.objectStore("scenes"));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () =>
        reject(
          new Error(
            tx.error?.name === "QuotaExceededError"
              ? "This browser is out of storage. Free some space and import again."
              : "Could not save or read this local scene.",
          ),
        );
    });
  } finally {
    db.close();
  }
}
export async function saveImportedScene(scene: ImportedScene, account = sceneAccount(savedAccount())) {
  if (!account) throw new Error("Sign in with your name or password before importing a memory.");
  const existing = await query<OwnedScene | undefined>("readonly", (store) => store.get(scene.id));
  if (existing && !belongsToAccount(existing, account))
    throw new Error("This import belongs to another account. Import the original package again.");
  return query("readwrite", (store) => store.put({ ...scene, account }));
}
export async function getImportedScene(id: string, account = sceneAccount(savedAccount())) {
  if (!account) return undefined;
  const scene = await query<OwnedScene | undefined>("readonly", (store) => store.get(id));
  return scene && belongsToAccount(scene, account) ? scene : undefined;
}
export async function listImportedScenes(account = sceneAccount(savedAccount())) {
  if (!account) return [];
  const scenes = await query<OwnedScene[]>("readonly", (store) => store.getAll());
  return scenes.filter((scene) => belongsToAccount(scene, account));
}
export const localSceneLink = (id: string) => `/?import=${encodeURIComponent(id)}`;
