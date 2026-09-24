import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/tests/**/*.test.ts"],
    // A layer starts and stops its own server process; give that room to breathe.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      reportsDirectory: "./coverage",
      exclude: ["**/dist/**", "**/node_modules/**", "test/**", "**/*.test.ts", "**/*.d.ts"],
    },
  },
});
