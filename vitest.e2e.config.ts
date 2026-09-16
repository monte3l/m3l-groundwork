import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts: the end-to-end bootstrap test spawns real
// child processes (the built CLI, then `pnpm install`/`pnpm verify` inside
// the emitted project) and is slow and network-touching by design, so it is
// excluded from the default `**/*.e2e.test.ts`-excluding unit run and only
// executes via `pnpm test:e2e`.
export default defineConfig({
  test: {
    include: ["**/*.e2e.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**", "templates/**"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
