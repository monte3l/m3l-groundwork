// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Entry point: `m3l-groundwork <target-dir> [options]`. No prompts, no
 * interactivity, no network call beyond the package install -- this must
 * work on a plane against a warm pnpm store.
 *
 * Three modes. Two are auto-detected from the target directory
 * (`--adopt`/`--fresh` force either): **fresh** writes the baseline template
 * tree into an empty or missing target directory, then installs any `--pack`
 * requested. **adopt** surveys an
 * already-established project and writes only a report -- see `mode.ts`,
 * `survey/survey.ts`, `conflicts.ts`, and `report.ts`. Adopt mode never
 * touches a project file, including a pack's: it surveys every pack under
 * `templates/packs/` (or only those named by `--pack`) into the report,
 * stages each as inert `.staged` copies under `.groundwork/packs/`, and
 * defers installation to `/customize`; see `runAdopt`. The third,
 * **upgrade**, runs only when `--upgrade` asks for it: it plans an upgrade of
 * a project that has a `.groundwork/manifest.json` against this release and
 * writes the plan only under `.groundwork/upgrade/`, then installs the
 * `/upgrade` skill that applies it; see `runUpgrade`. Its
 * stamp step, `--upgrade --stamp`, records an applied plan in the manifest
 * and writes nothing else; see `runUpgradeStamp`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, relative, resolve, basename, dirname } from "node:path";
import process from "node:process";
import type { StdioOptions } from "node:child_process";
import { resolveAsset, toPosixPath } from "./assets.js";
import type { CapCounts } from "./caps.js";
import { CAP_LIMITS, countBaselineCaps } from "./caps.js";
import {
  assertSafeEmitDestinations,
  emitTemplate,
  isPathContained,
} from "./emit.js";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
  installSkillGuarded,
} from "./plugin.js";
import { plannedSkillPaths, UPGRADE_SKILL } from "./skill-spec.js";
import type { GuardedInstallResult, InstallPluginResult } from "./plugin.js";
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_FILE_NAMES,
  GROUNDWORK_DEST_SEGMENTS,
  plannedCustomizeSkillPaths,
} from "./customize-paths.js";
import { gitInit, runInstall } from "./git.js";
import { createOut, type Out } from "./output.js";
import type { RunResult } from "./run-result.js";
import { gradeHarness } from "./harness/grade.js";
import { detectMode, resolveMode } from "./mode.js";
import { surveyProject } from "./survey/survey.js";
import { planConflicts } from "./conflicts.js";
import {
  STAGED_BASELINE_DIR,
  STAGED_DIVERGENT_DIR,
  STAGED_SUFFIX,
  planBaselineStaging,
  planDivergentStaging,
  stageBaselineAdditions,
  stageDivergentBaseline,
} from "./baseline-stage.js";
import {
  assertDirectoryComponent,
  assertFileDestination,
  assertNotDirectory,
  assertNotSymlink,
  endsWithRerunAdvice,
  FIX_AND_RERUN_ADVICE,
  FRESH_SYMLINK_ADVICE,
} from "./fs-guard.js";
import {
  buildInventory,
  resolveCliVersion,
  writeInventory,
} from "./inventory.js";
import type { Inventory, PackSurvey } from "./inventory.js";
import {
  MANIFEST_RELATIVE_PATH,
  buildManifest,
  readManifest,
  writeManifest,
} from "./manifest.js";
import type { Pack } from "./packs.js";
import {
  PACK_NAME_PATTERN,
  listPackNames,
  loadPack,
  installPack,
  observeWiring,
  packsRootDir,
} from "./packs.js";
import { STAGED_PACKS_DIR, planPackStaging, stagePacks } from "./pack-stage.js";
import { NPM_NAME_MAX_LENGTH, NPM_NAME_PATTERN } from "./npm-name.js";
import { renderReport } from "./report.js";
import type { RequiredTokenKey } from "./tokens.js";
import type { ModeDetection } from "./mode.js";
import { gradeToolchain } from "./toolchain/grade.js";
import { buildAdoptPending } from "./headless/pending.js";
import { errnoCode } from "./survey/internal/read-guard.js";
import type { AnswersV1 } from "./headless/contract.js";
import { computePlan, renderRelease } from "./upgrade/plan.js";
import type { UpgradePlan } from "./upgrade/plan.js";
import { countClasses, nothingToApply } from "./upgrade/report.js";
import {
  UPGRADE_PLAN_FILE,
  UPGRADE_RELATIVE_DIR,
  UPGRADE_REPORT_FILE,
  UPGRADE_SKILL_FALLBACK_RELATIVE_DIR,
} from "./upgrade/paths.js";
import { inspectPreviousUpgrade, stageUpgrade } from "./upgrade/stage.js";
import type { StagedUpgrade } from "./upgrade/stage.js";
import { UpgradeStampError, stampUpgrade } from "./upgrade/stamp.js";
import type { StampResult } from "./upgrade/stamp.js";

export interface CliOptions {
  targetDir: string;
  projectName: string;
  skipInstall: boolean;
  force: boolean;
  adopt: boolean;
  fresh: boolean;
  upgrade: boolean;
  stamp: boolean;
  help: boolean;
  version: boolean;
  listPacks: boolean;
  packs: string[];
  json: boolean;
}

const USAGE = [
  "usage: m3l-groundwork <target-dir> [options]",
  "",
  "  --name <project-name>   Override the project name (default: the target directory's basename)",
  "  --skip-install          Skip the final `pnpm install` (fresh mode only)",
  "  --force                 Overwrite a non-empty target directory (fresh mode only)",
  "  --adopt                 Force adopt mode, even if the target looks empty",
  "  --fresh                 Force fresh-bootstrap mode, even if the target looks pre-existing",
  "  --upgrade               Plan an upgrade of a project that has .groundwork/manifest.json;",
  "                          writes the plan under .groundwork/upgrade/ and installs",
  "                          the /upgrade skill that applies it",
  "  --stamp                 With --upgrade: record the applied plan in",
  "                          .groundwork/manifest.json; writes nothing else",
  "  --pack <name>           Install a pack from templates/packs/ (fresh mode), or narrow",
  "                          the survey to the named packs (adopt mode); repeatable",
  "  --list-packs            Print every available pack and exit",
  "  --json                  Write one machine-readable JSON report to stdout and",
  "                          every human-readable line to stderr",
  "  --help, -h              Print this message",
  "  --version, -v           Print the CLI's version",
  "",
  "With no --adopt/--fresh override, the target directory is inspected: an",
  "empty or missing directory bootstraps fresh; a directory that already",
  "looks like a project (package.json, .git, or loose source files) is",
  "surveyed and adopted instead -- see .groundwork/adoption-report.md.",
  "",
  "--force is rejected in adopt mode -- adopt mode never writes project",
  "files. Every available pack is surveyed into the report unless --pack",
  "names some; run /customize to install one.",
  "",
  "--upgrade is never auto-detected and takes none of --adopt, --fresh,",
  "--name, --force, --pack, --skip-install or --json: the project name and",
  "packs come from the manifest, and it never writes a project file: besides",
  "the plan it writes only the /upgrade skill, into .claude/skills/upgrade/",
  "(or .groundwork/upgrade-skill/ when .claude/skills/upgrade/ already holds",
  "a different copy, including one left by an earlier release).",
  "--upgrade --stamp, run once the plan is applied (or straight away when",
  "--upgrade reports nothing to apply), re-hashes the plan's files and",
  "writes only the manifest.",
].join("\n");

// --name takes a single value; --pack is repeatable. Every other
// recognized flag is a bare boolean.
const VALUE_FLAGS = new Set(["--name"]);
const REPEATABLE_VALUE_FLAGS = new Set(["--pack"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
const LIST_PACKS_FLAGS = new Set(["--list-packs"]);
const JSON_FLAGS = new Set(["--json"]);
// A --pack value is a bare directory name under templates/packs/ --
// PACK_NAME_PATTERN (owned by packs.ts, shared with loadPack and the
// manifest's `packs` check) keeps it from
// ever reaching packs.ts's join() as a path.
// A --name value is substituted verbatim into the emitted package.json, so it
// must fit NPM_NAME_PATTERN within NPM_NAME_MAX_LENGTH (npm-name.ts, shared
// with the answers contract's fresh.name).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--skip-install",
  "--force",
  "--adopt",
  "--fresh",
  "--upgrade",
  "--stamp",
  ...JSON_FLAGS,
  ...LIST_PACKS_FLAGS,
  ...HELP_FLAGS,
  ...VERSION_FLAGS,
]);

/**
 * Thrown for a bad invocation (unknown flag, missing target dir, missing flag
 * value, contradictory mode flags) -- distinguished from a runtime error so the
 * CLI exits 2, not 1.
 *
 * @example
 * ```sh
 * npx @monte3l/groundwork ./my-app --bogus
 * # stderr: unrecognized option: --bogus (followed by the usage text)
 * echo $? # 2 -- a runtime failure exits 1 instead
 * ```
 */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

interface TokenizedArgv {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
  repeatableValues: Map<string, string[]>;
}

/** Splits argv into positionals, boolean flags, and value-flag pairs -- a value-flag's value is never mistaken for a positional. */
function tokenizeArgv(argv: string[]): TokenizedArgv {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const repeatableValues = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    if (REPEATABLE_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError(`${arg} requires a value\n\n${USAGE}`);
      }
      const existing = repeatableValues.get(arg) ?? [];
      existing.push(value);
      repeatableValues.set(arg, existing);
      i++;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError(`${arg} requires a value\n\n${USAGE}`);
      }
      if (values.has(arg)) {
        throw new CliUsageError(`${arg} given more than once\n\n${USAGE}`);
      }
      values.set(arg, value);
      i++;
      continue;
    }

    if (!BOOLEAN_FLAGS.has(arg)) {
      throw new CliUsageError(`unrecognized option: ${arg}\n\n${USAGE}`);
    }
    flags.add(arg);
  }

  return { positional, flags, values, repeatableValues };
}

/**
 * Why each flag upgrade mode rejects has no effect there, in the order they
 * are checked. `--json` is refused separately: its plan report is not built.
 */
const UPGRADE_REJECTED_FLAGS: readonly (readonly [string, string])[] = [
  ["--name", "the project name comes from .groundwork/manifest.json"],
  ["--force", "upgrade mode never writes a project file"],
  [
    "--pack",
    "the packs come from .groundwork/manifest.json; to add a pack to an existing project, run the CLI in adopt mode with --pack",
  ],
  ["--skip-install", "upgrade mode installs nothing"],
];

/**
 * Rejects every flag `--upgrade` cannot be combined with, as usage errors:
 * the other two mode flags (mutually exclusive), the flags that have no
 * effect in upgrade mode, and `--json`, whose plan report is not built yet.
 */
function assertUpgradeFlags(
  flags: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  repeatableValues: ReadonlyMap<string, readonly string[]>,
): void {
  for (const other of ["--adopt", "--fresh"]) {
    if (flags.has(other)) {
      throw new CliUsageError(
        `--upgrade and ${other} are mutually exclusive\n\n${USAGE}`,
      );
    }
  }
  for (const [flag, reason] of UPGRADE_REJECTED_FLAGS) {
    if (flags.has(flag) || values.has(flag) || repeatableValues.has(flag)) {
      throw new CliUsageError(
        `${flag} has no effect in upgrade mode -- ${reason}\n\n${USAGE}`,
      );
    }
  }
  if ([...JSON_FLAGS].some((flag) => flags.has(flag))) {
    throw new CliUsageError(
      `--json cannot be combined with --upgrade: plan reports are not available yet -- read .groundwork/upgrade/plan.json instead\n\n${USAGE}`,
    );
  }
}

/** Parses argv into structured options. Throws with USAGE on a missing target dir, unless --help/--version/--list-packs is present. */
export function parseArgs(argv: string[]): CliOptions {
  const { positional, flags, values, repeatableValues } = tokenizeArgv(argv);

  const help = [...HELP_FLAGS].some((flag) => flags.has(flag));
  const version = [...VERSION_FLAGS].some((flag) => flags.has(flag));
  const listPacks = [...LIST_PACKS_FLAGS].some((flag) => flags.has(flag));
  const json = [...JSON_FLAGS].some((flag) => flags.has(flag));

  if (help || version || listPacks) {
    return {
      targetDir: "",
      projectName: "",
      skipInstall: false,
      force: false,
      adopt: false,
      fresh: false,
      upgrade: false,
      stamp: false,
      help,
      version,
      listPacks,
      packs: [],
      json,
    };
  }

  if (flags.has("--adopt") && flags.has("--fresh")) {
    throw new CliUsageError(
      `--adopt and --fresh are mutually exclusive\n\n${USAGE}`,
    );
  }
  const upgrade = flags.has("--upgrade");
  const stamp = flags.has("--stamp");
  if (stamp && !upgrade) {
    throw new CliUsageError(
      `--stamp needs --upgrade: run --upgrade --stamp once the staged plan is applied\n\n${USAGE}`,
    );
  }
  if (upgrade) {
    assertUpgradeFlags(flags, values, repeatableValues);
  }

  const targetArg = positional[0];
  if (targetArg === undefined) {
    throw new CliUsageError(USAGE);
  }
  if (positional.length > 1) {
    throw new CliUsageError(
      `unexpected argument(s): ${positional.slice(1).join(" ")}\n\n${USAGE}`,
    );
  }

  const targetDir = resolve(targetArg);
  const explicitName = values.get("--name");
  if (
    explicitName !== undefined &&
    (explicitName.length > NPM_NAME_MAX_LENGTH ||
      !NPM_NAME_PATTERN.test(explicitName))
  ) {
    throw new CliUsageError(
      `--name must be a valid npm package name (lowercase, optional @scope/, at most ${String(NPM_NAME_MAX_LENGTH)} characters): ${JSON.stringify(explicitName)}\n\n${USAGE}`,
    );
  }
  const packValues = repeatableValues.get("--pack") ?? [];
  const badPack = packValues.find((name) => !PACK_NAME_PATTERN.test(name));
  if (badPack !== undefined) {
    throw new CliUsageError(
      `--pack must be a pack name matching ${PACK_NAME_PATTERN.source}: ${JSON.stringify(badPack)}\n\n${USAGE}`,
    );
  }
  const packs = [...new Set(packValues)].sort();

  return {
    targetDir,
    projectName: explicitName ?? basename(targetDir),
    skipInstall: flags.has("--skip-install"),
    force: flags.has("--force"),
    adopt: flags.has("--adopt"),
    fresh: flags.has("--fresh"),
    upgrade,
    stamp,
    help: false,
    version: false,
    listPacks: false,
    packs,
    json,
  };
}

/** Resolves `templates/core` for a source checkout or a published tarball -- see `assets.ts`. */
export function templatesCoreDir(): string {
  return resolveAsset({ repo: "templates/core", local: "templates/core" });
}

function isEmptyOrMissing(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

function buildTokens(projectName: string): Record<RequiredTokenKey, string> {
  return { PROJECT_NAME: projectName, YEAR: String(new Date().getFullYear()) };
}

function formatCounts(counts: CapCounts): string {
  return `${counts.agents} agents, ${counts.skills} skills, ${counts.hooks} hooks, ${counts.workflows} workflows, ${counts.scripts} scripts`;
}

/**
 * The result of {@link formatCapsSummary}: the rendered summary text plus an
 * explicit over-cap flag, so a caller never has to string-match the text to
 * decide how to present it.
 *
 * @example
 * ```ts
 * const summary: CapsSummary = { text: "= 5 agents, ...", overCap: false };
 * console.log(summary.overCap ? `warning: ${summary.text}` : summary.text);
 * ```
 */
export interface CapsSummary {
  /** The summary line(s), newline-joined, exactly as printed. */
  readonly text: string;
  /** `true` when the baseline plus installed packs exceeds any cap in `CAP_LIMITS`. */
  readonly overCap: boolean;
}

/**
 * The post-`--pack`-install caps summary line(s) printed to fresh-mode's
 * console output, plus whether any cap is exceeded.
 *
 * @example
 * ```ts
 * const summary = formatCapsSummary(baselineCounts, [
 *   { name: "harness-extras", budget: packBudget },
 * ]);
 * console.log(summary.text);
 * ```
 */
export function formatCapsSummary(
  baseline: CapCounts,
  installed: { name: string; budget: CapCounts }[],
): CapsSummary {
  const total: CapCounts = { ...baseline };
  const lines = [
    `templates/core: ${formatCounts(baseline)} (caps: ${formatCounts(CAP_LIMITS)})`,
  ];

  for (const { name, budget } of installed) {
    lines.push(`+ ${name}: ${formatCounts(budget)}`);
    total.agents += budget.agents;
    total.skills += budget.skills;
    total.hooks += budget.hooks;
    total.workflows += budget.workflows;
    total.scripts += budget.scripts;
  }

  const overCap = (
    ["agents", "skills", "hooks", "workflows", "scripts"] as (keyof CapCounts)[]
  ).filter((key) => total[key] > CAP_LIMITS[key]);

  lines.push(
    `= ${formatCounts(total)}${overCap.length > 0 ? ` ⚠ over cap: ${overCap.join(", ")}` : ""}`,
  );
  return { text: lines.join("\n"), overCap: overCap.length > 0 };
}

/**
 * Each pack that declares `setupSteps`, in `packs` order, paired with its
 * commands. Packs with no steps are left out.
 */
function groupSetupSteps(packs: readonly Pack[]): RunResult["setupSteps"] {
  return packs
    .map(({ manifest }) => ({
      pack: manifest.name,
      steps: manifest.setupSteps ?? [],
    }))
    .filter(({ steps }) => steps.length > 0);
}

/**
 * Fresh mode's closing "setup required" block: one heading, then each pack
 * group (from {@link groupSetupSteps}) followed by its commands, each
 * indented two spaces. `undefined` when there are no groups, so the caller
 * prints nothing extra.
 */
function formatSetupBlock(
  targetDir: string,
  groups: RunResult["setupSteps"],
): string | undefined {
  if (groups.length === 0) return undefined;
  const lines = groups.flatMap(({ pack, steps }) => [
    `pack "${pack}":`,
    ...steps.map((step) => `  ${step}`),
  ]);
  return [
    `\nthe installed pack(s) need setup before the first \`pnpm verify\` -- run these in ${targetDir}:`,
    ...lines,
  ].join("\n");
}

/**
 * Fresh mode's pre-flight over the `/customize` skill's own destination
 * (`.claude/skills/customize/`): each directory component must be missing
 * or a real directory, and no payload file name may be a directory. A
 * symlink AT a payload name passes -- the install replaces it rather than
 * writing through it. Nothing is written either way.
 */
function assertSafeSkillDestination(targetDir: string): void {
  for (let depth = 1; depth <= CLAUDE_DEST_SEGMENTS.length; depth++) {
    assertDirectoryComponent(
      join(targetDir, ...CLAUDE_DEST_SEGMENTS.slice(0, depth)),
      FRESH_SYMLINK_ADVICE,
    );
  }
  const destDir = join(targetDir, ...CLAUDE_DEST_SEGMENTS);
  for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
    assertNotDirectory(join(destDir, name), FRESH_SYMLINK_ADVICE);
  }
}

/**
 * Fresh mode's pre-flight over the manifest's destination: `.groundwork`
 * must be missing or a real directory, and `.groundwork/manifest.json`
 * missing or a regular file (never a symlink or a directory). Nothing is
 * written either way.
 */
function assertSafeManifestDestination(targetDir: string): void {
  const groundworkDir = join(targetDir, ".groundwork");
  assertDirectoryComponent(groundworkDir, FRESH_SYMLINK_ADVICE);
  assertFileDestination(
    join(groundworkDir, "manifest.json"),
    FRESH_SYMLINK_ADVICE,
  );
}

/**
 * The stdio a `--json` run hands `git init` and `pnpm install`: no stdin,
 * and the child's stdout redirected to stderr, so stdout carries only the
 * report (`.claude/rules/headless-mode.md`).
 */
const JSON_CHILD_STDIO: StdioOptions = ["ignore", 2, 2];

function runFresh(
  options: CliOptions,
  platform: NodeJS.Platform,
  out: Out,
): RunResult {
  if (platform === "win32") {
    throw new Error("Windows is not supported yet (Linux and macOS only)");
  }
  if (!isEmptyOrMissing(options.targetDir) && !options.force) {
    throw new Error(
      `${options.targetDir} already exists and is not empty (pass --force to overwrite, or --adopt to survey it instead)`,
    );
  }

  // Resolve every --pack before the first write: a bad name must leave the
  // target exactly as it was found.
  const packs = options.packs.map((name) => resolveFreshPack(name));

  const tokens = buildTokens(options.projectName);

  // Validate every destination the baseline AND each pack would write
  // before the first write: a symlinked or non-directory component refuses
  // the whole run with nothing written.
  assertSafeEmitDestinations(
    [templatesCoreDir(), ...packs.map((pack) => pack.filesDir)],
    options.targetDir,
    tokens,
  );

  // The /customize skill's destination too: its own install refuses a
  // symlinked directory component or a directory at a payload name, but it
  // runs only after the baseline is written -- too late to leave the target
  // untouched.
  assertSafeSkillDestination(options.targetDir);

  // And the manifest's: writeManifest refuses the same shapes, but only
  // after the baseline, the packs and the skill are written.
  assertSafeManifestDestination(options.targetDir);

  mkdirSync(options.targetDir, { recursive: true });

  const result = emitTemplate(templatesCoreDir(), options.targetDir, tokens);
  out.info(`wrote ${result.filesWritten.length} files to ${options.targetDir}`);

  const warnings: string[] = [];
  const installedPacks: { name: string; budget: CapCounts }[] = [];
  const emittedFiles = [...result.filesWritten];
  for (const pack of packs) {
    const name = pack.manifest.name;
    const packResult = installPack(pack, options.targetDir, tokens);
    out.info(
      `installed pack "${name}" (${packResult.filesWritten.length} files)`,
    );
    installedPacks.push({ name, budget: packResult.budget });
    emittedFiles.push(...packResult.filesWritten);
  }
  if (installedPacks.length > 0) {
    const summary = formatCapsSummary(
      countBaselineCaps(templatesCoreDir()),
      installedPacks,
    );
    if (summary.overCap) {
      warnings.push(summary.text);
      // out.notice, not out.warn: the over-cap summary has always gone to
      // stdout in human mode.
      out.notice(summary.text);
    } else {
      out.info(summary.text);
    }
  }

  const { targetDir, skipInstall, projectName } = options;

  // Built once, now that the project and its packs are on disk, and printed
  // exactly once per run: at the very end on success, or just before the
  // throw when git init / pnpm install fails -- a plain re-run of a
  // non-empty target adopts it, and adopt mode never prints setupSteps. The
  // /customize-skill failure below deliberately does not print it: its
  // message says to re-run with --fresh --force, which prints it on success.
  const setupSteps = groupSetupSteps(packs);
  const setupBlock = formatSetupBlock(targetDir, setupSteps);
  const printSetupBlock = (): void => {
    if (setupBlock !== undefined) {
      // out.notice, not out.warn: the block has always gone to stdout in
      // human mode.
      out.notice(setupBlock);
    }
  };

  let pluginResult: InstallPluginResult;
  try {
    pluginResult = installCustomizeSkill(targetDir);
  } catch (error) {
    // The target is no longer empty, so a plain re-run would auto-detect
    // adopt mode; only --fresh --force repeats this run. With
    // --skip-install, pnpm install was never going to run, so don't claim
    // the failure stopped it (same split as the git-init branch below).
    const notRun = skipInstall ? "git init" : "git init / pnpm install";
    throw new Error(
      `the project was written to ${targetDir}, but the /customize skill install failed and ${notRun} did not run -- fix the cause, then re-run with --fresh --force (plus your original --name/--pack/--skip-install); a plain re-run adopts it`,
      { cause: error },
    );
  }
  out.info(
    pluginResult.filesWritten.length === 0
      ? "the /customize skill was already up to date"
      : `installed the /customize skill (${pluginResult.filesWritten.length} files)`,
  );

  // Recorded once every pack has merged into the shared files, and before
  // git init so the first commit can carry it. Only the baseline's and the
  // packs' files are listed: the /customize skill is not part of the
  // emitted project.
  try {
    writeManifest(
      targetDir,
      buildManifest({
        targetDir,
        cliVersion: resolveCliVersion(),
        tokens,
        packs: installedPacks.map((pack) => pack.name),
        files: emittedFiles.map(toPosixPath),
      }),
    );
  } catch (error) {
    const notRun = skipInstall ? "git init" : "git init / pnpm install";
    throw new Error(
      `the project was written to ${targetDir}, but writing ${MANIFEST_RELATIVE_PATH} failed and ${notRun} did not run -- fix the cause, then re-run with --fresh --force (plus your original --name/--pack/--skip-install); a plain re-run adopts it`,
      { cause: error },
    );
  }
  out.info(`wrote ${MANIFEST_RELATIVE_PATH}`);

  // Human mode keeps the one-argument calls (the children inherit stdio);
  // --json redirects their stdout to stderr.
  const json = options.json;
  try {
    if (json) gitInit(targetDir, JSON_CHILD_STDIO);
    else gitInit(targetDir);
  } catch (error) {
    printSetupBlock();
    throw new Error(
      `git init failed, but the project was written to ${targetDir}; run \`git init\`${skipInstall ? "" : " and `pnpm install`"} there yourself`,
      { cause: error },
    );
  }
  out.info("initialized git repository");

  if (!skipInstall) {
    try {
      if (json) runInstall(targetDir, JSON_CHILD_STDIO);
      else runInstall(targetDir);
    } catch (error) {
      out.notice(
        `\n${projectName} written to ${targetDir}, but dependencies are not installed`,
      );
      printSetupBlock();
      throw new Error(
        `${describeInstallFailure(error)}; the project was written to ${targetDir} -- run \`pnpm install\` there yourself to finish`,
        { cause: error },
      );
    }
    out.info("installed dependencies");
  }

  out.success(`\n✓ ${projectName} is ready at ${targetDir}`);
  printSetupBlock();
  return {
    mode: "fresh",
    target: targetDir,
    warnings,
    setupSteps,
    nextStep: null,
    manifest: MANIFEST_RELATIVE_PATH,
    pending: [],
    pendingPath: null,
  };
}

/**
 * Explains why the post-emission `pnpm install` failed: a missing binary
 * specifically, otherwise the exit status, killing signal, or error code
 * when the thrown value carries one. Each property is read exactly once.
 */
function describeInstallFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "`pnpm install` failed";
  }
  const code: unknown = "code" in error ? error.code : undefined;
  const status: unknown = "status" in error ? error.status : undefined;
  const signal: unknown = "signal" in error ? error.signal : undefined;
  if (code === "ENOENT") return "pnpm was not found on PATH";
  if (typeof status === "number") {
    return `\`pnpm install\` failed (exit status ${String(status)})`;
  }
  if (typeof signal === "string") {
    return `\`pnpm install\` failed (killed by signal ${signal})`;
  }
  if (typeof code === "string") return `\`pnpm install\` failed (${code})`;
  return "`pnpm install` failed";
}

/**
 * Throws the usage error (exit 2) for a `--pack` name that is not one of
 * `available`, listing the available packs. Shared by fresh and adopt mode
 * so both word an unknown pack the same way.
 */
function assertKnownPack(name: string, available: readonly string[]): void {
  if (!available.includes(name)) {
    const list = available.length > 0 ? available.join(", ") : "none";
    throw new CliUsageError(
      `unknown pack "${name}" (available: ${list})\n\n${USAGE}`,
    );
  }
}

/**
 * Loads one `--pack` for fresh mode -- called for every pack before any file
 * is written. An unknown name (the message lists the available packs) or a
 * fresh-incompatible pack is a usage error (exit 2); a pack that exists but
 * whose manifest fails to load propagates `loadPack`'s own error unchanged
 * (exit 1), since that is a broken install, not a bad invocation.
 */
function resolveFreshPack(name: string): Pack {
  assertKnownPack(name, listPackNames());
  const pack = loadPack(name);
  if (!pack.manifest.modes.includes("fresh")) {
    throw new CliUsageError(
      `pack "${name}" does not support fresh mode (modes: ${pack.manifest.modes.join(", ")})\n\n${USAGE}`,
    );
  }
  return pack;
}

/**
 * Rejects flags and targets adopt mode cannot honor, as usage errors (exit
 * 2) rather than silently ignoring them: a missing target directory (there
 * is nothing to survey), `--force` (adopt mode never writes project files),
 * and a `--pack` naming no available pack -- checked here, before `runAdopt`
 * touches anything under `.groundwork/`. A known `--pack` narrows the survey
 * to the named packs; unlike fresh mode, a pack whose `modes` lacks "adopt"
 * is still accepted, since adopt mode only surveys and stages it.
 */
function assertAdoptUsage(options: CliOptions): void {
  if (!existsSync(options.targetDir)) {
    throw new CliUsageError(
      `${options.targetDir} does not exist -- --adopt needs an existing project to survey (use fresh mode, or omit --adopt, to bootstrap a new one)\n\n${USAGE}`,
    );
  }
  if (options.force) {
    throw new CliUsageError(
      `--force has no effect in adopt mode -- adopt mode never writes project files; run /customize to reconcile instead.\n\n${USAGE}`,
    );
  }
  if (options.packs.length > 0) {
    const available = listPackNames();
    for (const name of options.packs) assertKnownPack(name, available);
  }
}

/**
 * The write-scope check both adopt and upgrade mode run over what they wrote:
 * every path in `paths` (absolute, or relative to `targetDir`) must resolve
 * inside one of `scope.roots` ({@link isPathContained}, so a sibling sharing
 * a root's name as a prefix is rejected) or equal one of `scope.files`, both
 * relative to `targetDir`. Lexical only: it never touches the filesystem.
 *
 * @throws `AssertionError` naming `label` and the first path out of scope.
 */
function assertWriteScope(
  targetDir: string,
  paths: readonly string[],
  scope: {
    readonly roots: readonly string[];
    readonly files: readonly string[];
  },
  label: string,
): void {
  const roots = scope.roots.map((root) => resolve(targetDir, root));
  const files = new Set(scope.files.map((file) => resolve(targetDir, file)));
  for (const path of paths) {
    const resolved = resolve(targetDir, path);
    assert.ok(
      files.has(resolved) ||
        roots.some((root) => isPathContained(resolved, root)),
      `${label} wrote outside its scope: ${resolved}`,
    );
  }
}

/**
 * Adopt mode's write-scope invariant (docs/assurance-case.md's trust
 * boundary around the adopted project): every path it writes resolves under
 * `<targetDir>/.groundwork/` or the guarded `/customize` install at
 * `<targetDir>/.claude/skills/customize/` -- never an existing project file.
 * `paths` may be absolute or relative to `targetDir`. Containment is
 * {@link isPathContained}'s, so a sibling that merely shares a root's name
 * as a prefix (`.groundwork-evil/`) is rejected. Both roots are derived from
 * `customize-paths.ts`'s segment constants, so they cannot drift from where
 * the install actually writes. The check is lexical -- it never touches the
 * filesystem, so it does not detect a symlinked directory component; that
 * refusal lives in the writers themselves (`fs-guard.ts`).
 *
 * @throws `AssertionError` (from `node:assert/strict`) naming the first path
 * that escapes both allowed roots.
 *
 * @example
 * ```ts
 * import { assertAdoptWriteScope } from "./main.js";
 *
 * assertAdoptWriteScope("/work/app", [".groundwork/inventory.json"]); // ok
 * assertAdoptWriteScope("/work/app", ["/work/app/package.json"]); // throws
 * ```
 */
export function assertAdoptWriteScope(
  targetDir: string,
  paths: readonly string[],
): void {
  assertWriteScope(
    targetDir,
    paths,
    {
      roots: [GROUNDWORK_DEST_SEGMENTS[0], join(...CLAUDE_DEST_SEGMENTS)],
      files: [],
    },
    "adopt mode",
  );
}

/**
 * Upgrade mode's write-scope invariant for the `/upgrade` skill install:
 * every path the installer reports writing must be one of
 * `plannedSkillPaths(UPGRADE_SKILL)` exactly -- not merely somewhere under
 * `.claude/skills/upgrade/` or `.groundwork/upgrade-skill/` -- so the install
 * can never touch the staged plan, the manifest or any project file.
 *
 * @throws `AssertionError` naming the first path out of scope.
 */
function assertUpgradeSkillWriteScope(
  targetDir: string,
  paths: readonly string[],
): void {
  assertWriteScope(
    targetDir,
    paths,
    { roots: [], files: plannedSkillPaths(UPGRADE_SKILL) },
    "upgrade mode",
  );
}

/** The previous run's files `runAdopt` deletes at its point of no return, in deletion order. */
const STALE_FILE_NAMES = [
  "inventory.json",
  "adoption-report.md",
  "adoption-decisions.json",
  "customization-report.md",
] as const;
type StaleFileName = (typeof STALE_FILE_NAMES)[number];

const DECISIONS_CAVEAT =
  "adoption-decisions.json held the decisions /customize recorded";
const CUSTOMIZATION_CAVEAT =
  "customization-report.md held the report /customize wrote";

/**
 * The "a re-run does not recreate it" caveat for whichever of the two
 * `/customize`-written files were removed: empty when neither was, one
 * clause when one was, and a single combined clause when both were.
 */
function notRecreatedCaveat(removed: readonly StaleFileName[]): string {
  const decisions = removed.includes("adoption-decisions.json");
  const customization = removed.includes("customization-report.md");
  if (decisions && customization) {
    return ` -- ${DECISIONS_CAVEAT}, and ${CUSTOMIZATION_CAVEAT}; a re-run recreates neither`;
  }
  if (decisions) {
    return ` -- ${DECISIONS_CAVEAT}, which a re-run does not recreate`;
  }
  if (customization) {
    return ` -- ${CUSTOMIZATION_CAVEAT}, which a re-run does not recreate`;
  }
  return "";
}

/**
 * Which previous `.groundwork/` files a failed run actually removed, worded
 * for a message: only those in `removed` are named, and the decisions file
 * and the customization report each carry their "a re-run does not recreate
 * it" caveat only when they are among them.
 */
function describeRemoved(removed: readonly StaleFileName[]): string {
  if (removed.length === 0) {
    return "no previous .groundwork/ inventory, adoption report, decisions file or customization report was removed";
  }
  const names =
    removed.length === 1
      ? removed.join("")
      : `${removed.slice(0, -1).join(", ")} and ${removed.slice(-1).join("")}`;
  const verb = removed.length === 1 ? "was" : "were";
  return `the previous .groundwork/${names} ${verb} removed${notRecreatedCaveat(removed)}`;
}

/**
 * A failure after `runAdopt`'s point of no return. The message embeds the
 * cause's own message so it stands alone (`formatErrorChain` then skips the
 * redundant `caused by:` line), names only the previous files actually
 * removed, and appends the re-run advice unless the cause already ends
 * with equivalent advice in any wording ({@link endsWithRerunAdvice}).
 */
function removedStaleFilesError(
  cause: unknown,
  removed: readonly StaleFileName[],
): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const advice = endsWithRerunAdvice(reason) ? "" : `; ${FIX_AND_RERUN_ADVICE}`;
  return new Error(
    `adopt mode failed (${reason}); ${describeRemoved(removed)}${advice}`,
    { cause },
  );
}

/**
 * Rethrows a failure after `runAdopt`'s point of no return. An
 * `AssertionError` (a broken invariant: a bug, not something a re-run
 * fixes) keeps its identity, after one warning naming the previous files it
 * removed, so that loss is not silent; anything else becomes
 * {@link removedStaleFilesError}.
 */
function rethrowAfterPointOfNoReturn(
  cause: unknown,
  removed: readonly StaleFileName[],
): never {
  if (cause instanceof assert.AssertionError) {
    if (removed.length > 0) {
      console.warn(
        `warning: adopt mode stopped on a broken invariant after ${describeRemoved(removed)}`,
      );
    }
    throw cause;
  }
  throw removedStaleFilesError(cause, removed);
}

/**
 * The adopt-mode next step after a `.groundwork/customize/` fallback, chosen
 * by why it was taken: only an `"entry"` fallback has a project-local copy
 * of the skill to replace. Returned without a `Next: ` prefix and starting
 * lower-case; each caller adds its own framing. `undefined` -- which the installer never returns
 * alongside a `"groundwork"` location -- is a contract violation and throws
 * rather than guessing.
 */
function groundworkNextStep(
  cause: GuardedInstallResult["fallbackCause"],
): string {
  const staged =
    "the current /customize skill is staged at .groundwork/customize/, but Claude Code does not load skills from there";
  switch (cause) {
    case "component":
      return `${staged}, and no project-local .claude/skills/customize/ copy exists -- fix or replace the .claude path named above so .claude/skills/customize/ is a real directory, copy the staged skill there and then run /customize, or run the m3l-groundwork plugin's own /customize.`;
    case "entry":
      return `${staged} -- run the m3l-groundwork plugin's own /customize, or replace the project-local .claude/skills/customize/ copy with the staged one and then run /customize.`;
    case undefined:
      throw new Error(
        'unhandled fallback cause: undefined (a "groundwork" install result must carry fallbackCause)',
      );
    default: {
      const exhaustive: never = cause;
      throw new Error(`unhandled fallback cause: ${String(exhaustive)}`);
    }
  }
}

/**
 * The report's `## Next step` text for a `"groundwork"` install result: the
 * fallback reason first, then {@link groundworkNextStep}'s sentence -- the
 * same order the console prints them in, which the `"component"` text's
 * "the .claude path named above" depends on. `renderReport` strips one
 * leading `Next: ` and upper-cases only the text's first character, so the
 * reason carries that prefix and the sentence after it is capitalized here.
 * A missing reason keeps the sentence alone rather than printing `undefined`.
 */
function groundworkReportNextStep(result: GuardedInstallResult): string {
  const sentence = groundworkNextStep(result.fallbackCause);
  const reason = result.fallbackReason;
  if (reason === undefined) {
    return `Next: ${sentence}`;
  }
  const separator = /[.!?]$/.test(reason) ? " " : ". ";
  return `Next: ${reason}${separator}${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/**
 * Where an `--adopt --json` survey writes its pending document, relative to
 * the target (POSIX separators). The one source for both the RunResult's
 * `pendingPath` and the absolute path written (`join` normalises the
 * separators), so the two cannot drift.
 */
const PENDING_RELATIVE_PATH = ".groundwork/headless/pending.json";

/** Adopt mode's advice for a refused `.groundwork/headless/` entry; ends with the tail `endsWithRerunAdvice` recognises. */
const REMOVE_AND_RERUN_ADVICE = "remove it and re-run the CLI";

/**
 * Removes a previous run's pending document and any leftover
 * `pending.json.tmp`, then `.groundwork/headless/` itself only if that left
 * it empty (non-recursive `rmdir`), so a file someone else keeps there
 * survives. An `ENOENT` or `ENOTEMPTY` from that `rmdir` (the directory
 * vanished, or something landed in it after the check) leaves it as is;
 * any other failure propagates unchanged.
 */
function removeStalePending(
  headlessDir: string,
  pendingPath: string,
  tmpPath: string,
): void {
  rmSync(pendingPath, { force: true });
  rmSync(tmpPath, { force: true });
  if (existsSync(headlessDir) && readdirSync(headlessDir).length === 0) {
    try {
      rmdirSync(headlessDir);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  }
}

/**
 * Hashes `inventory.json`'s bytes as written, builds the pending document
 * bound to them and writes it atomically (temp file, then rename) as
 * 2-space JSON with a trailing newline. Any failure -- the read, the hash,
 * a write or the rename -- removes the temp file (best effort: a failed
 * removal only warns) and throws an `Error` naming `pending.json`, with the
 * failure as `cause`; `inventory.json` and the report stay.
 */
function writePendingDocument(
  inventory: Inventory,
  inventoryPath: string,
  headlessDir: string,
  pendingPath: string,
  tmpPath: string,
): AnswersV1 {
  try {
    const inventorySha256 = createHash("sha256")
      .update(readFileSync(inventoryPath))
      .digest("hex");
    const doc = buildAdoptPending(inventory, { inventorySha256 });
    mkdirSync(headlessDir, { recursive: true });
    // Re-checked after mkdir (which follows a symlink raced in since the
    // up-front check), so nothing is written through one.
    assertNotSymlink(headlessDir);
    // Clear a leftover or planted temp path, then create it exclusively:
    // "wx" fails rather than following a symlink raced in between.
    rmSync(tmpPath, { force: true });
    writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(tmpPath, pendingPath);
    return doc;
  } catch (cause) {
    try {
      rmSync(tmpPath, { force: true });
    } catch (cleanupError) {
      // Best effort: the write failure below is the error worth reporting.
      console.warn(
        `warning: could not remove the temporary file ${tmpPath} -- delete it by hand (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
      );
    }
    throw new Error(
      `writing ${pendingPath} failed; .groundwork/inventory.json and adoption-report.md were written, but the pending document was not -- ${FIX_AND_RERUN_ADVICE}`,
      { cause },
    );
  }
}

/**
 * Surveys an already-established project and writes `.groundwork/` --
 * `inventory.json` and `adoption-report.md`. Never touches a project file:
 * the one addition is a purely-additive, collision-guarded copy of the
 * `/customize` skill (see `installCustomizeSkillGuarded`), so the report
 * can point straight at a working next step. Every pack under
 * `templates/packs/` -- or, when `--pack` names some, only those (validated
 * by `assertAdoptUsage`) -- is surveyed and staged, unapplied and inert, at
 * `.groundwork/packs/<name>/` -- its manifest as `pack.json.staged`, its
 * files as `files/<path>.staged` -- all packs written to a temporary
 * sibling directory and swapped in by rename, so `packs/` is never
 * half-written (`stagePacks`); absent baseline files are staged the same
 * way as inert `<path>.staged` copies at `.groundwork/baseline/`, and
 * divergent ones -- as the token-substituted bytes the comparison used -- at
 * `.groundwork/baseline-divergent/`. With a
 * previous staging in place each swap is two renames (park the old
 * directory, then move the new one in); a kill between them leaves that
 * directory absent with the old copy under its
 * `.packs-*`/`.baseline-*`/`.baseline-divergent-*`
 * work directory's `previous/` -- safe, because `inventory.json` was
 * already deleted, so nothing reads the gap as a completed run.
 *
 * Checked before anything under `.groundwork/` is deleted or written, in
 * this order: the four stale-file paths are scope-checked against
 * {@link assertAdoptWriteScope}; every surveyed pack is loaded and validated by
 * `loadPack` and surveyed (`planConflicts`, `observeWiring`); the pack
 * staging plan (`planPackStaging`) and the absent and divergent baseline
 * staging plans (`planBaselineStaging`, `planDivergentStaging`) are each
 * computed once, validated, and every path
 * they would write scope-checked; the `/customize` skill's planned install
 * paths (`plannedCustomizeSkillPaths`, a lexical check of its path
 * constants) are scope-checked; then `.groundwork/`, `.groundwork/packs`,
 * `.groundwork/baseline` and `.groundwork/baseline-divergent` are each
 * refused if they are a symlink. So an
 * invalid pack (a malformed manifest, a prototype-sensitive key in its
 * wiring, an unstageable file tree), an invalid baseline plan, an
 * out-of-scope staging or skill-install path, or a symlinked staging
 * directory throws with the previous `.groundwork/` untouched.
 *
 * **The point of no return** is the first deletion of a stale
 * `inventory.json`/`adoption-report.md`/`adoption-decisions.json`/
 * `customization-report.md` (in that order), which follows those checks;
 * which of the four existed is
 * recorded just before. A previous `.groundwork/headless/pending.json` is
 * deleted right after them, with or without `--json`, and
 * `.groundwork/headless/` too when that leaves it empty (it is scope-checked
 * and refused if a symlink with the others). After the deletions, packs, the
 * absent baseline files and the divergent ones are staged from the plans already computed (their trees are not walked
 * again), the harness and toolchain are graded, the `/customize` skill is
 * installed and its writes scope-checked, `adoption-report.md` is written
 * (its `## Next step` leading with the same sentence the console prints
 * when the skill fell back to `.groundwork/customize/`),
 * and `inventory.json` is written last (atomically, via a temp file and
 * rename). A failure in any of those steps -- a failed deletion included --
 * is rethrown as an `Error` with the failure as `cause` and its message
 * embedded, naming only the previous files that existed and were actually
 * removed (and, when `adoption-decisions.json` or `customization-report.md`
 * is among them, that it held the decisions or the report `/customize`
 * wrote, which a re-run does not recreate),
 * and saying to fix the cause and re-run the CLI -- once, even when the
 * cause's own message already says so. An `AssertionError` (a broken
 * write-scope or containment invariant, a bug a re-run cannot fix) keeps
 * its identity instead, after one `console.warn` naming the removed files
 * (none when nothing was removed).
 *
 * If `inventory.json` fails to write, the just-written report is first
 * removed (best effort: a failed removal only warns, never masking the
 * write failure). Without `--json` only console output follows
 * `inventory.json`, so its presence means every step of the run completed.
 * Under `--json` the pending document (`buildAdoptPending`, bound to
 * `inventory.json`'s sha256) is written after it, atomically, to
 * `.groundwork/headless/pending.json`; a failure there throws an `Error`
 * naming `pending.json` with the failure as `cause`, keeping
 * `inventory.json` and the report. `pending.json` is never left behind; the
 * temp file is removed on a best-effort basis (a failed removal only warns).
 */
function runAdopt(
  options: CliOptions,
  detection: ModeDetection,
  out: Out,
): RunResult {
  out.info(`adopt mode: ${detection.signal}`);

  const survey = surveyProject(options.targetDir);
  const templateRoot = templatesCoreDir();
  const tokens = buildTokens(options.projectName);
  // The survey's own `undetermined` list: a baseline or pack target this
  // process cannot reach is recorded there (and so in the report), never
  // reported as a clean add.
  const conflicts = planConflicts(
    templateRoot,
    options.targetDir,
    tokens,
    survey.undetermined,
  );

  const groundworkDir = join(options.targetDir, ".groundwork");
  const stagedBaselineDir = `.groundwork/${STAGED_BASELINE_DIR}`;
  const stagedDivergentDir = `.groundwork/${STAGED_DIVERGENT_DIR}`;
  const stalePaths = STALE_FILE_NAMES.map((name) => ({
    name,
    path: join(groundworkDir, name),
  }));
  const inventoryPath = join(groundworkDir, "inventory.json");
  const reportPath = join(groundworkDir, "adoption-report.md");
  const pendingPath = join(options.targetDir, PENDING_RELATIVE_PATH);
  const pendingTmpPath = `${pendingPath}.tmp`;
  const headlessDir = dirname(pendingPath);
  assertAdoptWriteScope(options.targetDir, [
    ...stalePaths.map(({ path }) => path),
    headlessDir,
    pendingPath,
    pendingTmpPath,
  ]);

  // Every surveyed pack must pass loadPack's validation (including its
  // prototype-sensitive wiring-key check), and every staging plan (packs,
  // absent and divergent baseline) must be computed and scope-checked,
  // before anything under
  // .groundwork/ is touched, so an invalid pack or plan fails the run with
  // the previous inventory/report still intact rather than half-cleared.
  const packNames = options.packs.length > 0 ? options.packs : listPackNames();
  const loadedPacks: Pack[] = packNames.map((name) => loadPack(name));
  const packs: PackSurvey[] = loadedPacks.map((pack) => ({
    name: pack.manifest.name,
    modes: pack.manifest.modes,
    budget: pack.manifest.budget,
    fileConflicts: planConflicts(
      pack.filesDir,
      options.targetDir,
      tokens,
      survey.undetermined,
    ),
    wiring: pack.manifest.wiring,
    wiringObservations: observeWiring(
      options.targetDir,
      pack.manifest,
      survey.undetermined,
    ),
    adoptNotes: pack.manifest.adoptNotes,
  }));
  // Each plan is computed once, here, and handed to its stager below, so
  // what was scope-checked is exactly what gets written.
  const packPlan = planPackStaging(loadedPacks, groundworkDir, tokens);
  assertAdoptWriteScope(options.targetDir, packPlan.paths);
  const baselinePlan = planBaselineStaging(
    templateRoot,
    conflicts,
    groundworkDir,
    tokens,
  );
  assertAdoptWriteScope(options.targetDir, baselinePlan.paths);
  const divergentPlan = planDivergentStaging(
    templateRoot,
    conflicts,
    groundworkDir,
    tokens,
  );
  assertAdoptWriteScope(options.targetDir, divergentPlan.paths);
  // A constant drift guard only: it lexically checks paths built from
  // customize-paths.ts's constants, so it can catch one of those constants
  // being edited to escape the project, and nothing else -- it reads no
  // filesystem state, so it cannot detect a symlink or any other runtime
  // condition. The installer lstat-checks every directory component itself
  // (and falls back to .groundwork/customize/ when one under .claude/ is a
  // symlink or not a directory -- see fallbackReason below).
  assertAdoptWriteScope(options.targetDir, plannedCustomizeSkillPaths());

  // A symlinked .groundwork/ or staging directory would redirect a delete
  // or a write outside the project; refuse it before anything is deleted.
  // (Each stager repeats its own check; these make the refusal precede the
  // deletions below.)
  assertNotSymlink(groundworkDir);
  assertNotSymlink(join(options.targetDir, STAGED_PACKS_DIR));
  assertNotSymlink(join(groundworkDir, STAGED_BASELINE_DIR));
  assertNotSymlink(join(groundworkDir, STAGED_DIVERGENT_DIR));
  // .groundwork/headless/ must be a real directory (or absent), and the
  // pending paths files: a directory at pending.json or its temp path would
  // fail the run only after the deletions below. A symlink at either is
  // fine -- it is removed, never followed.
  assertDirectoryComponent(headlessDir, REMOVE_AND_RERUN_ADVICE);
  assertNotDirectory(pendingPath, REMOVE_AND_RERUN_ADVICE);
  assertNotDirectory(pendingTmpPath, REMOVE_AND_RERUN_ADVICE);

  // Recorded before any deletion, so a failure message names only files a
  // previous run actually left (and this run actually removed).
  const preexisting = new Set(
    stalePaths.filter(({ path }) => existsSync(path)).map(({ name }) => name),
  );
  const removed: StaleFileName[] = [];

  let inventory: Inventory;
  let pluginResult: GuardedInstallResult;
  let nextStep: string;
  try {
    // The point of no return: the first deletion. A previous run's
    // inventory/report -- and the decisions and customization report
    // /customize wrote against them -- must not survive a run that fails
    // part-way: /customize would read them as describing the new staging.
    // All four go before anything is staged; inventory/report are rewritten
    // only at the end, and the decisions file and customization report only
    // by /customize. Inside the wrapping, so a failed
    // deletion reports which files are already gone. Every path is removed,
    // not just the pre-existing ones: existsSync follows symlinks, so a
    // dangling one must still go before the report's "wx" write below.
    for (const { name, path } of stalePaths) {
      rmSync(path, { force: true });
      if (preexisting.has(name)) {
        removed.push(name);
      }
    }
    // Bound to the inventory just deleted, so it goes too, with or without
    // --json: a pending document must never outlive its survey.
    removeStalePending(headlessDir, pendingPath, pendingTmpPath);

    const stagedPacks = stagePacks(
      loadedPacks,
      groundworkDir,
      tokens,
      packPlan,
    );
    const stagedBaselineFiles = stageBaselineAdditions(
      templateRoot,
      conflicts,
      groundworkDir,
      tokens,
      baselinePlan,
    );
    const stagedDivergentFiles = stageDivergentBaseline(
      templateRoot,
      conflicts,
      groundworkDir,
      tokens,
      divergentPlan,
    );

    inventory = buildInventory({
      detection,
      templateRoot,
      targetDir: options.targetDir,
      survey,
      conflicts,
      packs,
      harnessGrade: gradeHarness(options.targetDir),
      toolchainGrade: gradeToolchain(options.targetDir),
      stagedBaseline: {
        dir: stagedBaselineDir,
        suffix: STAGED_SUFFIX,
        files: stagedBaselineFiles,
      },
      stagedDivergent: {
        dir: stagedDivergentDir,
        suffix: STAGED_SUFFIX,
        files: stagedDivergentFiles,
      },
      stagedPacks,
    });

    // The /customize skill install runs before the two .groundwork/ files
    // (the report's "wx" write below can still fail after it), so
    // inventory.json's presence still means the install completed. Its
    // planned paths were scope-checked before the deletions above.
    pluginResult = installCustomizeSkillGuarded(options.targetDir);
    // Deliberately no rollback if this throws: what the installer reports it
    // wrote must sit inside the planned scope, so a failure here means the
    // installer and customize-paths.ts drifted apart -- a programming error
    // to surface loudly, not a runtime condition to recover from.
    assertAdoptWriteScope(options.targetDir, pluginResult.filesWritten);
    // Resolved before the report and inventory are written, so a contract
    // violation in the result fails the run before inventory.json claims it
    // completed.
    // The fresh copy is staged where Claude Code never loads a skill from,
    // so the generic next step would be false there; the report then names
    // the fallback reason and the same sentence the console prints, in the
    // console's order. Otherwise the report keeps its own generic sentence.
    const isGroundwork = pluginResult.location === "groundwork";
    nextStep = isGroundwork
      ? `Next: ${groundworkNextStep(pluginResult.fallbackCause)}`
      : "Next: open this project in Claude Code and run /customize.";
    const reportNextStep: string | undefined = isGroundwork
      ? groundworkReportNextStep(pluginResult)
      : undefined;

    // The report next, inventory.json last (written atomically): nothing
    // that can fail follows it, so its presence means the run completed.
    mkdirSync(groundworkDir, { recursive: true });
    // "wx": the path was removed above, so anything there now (a symlink
    // raced in mid-run) makes the write fail instead of being followed.
    writeFileSync(reportPath, renderReport(inventory, reportNextStep), {
      flag: "wx",
    });
  } catch (cause) {
    rethrowAfterPointOfNoReturn(cause, removed);
  }
  const { stagedPacks } = inventory;
  const stagedBaselineFiles = inventory.stagedBaseline.files;
  try {
    writeInventory(inventory, groundworkDir);
  } catch (error) {
    // Without inventory.json the run did not complete; a report left behind
    // would read as if it had. Best effort: a failed removal only warns, so
    // it can never mask the write failure being rethrown.
    try {
      rmSync(reportPath, { force: true });
    } catch (cleanupError) {
      console.warn(
        `warning: could not remove ${reportPath} after inventory.json failed to write -- delete it by hand (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
      );
    }
    rethrowAfterPointOfNoReturn(error, removed);
  }
  // Under --json only, after inventory.json: the document is bound to its
  // bytes. A failure here keeps inventory.json and the report, which are
  // complete; it is the pending document that is missing.
  const pending = options.json
    ? writePendingDocument(
        inventory,
        inventoryPath,
        headlessDir,
        pendingPath,
        pendingTmpPath,
      ).pending
    : [];

  out.info(`wrote ${relative(options.targetDir, inventoryPath)}`);
  out.info(`wrote ${relative(options.targetDir, reportPath)}`);
  if (options.json) {
    out.info(`wrote ${PENDING_RELATIVE_PATH}`);
  }
  if (stagedBaselineFiles.length > 0) {
    out.info(
      `staged ${stagedBaselineFiles.length} baseline file(s) at ${stagedBaselineDir}/ for /customize`,
    );
  }
  if (stagedPacks.length > 0) {
    out.info(
      `staged ${stagedPacks.length} pack(s) at ${STAGED_PACKS_DIR}/ for /customize`,
    );
  }
  if (pluginResult.location === "already-present") {
    out.info("the /customize skill was already up to date");
  } else {
    const where =
      pluginResult.location === "claude"
        ? ".claude/skills/customize/"
        : ".groundwork/customize/";
    out.info(
      `installed the /customize skill into ${where} (${pluginResult.filesWritten.length} files)`,
    );
    if (pluginResult.fallbackReason !== undefined) {
      out.info(`  ${pluginResult.fallbackReason}`);
    }
  }

  out.success(`\n✓ adoption report ready at ${reportPath}`);
  out.info(nextStep);
  return {
    mode: "adopt",
    target: options.targetDir,
    warnings: [],
    setupSteps: [],
    nextStep,
    manifest: null,
    pending,
    pendingPath: options.json ? PENDING_RELATIVE_PATH : null,
  };
}

/**
 * Rejects a target upgrade mode cannot plan, as usage errors (exit 2): one
 * that does not exist or is not a directory. Checked before mode detection,
 * which cannot list a file. The flags were checked by `parseArgs`.
 */
function assertUpgradeUsage(options: CliOptions): void {
  const { targetDir } = options;
  let stat: Stats | undefined;
  try {
    // ENOENT only is "absent"; any other failure (EACCES on a parent) is a
    // runtime error, never mistaken for a missing directory.
    stat = statSync(targetDir, { throwIfNoEntry: false });
  } catch (cause) {
    throw new Error(`could not inspect ${targetDir}`, { cause });
  }
  if (stat === undefined) {
    throw new CliUsageError(
      `${targetDir} does not exist -- --upgrade needs a project bootstrapped by this CLI\n\n${USAGE}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new CliUsageError(
      `${targetDir} is not a directory -- --upgrade needs a project directory\n\n${USAGE}`,
    );
  }
}

/** `upgrade plan <from> -> <to>: <n> <class>, ...` in the report's class order. */
function upgradeSummary(plan: UpgradePlan): string {
  const counts = countClasses(plan.files)
    .map(([cls, count]) => `${String(count)} ${cls}`)
    .join(", ");
  return `upgrade plan ${plan.fromCliVersion} -> ${plan.toCliVersion}: ${counts === "" ? "no files" : counts}`;
}

/** The usage error for a project with no manifest, shared by the plan and the stamp. */
function noManifestError(
  targetDir: string,
  options?: ErrorOptions,
): CliUsageError {
  return new CliUsageError(
    `${targetDir} has no ${MANIFEST_RELATIVE_PATH}, so there is no record to plan an upgrade from -- re-run the CLI in adopt mode in the project (npx @monte3l/groundwork .) and then run /customize to take the new release`,
    options,
  );
}

/**
 * Upgrade mode's stamp step (`--upgrade --stamp`): records the applied plan
 * in `.groundwork/manifest.json` with `stampUpgrade`, which writes nothing
 * else. Never renders the release, plans or stages.
 *
 * @throws {@link CliUsageError} (exit 2), before anything is written, when the
 *   project has no manifest (the same advice as the plan step) or no
 *   `plan.json`; the `ManifestError` unchanged when the manifest cannot be
 *   read, parsed or written; `stampUpgrade`'s `UpgradeStampError` for a plan
 *   that is invalid or stale (exit 1).
 */
function runUpgradeStamp(
  options: CliOptions,
  detection: ModeDetection,
  out: Out,
): undefined {
  const { targetDir } = options;
  out.info(`upgrade mode: ${detection.signal}`);
  let result: StampResult;
  try {
    result = stampUpgrade({ targetDir });
  } catch (error) {
    if (error instanceof UpgradeStampError && error.code === "no-manifest") {
      throw noManifestError(targetDir, { cause: error });
    }
    if (error instanceof UpgradeStampError && error.code === "no-plan") {
      throw new CliUsageError(
        `${targetDir} has no ${UPGRADE_RELATIVE_DIR}/${UPGRADE_PLAN_FILE}: no plan to stamp -- run --upgrade first`,
        { cause: error },
      );
    }
    throw error;
  }
  out.info(
    `stamped ${MANIFEST_RELATIVE_PATH} at ${result.manifest.cliVersion}: ${String(result.updated)} updated, ${String(result.kept)} kept, ${String(result.dropped)} dropped`,
  );
  return undefined;
}

/** The `/upgrade` skill's primary install directory, `/`-separated, for messages. */
const UPGRADE_SKILL_CLAUDE_DIR: string = UPGRADE_SKILL.claudeSegments.join("/");

/** The apply-case advice every `/upgrade` Next line ends with. */
const UPGRADE_APPLY_ADVICE =
  "run /upgrade to apply the plan (or apply the staged files by hand, then run --upgrade --stamp)";

/**
 * Installs the `/upgrade` skill with the guarded installer and checks what it
 * wrote against {@link assertUpgradeSkillWriteScope}. Runs only after the plan
 * is committed, so a throw from the installer becomes an `Error` saying the
 * plan was staged and that re-running `--upgrade` retries the install (the
 * installer's error as `cause`); the staged plan stays. An `AssertionError`,
 * from the installer or from the scope check (installer/`skill-spec.ts`
 * drift), is a bug that a re-run does not fix, and propagates unchanged.
 */
function installUpgradeSkill(targetDir: string): GuardedInstallResult {
  let result: GuardedInstallResult;
  try {
    result = installSkillGuarded(UPGRADE_SKILL, targetDir);
  } catch (cause) {
    // A broken invariant is a bug, not something a re-run fixes: it keeps
    // its identity, as in adopt mode's rethrowAfterPointOfNoReturn.
    if (cause instanceof assert.AssertionError) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `the upgrade plan was staged under ${UPGRADE_RELATIVE_DIR}/, but the /upgrade skill could not be installed (${reason}) -- re-run --upgrade to retry the skill install, then run /upgrade in Claude Code`,
      { cause },
    );
  }
  assertUpgradeSkillWriteScope(targetDir, result.filesWritten);
  return result;
}

/** The status lines for an `/upgrade` install result, the fallback reason indented under its line. */
function upgradeSkillInstallLines(result: GuardedInstallResult): string[] {
  switch (result.location) {
    case "already-present":
      return [
        `the /upgrade skill is already present in ${UPGRADE_SKILL_CLAUDE_DIR}`,
      ];
    case "claude":
    case "groundwork": {
      const where =
        result.location === "claude"
          ? UPGRADE_SKILL_CLAUDE_DIR
          : UPGRADE_SKILL_FALLBACK_RELATIVE_DIR;
      const lines = [
        `installed the /upgrade skill into ${where} (${String(result.filesWritten.length)} files)`,
      ];
      if (result.fallbackReason !== undefined) {
        lines.push(`  ${result.fallbackReason}`);
      }
      return lines;
    }
    default: {
      const exhaustive: never = result.location;
      throw new Error(`unhandled install location: ${String(exhaustive)}`);
    }
  }
}

/**
 * The `Next:` line for a plan with something to apply. After a fallback the
 * fresh copy sits where Claude Code never loads a skill from, so the line
 * says to put it in place first: by replacing the project's own copy
 * (`"entry"`), or by fixing the `.claude` path the fallback reason named
 * (`"component"`). A `"groundwork"` result without a cause is a contract
 * violation and throws rather than guessing.
 */
function upgradeApplyNextStep(result: GuardedInstallResult): string {
  if (result.location !== "groundwork") {
    return `Next: open this project in Claude Code and ${UPGRADE_APPLY_ADVICE}`;
  }
  const staged = `the current /upgrade skill is at ${UPGRADE_SKILL_FALLBACK_RELATIVE_DIR}/, but Claude Code does not load skills from there`;
  const cause = result.fallbackCause;
  switch (cause) {
    case "entry":
      return `Next: ${staged} -- replace the project-local ${UPGRADE_SKILL_CLAUDE_DIR}/ copy with it, then open this project in Claude Code and ${UPGRADE_APPLY_ADVICE}`;
    case "component":
      return `Next: ${staged} -- fix or replace the .claude path named above so ${UPGRADE_SKILL_CLAUDE_DIR}/ is a real directory and copy the skill there, then open this project in Claude Code and ${UPGRADE_APPLY_ADVICE}`;
    case undefined:
      throw new Error(
        'unhandled fallback cause: undefined (a "groundwork" install result must carry fallbackCause)',
      );
    default: {
      const exhaustive: never = cause;
      throw new Error(`unhandled fallback cause: ${String(exhaustive)}`);
    }
  }
}

/**
 * Upgrade mode: reads the project's `.groundwork/manifest.json`, renders this
 * release for it into a temporary directory (`renderRelease`), classifies
 * every baseline path and JSON key (`computePlan`) and stages the plan, its
 * report and the new copies under `.groundwork/upgrade/` (`stageUpgrade`).
 * The rendered release is always disposed of. Once the plan is committed it
 * installs the `/upgrade` skill with the guarded installer
 * (`installSkillGuarded(UPGRADE_SKILL, ...)`) into `.claude/skills/upgrade/`,
 * or `.groundwork/upgrade-skill/` when that path already holds a different
 * copy (one left by an earlier release included) or is not a real directory. Never
 * writes another project file or the manifest, and exits normally whatever
 * the plan holds, conflicts included: applying it is the skill's job. Its
 * last `Next:` line says to run `/upgrade` (or apply by hand, then
 * `--upgrade --stamp`), or, when `nothingToApply` holds for the plan, to run
 * `--upgrade --stamp` straight away.
 *
 * @throws {@link CliUsageError} with the adopt advice, before anything is
 *   written, when the project has no manifest; the `ManifestError` unchanged
 *   when the manifest cannot be read or parsed; the plan or staging module's
 *   `Error` otherwise, before the skill install; an `Error` saying the plan
 *   was staged when the skill install fails (the installer's error as
 *   `cause`); an `AssertionError` when the installer reports a path outside
 *   the skill's planned paths.
 */
function runUpgrade(
  options: CliOptions,
  detection: ModeDetection,
  out: Out,
): undefined {
  const { targetDir } = options;
  out.info(`upgrade mode: ${detection.signal}`);
  const manifest = readManifest(targetDir);
  if (manifest === undefined) throw noManifestError(targetDir);
  // Before rendering: a non-directory there is refused with nothing written.
  const foreign = inspectPreviousUpgrade(targetDir);
  const cliVersion = resolveCliVersion();
  const release = renderRelease({
    manifest,
    cliVersion,
    templatesDir: templatesCoreDir(),
    packsRoot: packsRootDir(),
  });
  let plan: UpgradePlan;
  let staged: StagedUpgrade;
  try {
    plan = computePlan({ targetDir, manifest, release, cliVersion });
    // Staged before dispose: the staged copies are read from the release.
    staged = stageUpgrade({ targetDir, plan, release });
  } finally {
    release.dispose();
  }
  // Warned only once the swap succeeded: a failed staging leaves them in place.
  if (foreign.length > 0) {
    out.warn(
      `warning: discarded ${foreign.join(", ")} from ${UPGRADE_RELATIVE_DIR}/ -- a decision recorded there is only valid beside its own plan, and this run wrote a new plan`,
    );
  }
  const count = staged.staged.length;
  out.info(upgradeSummary(plan));
  out.info(
    `wrote ${UPGRADE_RELATIVE_DIR}/ (${UPGRADE_PLAN_FILE}, ${UPGRADE_REPORT_FILE} and ${String(count)} staged ${count === 1 ? "file" : "files"})`,
  );
  // After the plan is committed and the release disposed: a failed install
  // leaves a complete plan, and the error says so.
  const skill = installUpgradeSkill(targetDir);
  for (const line of upgradeSkillInstallLines(skill)) out.info(line);
  out.info(
    nothingToApply(plan.files)
      ? "Next: nothing to apply -- run --upgrade --stamp to record the new release in the manifest"
      : upgradeApplyNextStep(skill),
  );
  return undefined;
}

/**
 * Runs the CLI. `platform` is injectable so fresh mode's Windows refusal
 * (a runtime error, exit 1, raised before anything is written) is
 * unit-testable on any OS; it defaults to `process.platform`. Adopt mode,
 * upgrade mode and `--help`/`--version`/`--list-packs` run on every platform.
 * `out` receives every fresh/adopt/upgrade status line; by default it is
 * `createOut` in human mode, or in json mode when `--json` is given (every
 * line on stderr). Returns the run's {@link RunResult}, or `undefined` for
 * `--help`/`--version`/`--list-packs` and for an `--upgrade` plan or stamp
 * (which refuse `--json`, so they have no report to build). Under `--json`, a fresh/adopt run
 * prints no report itself -- the bin script builds it from the returned
 * result -- while `--version` and `--list-packs` print one single-line JSON
 * document each (`groundwork.version`, `groundwork.packs`); `--help` always
 * prints the usage text.
 *
 * @example
 * ```ts
 * import { main } from "./main.js";
 * const result = main(["my-app", "--skip-install"]);
 * console.log(result?.mode); // "fresh"
 * ```
 */
export function main(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  out?: Out,
): RunResult | undefined {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.version) {
    console.log(
      options.json
        ? JSON.stringify({
            schema: "groundwork.version",
            schemaVersion: 1,
            cliVersion: resolveCliVersion(),
          })
        : resolveCliVersion(),
    );
    return;
  }
  if (options.listPacks) {
    const names = listPackNames();
    if (options.json) {
      const packs = names.map((name) => {
        const { manifest } = loadPack(name);
        return {
          name,
          modes: manifest.modes,
          description: manifest.description,
        };
      });
      console.log(
        JSON.stringify({ schema: "groundwork.packs", schemaVersion: 1, packs }),
      );
    } else if (names.length === 0) {
      console.log("no packs available");
    } else {
      for (const name of names) {
        const pack = loadPack(name);
        console.log(
          `${name} (modes: ${pack.manifest.modes.join(", ")}) -- ${pack.manifest.description}`,
        );
      }
    }
    return;
  }

  if (options.upgrade) {
    assertUpgradeUsage(options);
  }
  const detected = detectMode(options.targetDir);
  const resolved = resolveMode(detected, {
    adopt: options.adopt,
    fresh: options.fresh,
    upgrade: options.upgrade,
  });

  const sink = out ?? createOut({ json: options.json });
  switch (resolved.mode) {
    case "adopt":
      assertAdoptUsage(options);
      return runAdopt(options, resolved, sink);
    case "upgrade":
      return options.stamp
        ? runUpgradeStamp(options, resolved, sink)
        : runUpgrade(options, resolved, sink);
    case "fresh":
      return runFresh(options, platform, sink);
    default: {
      const unhandled: never = resolved.mode;
      throw new Error(`unhandled mode ${String(unhandled)}`);
    }
  }
}
