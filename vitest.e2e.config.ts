// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts: the end-to-end bootstrap test spawns real
// child processes (the built CLI, then `pnpm install`/`pnpm verify` inside
// the emitted project) and is slow and network-touching by design, so it is
// excluded from the default `**/*.e2e.test.ts`-excluding unit run and only
// executes via `pnpm test:e2e`.
export default defineConfig({
  test: {
    include: ["**/*.e2e.test.ts"],
    exclude: [
      "**/dist/**",
      "**/node_modules/**",
      "**/templates/**",
      "packages/cli/plugin/**",
      // Same reason as vitest.config.ts.
      "**/.claude/worktrees/**",
    ],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // `pack.e2e.test.ts`'s reproducible-build case deletes and rebuilds
    // `packages/{cli,plugin}/dist` in place mid-test. Every other e2e file
    // (bootstrap/adopt/packs*) runs the CLI via `packages/cli/bin/m3l-groundwork.mjs`,
    // which imports `../dist/main.js` -- with file-level parallelism on
    // (Vitest's default), one of those files could hit a missing `dist/`
    // mid-run in a separate worker while the reproducible-build case has it
    // torn down. Serializing files avoids that race; it costs wall-clock
    // time, which this already-slow, opt-in suite (`pnpm test:e2e`, never
    // part of `pnpm test`) can afford.
    fileParallelism: false,
  },
});
