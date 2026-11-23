// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts: the end-to-end tests spawn real child
// processes (the built CLI, then `pnpm install`/`pnpm verify` inside the
// emitted project) and are slow and network-touching by design, so they are
// excluded from the default `**/*.e2e.test.ts`-excluding unit run and only
// execute via `pnpm test:e2e`.
const shared = {
  exclude: [
    "**/dist/**",
    "**/node_modules/**",
    "templates/**",
    "packages/cli/templates/**",
    "packages/cli/plugin/**",
    // Same reason as vitest.config.ts.
    "**/.claude/worktrees/**",
    "_site/**",
  ],
  testTimeout: 300_000,
  hookTimeout: 300_000,
};

// The one file that cannot share the run: `pack.e2e.test.ts`'s
// reproducible-build case deletes and rebuilds `packages/{cli,plugin}/dist`
// in place mid-test, and every other e2e file runs the CLI through
// `packages/cli/bin/m3l-groundwork.mjs`, which imports `../dist/main.js`.
const packFile = "packages/cli/tests/pack.e2e.test.ts";

// Two projects ordered by `sequence.groupOrder` (Vitest 3.2+): every group-0
// file runs in parallel, and only once they have all finished does group 1
// start, so nothing is running while `dist/` is torn down. Serialising all
// seventeen files for the sake of one cost ~2x wall-clock, mostly in the
// macOS job, where each file's `pnpm install` + `pnpm verify` is CPU-bound
// and the runner has three vCPUs. `maxWorkers` is left at its default so a
// runner or laptop gets as many workers as it has cores.
export default defineConfig({
  test: {
    // EXPERIMENT: pin the worker pool to the macOS runner's three vCPUs.
    maxWorkers: 3,
    projects: [
      {
        test: {
          ...shared,
          name: "e2e",
          include: ["**/*.e2e.test.ts"],
          exclude: [...shared.exclude, packFile],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...shared,
          name: "e2e-pack",
          include: [packFile],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
