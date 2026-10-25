/** Operator check: discovery and real SQL reads, no memories/rooms/storage writes. */
const base = new URL(process.argv[2] || process.env.UPLOAD_URL || "http://127.0.0.1:8788");
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
  throw new Error("Provide the upload service's HTTP(S) base URL without credentials or query parameters");
const endpoint = base.href.replace(/\/$/, "");
try {
  const response = await fetch(`${endpoint}/api/identity`, { method: "POST", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Identity endpoint returned HTTP ${response.status}; check STDB_HTTP_URL`);
  const { identity, token } = await response.json();
  if (!/^(0x)?[a-f0-9]{64}$/i.test(identity) || typeof token !== "string") throw new Error("Invalid identity response");
  const report = await fetch(`${endpoint}/api/connections?identity=${identity.replace(/^0x/, "")}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (![200, 503].includes(report.status)) throw new Error(`Connections endpoint returned HTTP ${report.status}`);
  const body = await report.json();
  if (!body.interfaces || !body.database?.checks) throw new Error("Invalid connections response");
  console.log(JSON.stringify(body, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(`Connection check failed: ${error.message}`);
  process.exitCode = 1;
}
