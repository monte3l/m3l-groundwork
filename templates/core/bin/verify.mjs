#!/usr/bin/env node
/**
 * `pnpm verify` -- runs every step in VERIFY_STEPS (bin/lib/verify-steps.mjs)
 * sequentially and reports pass/fail for each. `--step <id>` runs a single
 * named step; `--group <name>` runs every step in one of the five fixed
 * groups (format/lint/typecheck/build/test). `.github/workflows/ci.yml` and
 * `lefthook.yml` each invoke `--group <name>`, never individual step ids, so
 * a new step -- core or pack-contributed -- is picked up by both without
 * either file changing.
 *
 * "Group" and "lane" are two different things: a group is one of the five
 * fixed buckets above; a lane is the outside caller that runs a whole group
 * at once -- one lefthook `pre-push` lane, or one CI job in `ci.yml`.
 *
 * bin/lib/verify-policy.json (VERIFY_POLICY) adjusts how outcomes count,
 * without either YAML file changing: `testsBlocking: false` reports a
 * `test`-group step that ran and exited non-zero as a warning instead of a
 * failure (with `--step` too; a step that could not be spawned or was killed
 * by a signal still fails), and when `CI` is set to anything but "", "false" or "0", the groups
 * in `ciSkipGroups` are skipped with a notice. `--step` never skips: naming
 * one step is an explicit request to run it.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
// VERIFY_POLICY has no fallback here on purpose: paired with an older
// verify-steps.mjs that doesn't export it, this import fails loudly at link
// time instead of silently running with a default policy.
import {
  VERIFY_STEPS,
  GROUPS,
  VERIFY_POLICY,
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

const selected = requestedId
  ? [findStep(requestedId)].filter((step) => step !== undefined)
  : requestedGroup
    ? stepsInGroup(requestedGroup)
    : VERIFY_STEPS;

if (requestedId && selected.length === 0) {
  console.error(
    `verify: unknown step "${requestedId}" -- known ids: ${VERIFY_STEPS.map((s) => s.id).join(", ")}`,
  );
  process.exit(1);
}

const ci = process.env.CI;
const inCi = ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
const skipped =
  inCi && !requestedId
    ? selected.filter((step) => VERIFY_POLICY.ciSkipGroups.includes(step.group))
    : [];
for (const step of skipped) {
  console.log(
    `- ${step.name} (${step.id}) skipped: group "${step.group}" is in ciSkipGroups (bin/lib/verify-policy.json)`,
  );
}
const steps = selected.filter((step) => !skipped.includes(step));

/** The one group `testsBlocking: false` may downgrade to a warning. */
const TEST_GROUP = "test";

/** Why a step failed when it never produced an exit code of its own, or null. */
function abnormalReason(result) {
  if (result.error !== undefined) return result.error.message;
  if (result.signal !== null) return `killed by ${result.signal}`;
  return null;
}

let failed = false;
const downgraded = [];
for (const step of steps) {
  console.log(`\n▶ ${step.name} (${step.id})`);
  const [cmd, ...cmdArgs] = step.cmd;
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    const reason = abnormalReason(result);
    // Only a step that really ran and exited non-zero is a test result; a
    // spawn error or a signal kill says nothing about the tests, so it stays
    // a hard failure even when testsBlocking is false.
    if (
      reason === null &&
      step.group === TEST_GROUP &&
      VERIFY_POLICY.testsBlocking === false
    ) {
      downgraded.push(step);
      console.warn(
        `⚠ ${step.name} failed -- warning only: testsBlocking is false in bin/lib/verify-policy.json`,
      );
      continue;
    }
    failed = true;
    console.error(
      reason === null
        ? `✗ ${step.name} failed`
        : `✗ ${step.name} failed (${reason})`,
    );
    if (!requestedId && !requestedGroup) {
      // Local `pnpm verify` (no --step/--group): keep going so a single
      // early failure doesn't hide every other failing step in the same run.
      continue;
    }
    break;
  }
  console.log(`✓ ${step.name}`);
}

if (downgraded.length > 0) {
  const summary = `${downgraded.length} failing test step(s) reported as warning only (testsBlocking is false in bin/lib/verify-policy.json): ${downgraded.map((step) => step.id).join(", ")}`;
  console.warn(`\n⚠ ${summary}`);
  if (process.env.GITHUB_ACTIONS) {
    // Workflow-command message data must escape %, CR and LF.
    const data = summary
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(`::warning title=verify::${data}`);
  }
}

process.exit(failed ? 1 : 0);
