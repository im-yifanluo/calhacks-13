import { defineConfig } from "vitest/config";
import { spacetimedbModuleTestPlugin } from "spacetimedb/server/test-utils/vitest";

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin()],
  test: { name: "spacetime", include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
