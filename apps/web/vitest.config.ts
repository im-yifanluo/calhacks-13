import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "web",
    include: ["tests/**/*.test.ts"],
    // Node, not jsdom: the engine tests stub only the DOM pieces they need (jsdom has no canvas 2D
    // context, and its requestAnimationFrame would keep desktop input's walk loop running).
    environment: "node",
    testTimeout: 15000,
  },
});
