// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    // Strips the inherited repo-local GIT_* variables (GIT_DIR,
    // GIT_INDEX_FILE, GIT_PREFIX and the rest of git's --local-env-vars
    // list, exported by git into hook processes such as pre-push) so tests
    // that spawn git act on their own fixtures, not the pushing repo. See
    // packages/cli/tests/git-env.ts's header comment.
    setupFiles: ["./packages/cli/tests/setup-git-env.ts"],
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
      // The docs site build output -- generated, never a test fixture.
      "_site/**",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.d.ts"],
      reporter: ["text", "html", "json"],
      thresholds: {
        // This repo's own coverage floor, not a placeholder: OpenSSF Best
        // Practices' Gold-level bar (90% statement, 80% branch), applied
        // perFile and to all four metrics rather than only the two the
        // criteria name -- deliberately the same shape as templates/core's
        // own gate (see CLAUDE.md's "Testing"). perFile is what stops one
        // well-covered file from hiding an undertested one -- see
        // git.test.ts / main-run.test.ts for the patterns this repo uses to
        // close that kind of gap without mocking away the thing under test.
        lines: 90,
        functions: 80,
        branches: 80,
        statements: 90,
        perFile: true,
      },
    },
  },
});
