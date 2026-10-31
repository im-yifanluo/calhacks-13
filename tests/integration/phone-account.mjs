import assert from "node:assert/strict";
import { createServer } from "node:http";
import { databaseConfig } from "../../server/upload/src/database.mjs";
import { makeHandler } from "../../server/upload/src/handler.mjs";

// Deliberately require an explicit local test database; never default to production.
const database = process.env.STDB_DATABASE;
if (!database) throw new Error("Set STDB_DATABASE to a published local test database");
const db = databaseConfig({
  STDB_HTTP_URL: `http://127.0.0.1:${process.env.STDB_PORT || 3055}`,
  STDB_DATABASE: database,
  ACCOUNT_SERVER_URL: "http://127.0.0.1:5174/stdb",
});
const server = createServer(makeHandler({ ...db, allowedOrigins: [] }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const identity = await (await fetch(`${origin}/api/identity`, { method: "POST" })).json();
  const other = await (await fetch(`${origin}/api/identity`, { method: "POST" })).json();
  const register = (name, token = identity.token) =>
    fetch(`${origin}/api/account`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ identity: identity.identity, name }),
    });
  assert.equal((await register("Nikko test", other.token)).status, 401);
  const registered = await register("Nikko test");
  assert.equal(registered.status, 200);
  assert.deepEqual(await registered.json(), {
    identity: identity.identity,
    displayName: "Nikko test",
    provider: "key",
  });
  assert.equal((await register("Renamed")).status, 400);
  const destination = await (await fetch(`${origin}/api/account/config`)).json();
  const key = "memos1." + Buffer.from(JSON.stringify({ ...destination, ...identity })).toString("base64url");
  // A new device importing the portable key has the exact same verified account.
  const imported = JSON.parse(Buffer.from(key.slice(7), "base64url").toString());
  const profile = await fetch(`${origin}/api/profile?identity=${imported.identity}`, {
    headers: { Authorization: `Bearer ${imported.token}` },
  });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).displayName, "Nikko test");
  assert.equal(
    (
      await fetch(`${origin}/api/profile?identity=${other.identity}`, {
        headers: { Authorization: `Bearer ${imported.token}` },
      })
    ).status,
    401,
  );
  console.log(
    "PASS live native registration, portable identity, immutable name, and forged/mismatched token rejection",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
