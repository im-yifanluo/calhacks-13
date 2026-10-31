import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";

/** Atomic across local Node processes; ciphertext only. Keep this file on persistent disk. */
export function localPasswordStore(path) {
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS vault (id TEXT PRIMARY KEY, value TEXT NOT NULL, version TEXT NOT NULL)",
  );
  return {
    async read(key) {
      return db.prepare("SELECT value, version FROM vault WHERE id = ?").get(key) ?? null;
    },
    async write(key, value, version) {
      const next = randomUUID();
      const result = version
        ? db
            .prepare("UPDATE vault SET value = ?, version = ? WHERE id = ? AND version = ?")
            .run(value, next, key, version)
        : db.prepare("INSERT OR IGNORE INTO vault (id, value, version) VALUES (?, ?, ?)").run(key, value, next);
      return Number(result.changes) === 1;
    },
    close() {
      db.close();
    },
  };
}
