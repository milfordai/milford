import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // A layer starts and stops its own server process; give that room to breathe.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
