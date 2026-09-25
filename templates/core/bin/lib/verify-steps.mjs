#!/usr/bin/env node
/**
 * The single source of truth for what `pnpm verify` runs locally, what the
 * lefthook `pre-push` lanes run, and what each `.github/workflows/ci.yml`
 * job runs.
 *
 * Two words, two meanings: a *step* is one gate (e.g. "Lint", cmd
 * `pnpm lint`); a *group* is one of five fixed buckets a step belongs to
 * (`format`/`lint`/`typecheck`/`build`/`test`, see GROUPS below). A *lane* is
 * the outside caller that runs a whole group at once -- a lefthook
 * `pre-push` lane, or a CI job in `.github/workflows/ci.yml`. Both YAML files
 * name a *group*, never a step id: that's what lets a new step -- core or
 * pack-contributed -- join `pnpm verify` without ever touching either YAML
 * file, and what keeps this the one list to keep in sync instead of three
 * that agree by hand.
 *
 * Pack-installed steps live in verify-steps.packs.json, a plain JSON array
 * the bootstrapper CLI appends to when installing a pack -- it has no JS
 * parser and never gains one. A missing file means no packs are installed.
 * A present-but-malformed file is a hard failure, never a silent fallback
 * to core-only: a typo'd `group` would otherwise mean a step that runs in
 * `pnpm verify` and in no gate at all, which is exactly the drift this file
 * exists to prevent.
 *
 * Each step's `cmd` is the argv array to run (via `node:child_process`
 * `spawnSync`, stdio inherited so failures are visible directly).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GROUPS = ["format", "lint", "typecheck", "build", "test"];

/**
 * The gate steps this project ships out of the box, before any pack's own
 * steps are appended.
 * @public Not imported anywhere else in this project -- exported only so
 * m3l-groundwork can compare it against its own upstream copy when it
 * updates this tooling.
 */
export const CORE_STEPS = [
  {
    id: "format",
    group: "format",
    name: "Format check",
    cmd: ["pnpm", "format:check"],
  },
  { id: "lint", group: "lint", name: "Lint", cmd: ["pnpm", "lint"] },
  {
    id: "harness",
    group: "lint",
    name: "Check Claude Code harness",
    cmd: ["node", "bin/check-harness.mjs"],
  },
  {
    id: "toolchain",
    group: "lint",
    name: "Check TypeScript toolchain",
    cmd: ["node", "bin/check-toolchain.mjs"],
  },
  {
    id: "knip",
    group: "lint",
    name: "Check unused code and dependencies",
    cmd: ["pnpm", "knip"],
  },
  {
    id: "typecheck",
    group: "typecheck",
    name: "Typecheck",
    cmd: ["pnpm", "typecheck"],
  },
  { id: "build", group: "build", name: "Build", cmd: ["pnpm", "build"] },
  {
    id: "test",
    group: "test",
    name: "Test (coverage)",
    cmd: ["pnpm", "test:coverage"],
  },
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
];

/** Reads and validates verify-steps.packs.json. Absence is fine (no packs installed). */
function readPackSteps() {
  const path = fileURLToPath(
    new URL("./verify-steps.packs.json", import.meta.url),
  );
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("verify-steps.packs.json must be a JSON array of steps");
  }
  for (const step of parsed) {
    for (const field of ["id", "group", "name"]) {
      if (typeof step?.[field] !== "string") {
        throw new Error(
          `verify-steps.packs.json: a step is missing "${field}"`,
        );
      }
    }
    if (!Array.isArray(step.cmd) || step.cmd.length === 0) {
      throw new Error(`verify-steps.packs.json: step "${step.id}" has no cmd`);
    }
    if (!GROUPS.includes(step.group)) {
      throw new Error(
        `verify-steps.packs.json: step "${step.id}" has unknown group "${step.group}" -- known: ${GROUPS.join(", ")}`,
      );
    }
  }
  return parsed;
}

export const VERIFY_STEPS = [...CORE_STEPS, ...readPackSteps()];

/** Look up one step by id, or `undefined` if no step has that id. */
export function findStep(id) {
  return VERIFY_STEPS.find((step) => step.id === id);
}

/** All steps belonging to one group, in VERIFY_STEPS order. */
export function stepsInGroup(group) {
  return VERIFY_STEPS.filter((step) => step.group === group);
}
