import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["**/tests/**/*.test.ts", "**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // No "**/index.ts" exclusion here (unlike a multi-module library
      // barrel pattern): a fresh scaffold's index.ts IS its real content,
      // so excluding it would make this gate measure nothing at all.
      exclude: ["**/*.d.ts"],
      // json emits coverage-final.json: the v8 text table hides files that
      // are 100% on every metric, so the JSON is the authoritative
      // per-file record when investigating a suspected gap.
      reporter: ["text", "html", "json"],
      thresholds: {
        // Scaffold-appropriate starting floor. Raise these to the project's
        // own measured floor once real coverage exists (perFile means every
        // file must individually clear each threshold, not just the
        // aggregate) -- never lower a threshold to make a red gate pass.
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        perFile: true,
      },
    },
  },
});
