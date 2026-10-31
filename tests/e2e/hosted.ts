import { readFileSync } from "node:fs";

/** The hosted site's public settings (apps/web/.env.hosted): the defaults these suites test against. */
export const hosted: Record<string, string> = Object.fromEntries(
  readFileSync(new URL("../../apps/web/.env.hosted", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);
