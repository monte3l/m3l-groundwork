/**
 * The pure half of `bin/eval.mjs`: turning a trigger corpus into
 * `claude plugin eval` cases, building that command's argv, and comparing a
 * run's per-case scores against the committed baseline. Nothing here spawns a
 * process or touches the network, so it is unit-tested without spending a
 * cent (packages/cli/tests/eval-lib.test.ts).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SKILL_NAME = /^[\w-]+$/;

/** The three `claude plugin eval` suites `bin/eval.mjs` knows how to run. */
export const SUITES = ["plugin", "harness", "toolchain"];

/**
 * Parses `bin/eval.mjs`'s argv into a validated options object. Pure and
 * exported so its validation is unit-tested without spawning `claude`
 * (packages/cli/tests/eval-lib.test.ts). Throws a plain `Error` on any
 * invalid or unknown argument -- `bin/eval.mjs` lets that propagate as a
 * fatal usage error.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
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
      if (value === undefined || value === "") {
        throw new Error(`${arg} needs a value`);
      }
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
  if (
    opts.threshold !== undefined &&
    !(
      Number.isFinite(opts.threshold) &&
      opts.threshold >= 0 &&
      opts.threshold <= 1
    )
  ) {
    throw new Error("--threshold must be a number between 0 and 1");
  }
  if (opts.check && opts.update) {
    throw new Error("--check and --update are mutually exclusive");
  }
  return opts;
}

/**
 * Validates a trigger corpus -- `[{ skill, query, should_trigger }]`, the
 * shape the official skill-creator uses for triggering accuracy -- and
 * returns it. Throws on a malformed entry rather than silently dropping it,
 * because a dropped case is a hole in the measurement nobody would see.
 * @public Exported for the unit tests, which import this file by URL and so
 * are invisible to knip.
 * @param {unknown} corpus
 * @returns {{ skill: string, query: string, should_trigger: boolean }[]}
 */
export function validateCorpus(corpus) {
  if (!Array.isArray(corpus) || corpus.length === 0) {
    throw new Error("trigger corpus must be a non-empty JSON array");
  }
  corpus.forEach((entry, index) => {
    const where = `trigger corpus entry ${index}`;
    if (typeof entry?.skill !== "string" || !SKILL_NAME.test(entry.skill)) {
      throw new Error(`${where}: "skill" must be a skill directory name`);
    }
    if (typeof entry.query !== "string" || entry.query.trim() === "") {
      throw new Error(`${where}: "query" must be a non-empty string`);
    }
    if (typeof entry.should_trigger !== "boolean") {
      throw new Error(`${where}: "should_trigger" must be true or false`);
    }
  });
  return corpus;
}

/**
 * One `claude plugin eval` case per corpus entry. A positive entry passes
 * when Claude invoked the skill; a negative one passes when Claude did NOT
 * invoke that skill (other skills may fire -- only the named one is judged).
 * @public Exported for the unit tests (see `validateCorpus`).
 * @param {ReturnType<typeof validateCorpus>} corpus
 * @returns {{ dir: string, prompt: string, grader: string }[]}
 */
export function buildTriggerCases(corpus) {
  const counts = new Map();
  return corpus.map(({ skill, query, should_trigger: shouldTrigger }) => {
    const kind = shouldTrigger ? "fires" : "quiet";
    const key = `${skill}-${kind}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const bounds = shouldTrigger ? "" : "min: 0\nmax: 0\n";
    return {
      dir: `${key}-${n}`,
      prompt: `---
max_turns: 2
timeout_seconds: 90
allowed_tools: [Read, Glob, Grep, Skill]
tags: [core-harness, ${skill}, ${shouldTrigger ? "positive" : "negative"}]
---

${query.trim()}
`,
      grader: `---
type: tool_used
tool: Skill
input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill}"'
${bounds}---
`,
    };
  });
}

/**
 * Writes a throwaway plugin that wraps a project's `.claude/skills` plus one
 * eval case per corpus entry, so the emitted baseline's skills can be
 * evaluated as a plugin under test. Hooks and agents are deliberately not
 * wrapped: hooks are behaviourally covered by core-hooks.test.ts (which runs
 * them for real), and a triggering corpus has nothing to say about agents.
 * @param {{ skillsDir: string, corpus: unknown, outDir: string }} params
 */
export function writeHarnessPlugin({ skillsDir, corpus, outDir }) {
  const entries = validateCorpus(corpus);
  for (const { skill } of entries) {
    if (!existsSync(join(skillsDir, skill, "SKILL.md"))) {
      throw new Error(
        `trigger corpus names skill "${skill}" but ${join(skillsDir, skill, "SKILL.md")} does not exist`,
      );
    }
  }

  writeSkillPlugin({
    skillsDir,
    outDir,
    name: "m3l-baseline-harness",
    description:
      "Throwaway wrapper over templates/core's skills, generated to evaluate their triggering.",
  });

  const cases = buildTriggerCases(entries);
  for (const { dir, prompt, grader } of cases) {
    const caseDir = join(outDir, "evals", dir);
    mkdirSync(join(caseDir, "graders"), { recursive: true });
    writeFileSync(join(caseDir, "prompt.md"), prompt);
    writeFileSync(join(caseDir, "graders", "skill-fired.md"), grader);
  }
  return cases.length;
}

/**
 * Writes the throwaway plugin shell both generated suites share: a
 * `plugin.json` and a copy of `templates/core`'s skills.
 * @public Exported for the unit tests, which import this file by URL and so
 * are invisible to knip.
 * @param {{ skillsDir: string, outDir: string, name: string, description: string }} params
 */
export function writeSkillPlugin({ skillsDir, outDir, name, description }) {
  mkdirSync(join(outDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(outDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.0.0",
        description,
        author: { name: "m3l-groundwork" },
      },
      null,
      2,
    )}\n`,
  );
  cpSync(skillsDir, join(outDir, "skills"), { recursive: true });
}

/**
 * Placeholder an authored `fixture.sh` uses for the built CLI's absolute path.
 * The case is copied into a temp plugin dir, so a path relative to the case's
 * own location would not survive the copy.
 * @public Exported for the unit tests, which import this file by URL and so
 * are invisible to knip.
 */
export const CLI_PLACEHOLDER = "__M3L_CLI__";

/**
 * Wraps `templates/core`'s skills as a throwaway plugin and installs the
 * AUTHORED cases under `casesDir` (each a directory holding `case.yaml`,
 * `prompt.md`, `fixture.sh` and `graders/`), so a skill can be evaluated
 * against a scaffolded project. Each case's `fixture.sh` has `__M3L_CLI__`
 * replaced with `cliPath`. Throws on a malformed case rather than skipping it:
 * a dropped case is a hole in the measurement nobody would see.
 * @param {{ skillsDir: string, casesDir: string, outDir: string, cliPath: string }} params
 * @returns {number} how many cases were installed
 */
export function writeToolchainPlugin({ skillsDir, casesDir, outDir, cliPath }) {
  if (/["$`\\\s]/.test(cliPath)) {
    throw new Error(
      `cliPath must be a plain path (no quotes, $, backticks, backslashes or whitespace): ${cliPath}`,
    );
  }
  const cases = readdirSync(casesDir, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );
  if (cases.length === 0) {
    throw new Error(`no cases found under ${casesDir}`);
  }
  for (const { name } of cases) {
    for (const required of [
      "case.yaml",
      "prompt.md",
      "fixture.sh",
      "graders",
    ]) {
      if (!existsSync(join(casesDir, name, required))) {
        throw new Error(`case "${name}" is missing ${required}`);
      }
    }
  }

  writeSkillPlugin({
    skillsDir,
    outDir,
    name: "m3l-baseline-toolchain",
    description:
      "Throwaway wrapper over templates/core's skills, generated to evaluate typescript-guidance against a degraded toolchain.",
  });
  for (const { name } of cases) {
    const dest = join(outDir, "evals", name);
    cpSync(join(casesDir, name), dest, { recursive: true });
    const fixture = join(dest, "fixture.sh");
    const source = readFileSync(fixture, "utf8");
    if (!source.includes(CLI_PLACEHOLDER)) {
      throw new Error(
        `case "${name}" fixture.sh never uses ${CLI_PLACEHOLDER}`,
      );
    }
    writeFileSync(fixture, source.replaceAll(CLI_PLACEHOLDER, cliPath));
  }
  return cases.length;
}

/**
 * The argv for `claude plugin eval`. `--trust-plugin` and `--no-publish` are
 * always set: this runs unattended against suites this repo wrote, and a
 * report must never be published off-machine as a side effect.
 * @param {{
 *   target: string, jsonPath: string, outputDir: string, runs: number,
 *   maxCostUsd: number, model: string, judgeModel: string, ablation: string,
 *   threshold?: number, scaffold?: boolean, keepTemp?: boolean, caseGlob?: string, concurrency?: number,
 *   allowTools?: string[],
 * }} o
 */
export function evalArgs(o) {
  return [
    "plugin",
    "eval",
    o.target,
    "--trust-plugin",
    "--no-publish",
    "--json",
    o.jsonPath,
    "--output-dir",
    o.outputDir,
    "--runs",
    String(o.runs),
    "--max-cost-usd",
    String(o.maxCostUsd),
    "--model",
    o.model,
    "--judge-model",
    o.judgeModel,
    "--ablation",
    o.ablation,
    ...(o.threshold === undefined ? [] : ["--threshold", String(o.threshold)]),
    ...(o.scaffold ? ["--scaffold"] : []),
    ...(o.keepTemp ? ["--keep-temp"] : []),
    ...(o.caseGlob === undefined ? [] : ["--case", o.caseGlob]),
    ...(o.concurrency === undefined
      ? []
      : ["--concurrency", String(o.concurrency)]),
    // Last on purpose: --allow-tools is variadic and would swallow any flag
    // placed after it.
    ...(o.allowTools === undefined || o.allowTools.length === 0
      ? []
      : ["--allow-tools", ...o.allowTools]),
  ];
}

/**
 * Reduces `claude plugin eval`'s JSON result to what this repo reports.
 * @param {any} result
 */
export function summarizeRun(result) {
  return {
    cases: (result.cases ?? []).map((c) => ({
      name: c.name,
      score: c.aggregates?.score ?? 0,
      delta: c.aggregates?.delta ?? null,
    })),
    costUsd: result.costUsd ?? 0,
    partial: result.partial === true,
    partialReason: result.partialReason ?? null,
  };
}

/** Scores are stored to 4 decimals, and compared with that much slack. */
const SCORE_PRECISION = 1e4;
const SCORE_TOLERANCE = 1e-3;

/**
 * Per-case scores against the committed baseline. A case regresses when its
 * score is below what was recorded. LLM runs are noisy, so a baseline
 * recorded at `--runs 1` will flake: record it, and check it, at `--runs 3`
 * or more.
 *
 * `missing` names baselined cases that did not appear in this run at all --
 * e.g. a case renamed or deleted since the baseline was recorded -- so a
 * `--check` run can fail loudly instead of silently no longer verifying
 * them. Pass `{ filtered: true }` when the run was deliberately narrowed
 * (`--case <glob>`), so cases outside the glob aren't reported as missing.
 * @param {{ name: string, score: number }[]} cases
 * @param {Record<string, number> | undefined} baseline
 * @param {{ filtered?: boolean }} [options]
 */
export function compareToBaseline(cases, baseline, options) {
  const known = baseline ?? {};
  const filtered = options?.filtered ?? false;
  const seen = new Set(cases.map((c) => c.name));
  return {
    regressions: cases
      .filter(
        (c) =>
          c.name in known && c.score < (known[c.name] ?? 0) - SCORE_TOLERANCE,
      )
      .map((c) => ({ name: c.name, was: known[c.name] ?? 0, now: c.score })),
    unbaselined: cases.filter((c) => !(c.name in known)).map((c) => c.name),
    missing:
      baseline === undefined || filtered
        ? []
        : Object.keys(known).filter((name) => !seen.has(name)),
  };
}

/**
 * Whether a `--update` run's scores may overwrite `evals/baseline.json`. A
 * partial run (the cost cap or another interruption stopped it before every
 * case finished) must never be recorded: `withSuiteScores`'s full-run mode
 * replaces the suite's entire entry, so writing a partial run's cases would
 * silently drop every case that didn't get to run from the committed
 * baseline.
 * @param {{ partial: boolean }} summary
 */
export function shouldUpdateBaseline(summary) {
  return !summary.partial;
}

/**
 * Whether `--check` should hard-fail because there is nothing to check
 * against -- `evals/baseline.json` does not exist at all. Without this,
 * every case reads as merely "unbaselined" (a warning) and `--check` exits
 * 0 on a repo that never ran `--update`, which defeats the ratchet.
 * @param {boolean} check
 * @param {unknown} baseline
 */
export function baselineMissingForCheck(check, baseline) {
  return check && baseline === undefined;
}

/**
 * Whether `--check` should hard-fail a single suite because the baseline
 * document exists but has no entry at all for it -- the same silent pass
 * `baselineMissingForCheck` closes for a wholly-missing file, one level
 * down. Without this, every case in an un-baselined suite lands in
 * `compareToBaseline`'s `unbaselined` list, which is only a warning, so
 * `--check --suite toolchain` would exit 0 the first time that suite is run.
 * Callers check `baselineMissingForCheck` first; by the time this runs,
 * `baseline` is expected to be defined, but it degrades safely (`true`) if
 * called with it `undefined` too.
 * @param {boolean} check
 * @param {{ suites?: Record<string, unknown> } | undefined} baseline
 * @param {string} suite
 */
export function suiteMissingForCheck(check, baseline, suite) {
  return check && baseline?.suites?.[suite] === undefined;
}

/**
 * A new baseline document with `suite`'s scores updated. Other suites'
 * entries are always kept. Within the suite, a full run replaces every entry
 * (so a deleted case does not linger), while a filtered run (`merge`) only
 * overwrites the cases it ran -- otherwise `--update --case x` would erase
 * every other case's baseline.
 * @param {{ schemaVersion?: number, suites?: Record<string, Record<string, number>> } | undefined} baseline
 * @param {string} suite
 * @param {{ name: string, score: number }[]} cases
 * @param {boolean} [merge]
 */
export function withSuiteScores(baseline, suite, cases, merge = false) {
  const previous = merge ? (baseline?.suites?.[suite] ?? {}) : {};
  return {
    schemaVersion: 1,
    suites: {
      ...(baseline?.suites ?? {}),
      [suite]: {
        ...previous,
        ...Object.fromEntries(
          cases.map((c) => [
            c.name,
            Math.round(c.score * SCORE_PRECISION) / SCORE_PRECISION,
          ]),
        ),
      },
    },
  };
}
