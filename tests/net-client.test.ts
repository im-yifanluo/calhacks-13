import { describe, expect, test } from "vitest";
import { initialRetryDelayMs, tokenRejected } from "../apps/web/src/net";

describe("connection", () => {
  test("only a 401 token exchange counts as a rejected token", () => {
    const error = (name: string, status?: number) =>
      Object.assign(new Error("Failed to verify token"), { name, status });
    expect(tokenRejected(error("WebSocketTokenError", 401))).toBe(true);
    expect(tokenRejected(error("WebSocketTokenError", 500))).toBe(false);
    expect(tokenRejected(error("TypeError"))).toBe(false);
    expect(tokenRejected("401")).toBe(false);
  });

  test("first-connection retries back off to 30 s", () => {
    expect([1, 2, 3, 6, 20].map(initialRetryDelayMs)).toEqual([
      1000, 2000, 4000, 30000, 30000,
    ]);
  });
});
