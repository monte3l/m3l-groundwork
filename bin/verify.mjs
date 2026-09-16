#!/usr/bin/env node
/**
 * `pnpm verify` -- runs every step in VERIFY_STEPS (bin/lib/verify-steps.mjs)
 * sequentially and reports pass/fail for each. `--step <id>` runs a single
 * named step, which is what each `.github/workflows/ci.yml` job invokes, so
 * the local command and the CI command are always the same command, never
 * two lists that can drift apart.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import { VERIFY_STEPS, findStep } from "./lib/verify-steps.mjs";

const args = process.argv.slice(2);
const stepIndex = args.indexOf("--step");
const requestedId = stepIndex === -1 ? null : args[stepIndex + 1];

const steps = requestedId
  ? [findStep(requestedId)].filter((step) => step !== undefined)
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
    if (!requestedId) {
      // Local `pnpm verify` (no --step): keep going so a single early
      // failure doesn't hide every other failing step in the same run.
      continue;
    }
    break;
  }
  console.log(`✓ ${step.name}`);
}

process.exit(failed ? 1 : 0);
