import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "upload", include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
