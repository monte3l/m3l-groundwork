#!/usr/bin/env node
/**
 * The single source of truth for what `pnpm verify` (bin/verify.mjs) runs
 * locally, what each `lefthook.yml` pre-push lane runs, and what each
 * `.github/workflows/ci.yml` lane job runs. Both YAML files name a *group*,
 * never a step id: groups are a closed, five-member set (see GROUPS below);
 * steps are not. That is what lets a new step join every gate at once
 * without either YAML file changing, and why there is one list here instead
 * of three that agree by hand.
 *
 * Same shape as the baseline this repo emits
 * (templates/core/bin/lib/verify-steps.mjs), minus that file's
 * pack-contributed steps -- only a bootstrapped project installs packs.
 *
 * Each step's `cmd` is the argv array to run (via `node:child_process`
 * `spawnSync`, stdio inherited so failures are visible directly).
 */
export const GROUPS = ["format", "lint", "typecheck", "build", "test"];

export const VERIFY_STEPS = [
  {
    id: "format",
    group: "format",
    name: "Format check",
    cmd: ["pnpm", "format:check"],
  },
  { id: "lint", group: "lint", name: "Lint", cmd: ["pnpm", "lint"] },
  {
    id: "knip",
    group: "lint",
    name: "Check unused code and dependencies",
    cmd: ["pnpm", "knip"],
  },
  {
    id: "harness",
    group: "lint",
    name: "Check emitted harness",
    cmd: ["node", "bin/check-harness.mjs"],
  },
  {
    id: "toolchain",
    group: "lint",
    name: "Check emitted toolchain",
    cmd: ["node", "bin/check-toolchain.mjs"],
  },
  {
    id: "typecheck",
    group: "typecheck",
    name: "Typecheck",
    cmd: ["pnpm", "typecheck"],
  },
  // `build` precedes `exports` deliberately: stepsInGroup() preserves this
  // order, and check-exports.mjs reads dist/, which only exists after build.
  { id: "build", group: "build", name: "Build", cmd: ["pnpm", "build"] },
  {
    id: "exports",
    group: "build",
    name: "Check package exports",
    cmd: ["node", "bin/check-exports.mjs"],
  },
  {
    id: "node-version",
    group: "build",
    name: "Check Node version pin",
    cmd: ["node", "bin/check-node-version.mjs"],
  },
  {
    id: "test",
    group: "test",
    name: "Test (coverage)",
    cmd: ["pnpm", "test:coverage"],
  },
];

/** Look up one step by id, or `undefined` if no step has that id. */
export function findStep(id) {
  return VERIFY_STEPS.find((step) => step.id === id);
}

/** All steps belonging to one group, in VERIFY_STEPS order. */
export function stepsInGroup(group) {
  return VERIFY_STEPS.filter((step) => step.group === group);
}
