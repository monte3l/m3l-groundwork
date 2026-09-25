import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["**/tests/**/*.test.ts", "**/*.test.ts"],
    exclude: [
      "**/dist/**",
      "**/node_modules/**",
      "**/templates/**",
      // A background agent's worktree (see .prettierignore) is a full
      // second checkout under here, with its own tests/ trees -- without
      // this every test in the repo runs twice, once per copy.
      "**/.claude/worktrees/**",
      "packages/cli/plugin/**",
      // The end-to-end bootstrap test spawns real child processes (git,
      // pnpm install) into a temp directory and is slow by design; it is
      // run explicitly via `test:e2e`, not as part of the default unit run.
      "**/*.e2e.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.d.ts"],
      reporter: ["text", "html", "json"],
      thresholds: {
        // This repo's own coverage floor, not a placeholder: 80% perFile
        // across all four metrics, deliberately the same shape as
        // templates/core's own gate (see CLAUDE.md's "Testing"). perFile is
        // what stops one well-covered file from hiding an undertested one --
        // see git.test.ts / main-run.test.ts for the patterns this repo uses
        // to close that kind of gap without mocking away the thing under test.
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        perFile: true,
      },
    },
  },
});
