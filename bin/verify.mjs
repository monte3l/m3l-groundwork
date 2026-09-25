#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `pnpm verify` -- runs every step in VERIFY_STEPS (bin/lib/verify-steps.mjs)
 * sequentially and reports pass/fail for each. `--group <name>` runs every
 * step in one of the five fixed groups (format/lint/typecheck/build/test);
 * `.github/workflows/ci.yml` and `lefthook.yml` each invoke `--group <name>`,
 * never individual step ids, so a new step is picked up by both without
 * either file changing. `--step <id>` runs a single named step and survives
 * for local debugging only -- it must never appear in either YAML file.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  VERIFY_STEPS,
  GROUPS,
  findStep,
  stepsInGroup,
} from "./lib/verify-steps.mjs";

const args = process.argv.slice(2);
const stepIndex = args.indexOf("--step");
if (stepIndex !== -1 && !args[stepIndex + 1]) {
  console.error("verify: --step requires a value");
  process.exit(1);
}
const requestedId = stepIndex === -1 ? null : args[stepIndex + 1];
const groupIndex = args.indexOf("--group");
if (groupIndex !== -1 && !args[groupIndex + 1]) {
  console.error("verify: --group requires a value");
  process.exit(1);
}
const requestedGroup = groupIndex === -1 ? null : args[groupIndex + 1];

if (requestedGroup && !GROUPS.includes(requestedGroup)) {
  console.error(
    `verify: unknown group "${requestedGroup}" -- known groups: ${GROUPS.join(", ")}`,
  );
  process.exit(1);
}

const steps = requestedId
  ? [findStep(requestedId)].filter((step) => step !== undefined)
  : requestedGroup
    ? stepsInGroup(requestedGroup)
    : VERIFY_STEPS;

if (requestedId && steps.length === 0) {
  console.error(
    `verify: unknown step "${requestedId}" -- known ids: ${VERIFY_STEPS.map((s) => s.id).join(", ")}`,
  );
  process.exit(1);
}

let failed = false;
for (const step of steps) {
  console.log(`\n▶ ${step.name} (${step.id})`);
  const [cmd, ...cmdArgs] = step.cmd;
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    failed = true;
    console.error(`✗ ${step.name} failed`);
    if (!requestedId && !requestedGroup) {
      // Local `pnpm verify` (no --step/--group): keep going so a single
      // early failure doesn't hide every other failing step in the same run.
      continue;
    }
    break;
  }
  console.log(`✓ ${step.name}`);
}

process.exit(failed ? 1 : 0);
