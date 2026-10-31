import { createHmac, timingSafeEqual } from "node:crypto";

// Signed, expiring tickets (upload receipts, local PUT URLs, scene parts), so the service keeps no upload state.
export function ticket(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
export function readTicket(value, secret) {
  const [data, sig] = String(value).split(".");
  const expected = createHmac("sha256", secret)
    .update(data ?? "")
    .digest();
  const received = Buffer.from(sig ?? "", "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw new Error("Invalid upload receipt");
  const payload = JSON.parse(Buffer.from(data, "base64url").toString());
  if (payload.expires < Date.now()) throw new Error("Upload receipt expired; request a new upload");
  return payload;
}
