#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The behavioural half of harness grading: runs Anthropic's `claude plugin
 * eval` against (1) `packages/plugin`, the /customize skill, (2) a generated
 * wrapper over `templates/core`'s skills that measures whether each one fires
 * on the right prompts, and (3) that same wrapper carrying authored cases from
 * `evals/core-toolchain/` that run a skill against a deliberately degraded
 * project (the `toolchain` suite). Unlike `pnpm check:harness` this makes real
 * model calls -- it needs the `claude` CLI, credentials, network, and money --
 * so it is NEVER part of `pnpm verify`, and skips cleanly (exit 0) when
 * `claude` is not installed.
 *
 *   node bin/eval.mjs [--suite plugin|harness|toolchain|all] [--runs N] [--max-cost-usd N]
 *                     [--model M] [--judge-model M] [--ablation none|with-without]
 *                     [--threshold 0..1] [--case GLOB] [-j N] [--check] [--update]
 *                     [--keep-temp]
 *
 * `--check` fails on any case scoring below `evals/baseline.json`; `--update`
 * rewrites that file from this run (the file-budget ratchet's social
 * contract: a reviewed diff, never a silent one) -- but never from a partial
 * run (see `shouldUpdateBaseline`), so an interrupted eval can't silently
 * drop cases from the committed baseline. `--check` hard-fails up front if
 * no baseline exists at all, and fails on a baselined case missing from this
 * run (renamed, deleted, or dropped by a cost-capped partial run), not just
 * on a scored regression. Baselines recorded at `--runs 1` are noisy --
 * record and check at `--runs 3` or more. `--max-cost-usd` is a per-suite
 * budget, applied separately to each suite's own `claude plugin eval`
 * invocation -- `--suite all` spends up to one budget per entry in `SUITES`,
 * not this figure in total.
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "./lib/report.mjs";
import { paint } from "./lib/term.mjs";
import {
  baselineMissingForCheck,
  compareToBaseline,
  evalArgs,
  parseArgs,
  shouldUpdateBaseline,
  suiteMissingForCheck,
  summarizeRun,
  SUITES,
  withSuiteScores,
  writeHarnessPlugin,
  writeToolchainPlugin,
} from "./lib/eval-lib.mjs";

function readBaseline(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

/** Runs one suite; returns `{ summary, code }` where code is claude's exit code. */
function runSuite(name, target, extra, opts, resultsRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = join(resultsRoot, name, stamp);
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, "result.json");

  const args = evalArgs({
    target,
    jsonPath,
    outputDir,
    runs: opts.runs,
    maxCostUsd: opts.maxCostUsd,
    model: opts.model,
    judgeModel: opts.judgeModel,
    ablation: opts.ablation,
    // Under --check the ratchet decides pass/fail, so claude's own
    // every-case-must-pass default threshold is switched off.
    threshold: opts.threshold ?? (opts.check ? 0 : undefined),
    keepTemp: opts.keepTemp,
    caseGlob: opts.caseGlob,
    concurrency: opts.concurrency,
    ...extra,
  });
  console.log(
    paint(
      process.stdout,
      "accent",
      `\n▶ ${name} suite: claude ${args.slice(0, 3).join(" ")} …`,
    ),
  );
  const result = spawnSync("claude", args, { stdio: "inherit" });
  if (!existsSync(jsonPath)) {
    throw new Error(
      `${name}: claude plugin eval wrote no result at ${jsonPath} ` +
        `(status ${result.status}, signal ${result.signal})`,
      { cause: result.error },
    );
  }
  return {
    summary: summarizeRun(JSON.parse(readFileSync(jsonPath, "utf8"))),
    code: result.status ?? 1,
  };
}

const opts = parseArgs(process.argv.slice(2));

if (spawnSync("claude", ["--version"], { stdio: "ignore" }).error) {
  console.warn(
    paint(
      process.stderr,
      "warning",
      "warn  claude CLI not found -- skipping evals (they need Claude Code, credentials, and network)",
    ),
  );
  process.exit(0);
}

const root = repoRoot();
const baselinePath = resolve(root, "evals", "baseline.json");
const resultsRoot = resolve(root, ".eval-results");
const suites = opts.suite === "all" ? SUITES : [opts.suite];
let baseline = readBaseline(baselinePath);
let exitCode = 0;
let totalCost = 0;
const tempDirs = [];

if (baselineMissingForCheck(opts.check, baseline)) {
  console.error(
    paint(
      process.stderr,
      "danger",
      "fail  --check requires evals/baseline.json to exist -- run with --update first",
    ),
  );
  process.exit(1);
}

try {
  for (const name of suites) {
    let target;
    let extra = {};
    if (name === "plugin" || name === "toolchain") {
      // The scaffolds run the built CLI, so it must be current.
      const build = spawnSync("pnpm", ["build"], {
        cwd: root,
        stdio: "inherit",
      });
      if (build.status !== 0) {
        throw new Error(
          `pnpm build failed (status ${build.status}, signal ${build.signal})`,
          { cause: build.error },
        );
      }
      // Write/Edit are granted because the workspace is throwaway. For
      // `plugin`, /customize's Step 0.3 writes findings back into
      // .groundwork/ and the case's graders forbid touching anything outside
      // it; for `toolchain`, the graders forbid editing at all.
      extra = { scaffold: true, allowTools: ["Write", "Edit"] };
    }
    if (name === "plugin") {
      target = resolve(root, "packages", "plugin");
    } else if (name === "toolchain") {
      target = mkdtempSync(join(tmpdir(), "m3l-toolchain-plugin-"));
      tempDirs.push(target);
      writeToolchainPlugin({
        skillsDir: resolve(root, "templates", "core", ".claude", "skills"),
        casesDir: resolve(root, "evals", "core-toolchain"),
        outDir: target,
        cliPath: resolve(root, "packages", "cli", "bin", "m3l-groundwork.mjs"),
      });
    } else {
      target = mkdtempSync(join(tmpdir(), "m3l-harness-plugin-"));
      tempDirs.push(target);
      writeHarnessPlugin({
        skillsDir: resolve(root, "templates", "core", ".claude", "skills"),
        corpus: JSON.parse(
          readFileSync(
            resolve(root, "evals", "core-harness", "triggers.json"),
            "utf8",
          ),
        ),
        outDir: target,
      });
    }

    const { summary, code } = runSuite(name, target, extra, opts, resultsRoot);
    totalCost += summary.costUsd;

    console.log(`\n${name} suite -- $${summary.costUsd.toFixed(3)}`);
    for (const c of summary.cases) {
      const delta =
        c.delta === null
          ? ""
          : `  Δ ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(2)}`;
      console.log(`  ${c.score.toFixed(2)}  ${c.name}${delta}`);
    }
    if (summary.partial) {
      console.error(
        paint(
          process.stderr,
          "danger",
          `fail  ${name}: partial run (${summary.partialReason ?? "unknown"})`,
        ),
      );
      exitCode = Math.max(exitCode, 2);
    } else if (code === 2) {
      exitCode = Math.max(exitCode, 2);
    } else if (!opts.check && code !== 0) {
      exitCode = Math.max(exitCode, 1);
    }

    if (opts.check) {
      const { regressions, unbaselined, missing } = compareToBaseline(
        summary.cases,
        baseline?.suites?.[name],
        { filtered: opts.caseGlob !== undefined },
      );
      for (const r of regressions) {
        console.error(
          paint(
            process.stderr,
            "danger",
            `fail  ${name}/${r.name}: ${r.now.toFixed(2)} < baseline ${r.was.toFixed(2)}`,
          ),
        );
      }
      for (const m of missing) {
        console.error(
          paint(
            process.stderr,
            "danger",
            `fail  ${name}/${m}: baselined case did not run -- renamed, deleted, or dropped by a partial run`,
          ),
        );
      }
      if (suiteMissingForCheck(opts.check, baseline, name)) {
        // The whole-file case (no baseline.json at all) already hard-exited
        // above; this is the same silent pass one level down -- a baseline
        // that exists but was never recorded for THIS suite. Every case
        // would otherwise land in `unbaselined`, which is only a warning.
        console.error(
          paint(
            process.stderr,
            "danger",
            `fail  ${name}: no baseline for this suite in evals/baseline.json -- run with --update --suite ${name}`,
          ),
        );
        exitCode = Math.max(exitCode, 1);
      } else if (unbaselined.length > 0) {
        console.warn(
          paint(
            process.stderr,
            "warning",
            `warn  ${name}: no baseline for ${unbaselined.join(", ")} -- run with --update`,
          ),
        );
      }
      if (regressions.length > 0 || missing.length > 0) {
        exitCode = Math.max(exitCode, 1);
      }
    }
    if (opts.update) {
      if (!shouldUpdateBaseline(summary)) {
        console.warn(
          paint(
            process.stderr,
            "warning",
            `warn  ${name}: partial run -- not writing evals/baseline.json (would drop unrun cases)`,
          ),
        );
      } else if (summary.cases.length === 0 && opts.caseGlob === undefined) {
        // An unfiltered run recording zero cases would, via withSuiteScores'
        // full-replace mode, wipe every case this suite has ever had -- the
        // same silent-drop shape as a partial run, just from a malformed or
        // empty result.json instead of a cost cap.
        console.error(
          paint(
            process.stderr,
            "danger",
            `fail  ${name}: run produced no cases -- not writing evals/baseline.json`,
          ),
        );
        exitCode = Math.max(exitCode, 2);
      } else {
        baseline = withSuiteScores(
          baseline,
          name,
          summary.cases,
          opts.caseGlob !== undefined,
        );
        mkdirSync(resolve(root, "evals"), { recursive: true });
        writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
        console.log(
          paint(
            process.stdout,
            "success",
            `wrote ${name} scores to evals/baseline.json -- review the diff before committing`,
          ),
        );
      }
    }
  }
} finally {
  if (!opts.keepTemp) {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\ntotal cost $${totalCost.toFixed(3)}`);
process.exit(exitCode);
