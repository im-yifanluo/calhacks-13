import { expect, test, vi } from "vitest";
import { randomUuid } from "../src/lib/ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uses crypto.randomUUID where the page is a secure context", () => {
  expect(randomUuid()).toMatch(UUID_V4);
});

test("LAN HTTP pages without randomUUID still get distinct canonical UUIDs", () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  try {
    const ids = Array.from({ length: 100 }, () => randomUuid());
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  } finally {
    vi.unstubAllGlobals();
  }
});
