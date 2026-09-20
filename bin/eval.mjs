#!/usr/bin/env node
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
 * contract: a reviewed diff, never a silent one). Baselines recorded at
 * `--runs 1` are noisy -- record and check at `--runs 3` or more.
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
import {
  compareToBaseline,
  evalArgs,
  summarizeRun,
  withSuiteScores,
  writeHarnessPlugin,
  writeToolchainPlugin,
} from "./lib/eval-lib.mjs";

const SUITES = ["plugin", "harness", "toolchain"];

function parseArgs(argv) {
  const opts = {
    suite: "all",
    runs: 1,
    maxCostUsd: 5,
    model: "claude-sonnet-5",
    judgeModel: "claude-haiku-4-5",
    ablation: "none",
    threshold: undefined,
    caseGlob: undefined,
    concurrency: undefined,
    check: false,
    update: false,
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--suite") opts.suite = next();
    else if (arg === "--runs") opts.runs = Number(next());
    else if (arg === "--max-cost-usd") opts.maxCostUsd = Number(next());
    else if (arg === "--model") opts.model = next();
    else if (arg === "--judge-model") opts.judgeModel = next();
    else if (arg === "--ablation") opts.ablation = next();
    else if (arg === "--threshold") opts.threshold = Number(next());
    else if (arg === "--case") opts.caseGlob = next();
    else if (arg === "-j" || arg === "--concurrency")
      opts.concurrency = Number(next());
    else if (arg === "--check") opts.check = true;
    else if (arg === "--update") opts.update = true;
    else if (arg === "--keep-temp") opts.keepTemp = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.suite !== "all" && !SUITES.includes(opts.suite)) {
    throw new Error(`--suite must be plugin, harness, toolchain, or all`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isFinite(opts.maxCostUsd) || opts.maxCostUsd <= 0) {
    throw new Error("--max-cost-usd must be a positive number");
  }
  if (
    opts.concurrency !== undefined &&
    !(
      Number.isInteger(opts.concurrency) &&
      opts.concurrency >= 1 &&
      opts.concurrency <= 8
    )
  ) {
    throw new Error("--concurrency must be an integer from 1 to 8");
  }
  if (!["none", "with-without"].includes(opts.ablation)) {
    throw new Error("--ablation must be none or with-without");
  }
  if (opts.check && opts.update) {
    throw new Error("--check and --update are mutually exclusive");
  }
  return opts;
}

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
  console.log(`\n▶ ${name} suite: claude ${args.slice(0, 3).join(" ")} …`);
  const result = spawnSync("claude", args, { stdio: "inherit" });
  if (!existsSync(jsonPath)) {
    throw new Error(
      `${name}: claude plugin eval wrote no result at ${jsonPath}`,
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
    "warn  claude CLI not found -- skipping evals (they need Claude Code, credentials, and network)",
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
      if (build.status !== 0) throw new Error("pnpm build failed");
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
        `fail  ${name}: partial run (${summary.partialReason ?? "unknown"})`,
      );
      exitCode = Math.max(exitCode, 2);
    } else if (code === 2) {
      exitCode = Math.max(exitCode, 2);
    } else if (!opts.check && code !== 0) {
      exitCode = Math.max(exitCode, 1);
    }

    if (opts.check) {
      const { regressions, unbaselined } = compareToBaseline(
        summary.cases,
        baseline?.suites?.[name],
      );
      for (const r of regressions) {
        console.error(
          `fail  ${name}/${r.name}: ${r.now.toFixed(2)} < baseline ${r.was.toFixed(2)}`,
        );
      }
      if (unbaselined.length > 0) {
        console.warn(
          `warn  ${name}: no baseline for ${unbaselined.join(", ")} -- run with --update`,
        );
      }
      if (regressions.length > 0) exitCode = Math.max(exitCode, 1);
    }
    if (opts.update) {
      baseline = withSuiteScores(
        baseline,
        name,
        summary.cases,
        opts.caseGlob !== undefined,
      );
      mkdirSync(resolve(root, "evals"), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(
        `wrote ${name} scores to evals/baseline.json -- review the diff before committing`,
      );
    }
  }
} finally {
  if (!opts.keepTemp) {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\ntotal cost $${totalCost.toFixed(3)}`);
process.exit(exitCode);
