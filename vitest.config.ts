import { defineConfig } from "vitest/config";
import { spacetimedbModuleTestPlugin } from "spacetimedb/server/test-utils/vitest";

// `npm test` runs every package's unit tests plus the cross-package tests in tests/.
export default defineConfig({
  test: {
    projects: [
      "apps/web",
      "server/spacetime",
      "server/upload",
      {
        // Tests that load the real SpacetimeDB module together with web or upload code.
        plugins: [spacetimedbModuleTestPlugin()],
        test: { name: "integration", include: ["tests/*.test.ts"], testTimeout: 15000 },
      },
    ],
  },
});
