#!/usr/bin/env node
/**
 * The single source of truth for what `pnpm verify` (bin/verify.mjs) runs
 * locally, and what CI runs per lane. Unlike the m3l-automation prior art
 * this is adapted from -- which needed a SEPARATE `check-verify-parity.mjs`
 * gate to keep this list honest against a hand-written `ci.yml` -- this
 * baseline inverts the dependency: `.github/workflows/ci.yml`'s job steps
 * each invoke `node bin/verify.mjs --step <id>` directly, naming an id from
 * this file, so parity is structural rather than a second gate to maintain.
 *
 * Each step's `cmd` is the argv array to run (via `node:child_process`
 * `spawnSync`, stdio inherited so failures are visible directly).
 */
export const VERIFY_STEPS = [
  { id: "format", name: "Format check", cmd: ["pnpm", "format:check"] },
  { id: "lint", name: "Lint", cmd: ["pnpm", "lint"] },
  { id: "typecheck", name: "Typecheck", cmd: ["pnpm", "typecheck"] },
  { id: "build", name: "Build", cmd: ["pnpm", "build"] },
  { id: "test", name: "Test (coverage)", cmd: ["pnpm", "test:coverage"] },
  {
    id: "exports",
    name: "Check package exports",
    cmd: ["node", "bin/check-exports.mjs"],
  },
  {
    id: "node-version",
    name: "Check Node version pin",
    cmd: ["node", "bin/check-node-version.mjs"],
  },
];

/** Look up one step by id, or `undefined` if no step has that id. */
export function findStep(id) {
  return VERIFY_STEPS.find((step) => step.id === id);
}
