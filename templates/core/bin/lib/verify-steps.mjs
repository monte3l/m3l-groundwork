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
 * How bin/verify.mjs treats a step's outcome lives in verify-policy.json, a
 * plain JSON object read the same way (and likewise editable without a JS
 * parser): `{"version": 1, "testsBlocking": true, "ciSkipGroups": []}`.
 * `testsBlocking: false` turns a failing `test`-group step into a warning;
 * `ciSkipGroups` may only list "test" (the one group that is safe to leave to
 * local runs), skipped when the `CI` environment variable is set (to anything
 * but "", "false" or "0"). A missing file means those defaults. A present file
 * must carry all three keys: a partial file does not fall back to defaults,
 * and a malformed one (wrong version, a missing or wrong-typed key, any group
 * but "test" in `ciSkipGroups`, an unknown key) is a hard failure at import
 * time, before any step runs. ci.yml and lefthook.yml never change for either
 * setting.
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
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`verify-steps.packs.json: cannot read ${path}`, {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`verify-steps.packs.json: failed to parse ${path}`, {
      cause: error,
    });
  }
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

const POLICY_DEFAULTS = { version: 1, testsBlocking: true, ciSkipGroups: [] };
const POLICY_KEYS = Object.keys(POLICY_DEFAULTS);

/** The only group `ciSkipGroups` may list: every other gate always runs in CI. */
const CI_SKIPPABLE_GROUP = "test";

/**
 * Reads and validates verify-policy.json. Absence means POLICY_DEFAULTS; a
 * present file must carry every key (a partial file is malformed, not merged
 * with the defaults), and anything malformed throws, naming the file.
 * `version` is checked first so a file from a newer policy format reports
 * that, not the new keys it introduced.
 */
function readPolicy() {
  const path = fileURLToPath(new URL("./verify-policy.json", import.meta.url));
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return POLICY_DEFAULTS;
    throw new Error(`verify-policy.json: cannot read ${path}`, {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`verify-policy.json: failed to parse ${path}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("verify-policy.json must be a JSON object");
  }
  if (parsed.version !== 1) {
    throw new Error(
      `verify-policy.json: "version" must be 1, got ${JSON.stringify(parsed.version)}`,
    );
  }
  // Object.keys sees an own "__proto__" or "constructor" key (JSON.parse
  // creates both as plain own properties), so neither slips past this check.
  for (const key of Object.keys(parsed)) {
    if (!POLICY_KEYS.includes(key)) {
      throw new Error(
        `verify-policy.json: unknown key "${key}" -- known: ${POLICY_KEYS.join(", ")}`,
      );
    }
  }
  if (typeof parsed.testsBlocking !== "boolean") {
    throw new Error('verify-policy.json: "testsBlocking" must be a boolean');
  }
  if (!Array.isArray(parsed.ciSkipGroups)) {
    throw new Error('verify-policy.json: "ciSkipGroups" must be an array');
  }
  for (const group of parsed.ciSkipGroups) {
    if (group !== CI_SKIPPABLE_GROUP) {
      throw new Error(
        `verify-policy.json: "ciSkipGroups" may only list "${CI_SKIPPABLE_GROUP}", got ${JSON.stringify(group)}`,
      );
    }
  }
  return parsed;
}

/**
 * The validated verify-policy.json (or its defaults when the file is
 * absent). Read at import time so a malformed file fails before any step
 * runs.
 */
export const VERIFY_POLICY = readPolicy();

/** Look up one step by id, or `undefined` if no step has that id. */
export function findStep(id) {
  return VERIFY_STEPS.find((step) => step.id === id);
}

/** All steps belonging to one group, in VERIFY_STEPS order. */
export function stepsInGroup(group) {
  return VERIFY_STEPS.filter((step) => step.group === group);
}
