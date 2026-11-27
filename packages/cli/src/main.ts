// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Entry point: `m3l-groundwork <target-dir> [options]`. No prompts, no
 * interactivity, no network call beyond the package install -- this must
 * work on a plane against a warm pnpm store.
 *
 * Two modes, auto-detected from the target directory (`--adopt`/`--fresh`
 * force either): **fresh** writes the baseline template tree into an empty
 * or missing target directory, then installs any `--pack` requested.
 * **adopt** surveys an
 * already-established project and writes only a report -- see `mode.ts`,
 * `survey/survey.ts`, `conflicts.ts`, and `report.ts`. Adopt mode never
 * touches a project file, including a pack's: it surveys every pack under
 * `templates/packs/` into the report, stages each as inert `.staged` copies
 * under `.groundwork/packs/`, and defers installation to `/customize`; see
 * `runAdopt`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import assert from "node:assert/strict";
import { join, relative, resolve, basename } from "node:path";
import process from "node:process";
import { resolveAsset } from "./assets.js";
import type { CapCounts } from "./caps.js";
import { countBaselineCaps, formatCapsSummary } from "./caps.js";
import { assertSafeEmitDestinations, emitTemplate } from "./emit.js";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "./plugin.js";
import type { GuardedInstallResult, InstallPluginResult } from "./plugin.js";
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_FILE_NAMES,
  plannedCustomizeSkillPaths,
} from "./customize-paths.js";
import { gitInit, runInstall } from "./git.js";
import { gradeHarness } from "./harness/grade.js";
import { detectMode, resolveMode } from "./mode.js";
import { surveyProject } from "./survey/survey.js";
import { planConflicts } from "./conflicts.js";
import {
  STAGED_BASELINE_DIR,
  STAGED_SUFFIX,
  planBaselineStaging,
  stageBaselineAdditions,
} from "./baseline-stage.js";
import {
  assertDirectoryComponent,
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
import type { Pack } from "./packs.js";
import {
  listPackNames,
  loadPack,
  installPack,
  observeWiring,
} from "./packs.js";
import { STAGED_PACKS_DIR, planPackStaging, stagePacks } from "./pack-stage.js";
import { renderReport } from "./report.js";
import {
  assertSafeRecordDestination,
  recordFreshBootstrap,
} from "./record-bootstrap.js";
import type { RecordedPack } from "./record-bootstrap.js";
import {
  NPM_NAME_MAX_LENGTH,
  buildTokens,
  isNpmPackageName,
} from "./tokens.js";
import {
  PACK_STATUS_LABELS,
  inspectPackInstallations,
} from "./pack-installation.js";
import { errnoCode, isAbsentError } from "./survey/internal/read-guard.js";
import type { ModeDetection } from "./mode.js";
import { gradeToolchain } from "./toolchain/grade.js";
import { escapeControls } from "./format-error.js";
import { paint } from "./term.js";
import {
  assertAdoptPlannedScope,
  assertAdoptWriteScope,
} from "./write-scope.js";
import { CliUsageError, USAGE } from "./usage.js";
import { runAddPack } from "./add-pack.js";
import { runCheckUpdate } from "./check-update.js";
import { runUpdate } from "./update.js";

export { assertAdoptWriteScope } from "./write-scope.js";
export { CliUsageError } from "./usage.js";
export { formatCapsSummary } from "./caps.js";
export type { CapsSummary } from "./caps.js";

export interface CliOptions {
  targetDir: string;
  /** `--name`, else the target directory's basename -- except under `--add-pack`, where it stays `""` unless `--name` was given, so `runAddPack` can tell an explicit name from the default. */
  projectName: string;
  skipInstall: boolean;
  force: boolean;
  adopt: boolean;
  fresh: boolean;
  help: boolean;
  version: boolean;
  listPacks: boolean;
  packs: string[];
  /** The `--add-pack` names, de-duplicated and sorted; empty when not given. */
  addPacks: string[];
  /** `--reinstall`: stage a pack the project already has (only with `--add-pack`). */
  reinstall: boolean;
  /** `--check-update`: report whether this CLI's templates differ from the project's release. */
  checkUpdate: boolean;
  /** `--update`: stage an update under `.groundwork/update/` for `/customize update`. */
  update: boolean;
  /** `--base-version`: the release `--check-update` or `--update` starts from (plain `x.y.z`). */
  baseVersion: string | undefined;
  /** `--fetch-base`: with `--check-update` or `--update`, fetch the base release from npm when needed. */
  fetchBase: boolean;
}

// --name and --base-version take a single value; --pack and --add-pack are
// repeatable. Every other recognized flag is a bare boolean.
const VALUE_FLAGS = new Set(["--name", "--base-version"]);
const REPEATABLE_VALUE_FLAGS = new Set(["--pack", "--add-pack"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
const LIST_PACKS_FLAGS = new Set(["--list-packs"]);
// A --pack value is a bare directory name under templates/packs/ -- this
// allowlist keeps it from ever reaching packs.ts's join() as a path.
const PACK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
// A --base-version value is a plain release version: no prefix, no prerelease.
const BASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--skip-install",
  "--force",
  "--adopt",
  "--fresh",
  "--reinstall",
  "--check-update",
  "--update",
  "--fetch-base",
  ...LIST_PACKS_FLAGS,
  ...HELP_FLAGS,
  ...VERSION_FLAGS,
]);

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
 * The values of the repeatable pack-name flag `flag`, each checked against
 * {@link PACK_NAME_PATTERN} (a usage error naming the first bad one), then
 * de-duplicated and sorted.
 */
function packNamesOf(
  repeatableValues: ReadonlyMap<string, string[]>,
  flag: "--pack" | "--add-pack",
): string[] {
  const values = repeatableValues.get(flag) ?? [];
  const bad = values.find((name) => !PACK_NAME_PATTERN.test(name));
  if (bad !== undefined) {
    throw new CliUsageError(
      `${flag} must be a pack name matching ${PACK_NAME_PATTERN.source}: ${JSON.stringify(bad)}\n\n${USAGE}`,
    );
  }
  return [...new Set(values)].sort();
}

/**
 * Rejects what `--check-update` and `--update` cannot honor, as usage errors
 * (exit 2): the two together, either with any flag that installs, stages,
 * lists or names (naming both flags), `--base-version` or `--fetch-base`
 * without either, and a `--base-version` that is not a plain `x.y.z`.
 */
function assertCheckUpdateUsage(tokenized: TokenizedArgv): void {
  const { flags, values, repeatableValues } = tokenized;
  const baseVersion = values.get("--base-version");
  const checkUpdate = flags.has("--check-update");
  const update = flags.has("--update");
  if (!checkUpdate && !update) {
    if (baseVersion !== undefined) {
      throw new CliUsageError(
        `--base-version only applies to --check-update or --update -- add one of them, or drop --base-version\n\n${USAGE}`,
      );
    }
    if (flags.has("--fetch-base")) {
      throw new CliUsageError(
        `--fetch-base only applies to --check-update or --update -- add one of them, or drop --fetch-base\n\n${USAGE}`,
      );
    }
    return;
  }
  const flag = update ? "--update" : "--check-update";
  const conflicting = [
    update && checkUpdate ? "--check-update" : undefined,
    repeatableValues.has("--pack") ? "--pack" : undefined,
    repeatableValues.has("--add-pack") ? "--add-pack" : undefined,
    values.has("--name") ? "--name" : undefined,
    ...[
      "--reinstall",
      "--adopt",
      "--fresh",
      "--force",
      "--skip-install",
      ...LIST_PACKS_FLAGS,
    ].map((flag) => (flags.has(flag) ? flag : undefined)),
  ].filter((flag) => flag !== undefined);
  if (conflicting.length > 0) {
    throw new CliUsageError(
      `${flag} cannot be combined with ${conflicting.join(", ")} -- ${
        update
          ? "--update only stages an update, under .groundwork/update/"
          : "--check-update only reads the project and reports"
      }\n\n${USAGE}`,
    );
  }
  if (baseVersion !== undefined && !BASE_VERSION_PATTERN.test(baseVersion)) {
    throw new CliUsageError(
      `--base-version must be a plain release version x.y.z: ${JSON.stringify(baseVersion)}\n\n${USAGE}`,
    );
  }
}

/** Parses argv into structured options. Throws with USAGE on a missing target dir, unless --help/--version/--list-packs is present. */
export function parseArgs(argv: string[]): CliOptions {
  const tokenized = tokenizeArgv(argv);
  const { positional, flags, values, repeatableValues } = tokenized;

  const help = [...HELP_FLAGS].some((flag) => flags.has(flag));
  const version = [...VERSION_FLAGS].some((flag) => flags.has(flag));
  const listPacks = [...LIST_PACKS_FLAGS].some((flag) => flags.has(flag));
  const checkUpdate = flags.has("--check-update");
  if (!help && !version) {
    assertCheckUpdateUsage(tokenized);
  }

  if (help || version || listPacks) {
    // `--list-packs <dir>` reports that project's pack status; the bare form
    // (and --help/--version) carries no directory.
    const listDir = listPacks && !help && !version ? positional[0] : undefined;
    if (listDir !== undefined && positional.length > 1) {
      throw new CliUsageError(
        `unexpected argument(s): ${positional.slice(1).join(" ")}\n\n${USAGE}`,
      );
    }
    return {
      targetDir: listDir === undefined ? "" : resolve(listDir),
      projectName: "",
      skipInstall: false,
      force: false,
      adopt: false,
      fresh: false,
      help,
      version,
      listPacks,
      packs: [],
      addPacks: [],
      reinstall: false,
      checkUpdate: false,
      update: false,
      baseVersion: undefined,
      fetchBase: false,
    };
  }

  if (flags.has("--adopt") && flags.has("--fresh")) {
    throw new CliUsageError(
      `--adopt and --fresh are mutually exclusive\n\n${USAGE}`,
    );
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
  // A --name value is substituted verbatim into the emitted package.json.
  if (explicitName !== undefined && !isNpmPackageName(explicitName)) {
    throw new CliUsageError(
      `--name must be a valid npm package name (lowercase, optional @scope/, at most ${String(NPM_NAME_MAX_LENGTH)} characters): ${JSON.stringify(explicitName)}\n\n${USAGE}`,
    );
  }
  const packs = packNamesOf(repeatableValues, "--pack");
  const addPacks = packNamesOf(repeatableValues, "--add-pack");

  return {
    targetDir,
    // Under --add-pack an absent --name stays "": runAddPack then proposes
    // package.json's name before the basename, which it could not do if the
    // basename were already filled in here.
    projectName:
      explicitName ?? (addPacks.length > 0 ? "" : basename(targetDir)),
    skipInstall: flags.has("--skip-install"),
    force: flags.has("--force"),
    adopt: flags.has("--adopt"),
    fresh: flags.has("--fresh"),
    help: false,
    version: false,
    listPacks: false,
    packs,
    addPacks,
    reinstall: flags.has("--reinstall"),
    checkUpdate,
    update: flags.has("--update"),
    baseVersion: values.get("--base-version"),
    fetchBase: flags.has("--fetch-base"),
  };
}

/** Resolves `templates/core` for a source checkout or a published tarball -- see `assets.ts`. */
export function templatesCoreDir(): string {
  return resolveAsset({ repo: "templates/core", local: "templates/core" });
}

function isEmptyOrMissing(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

/**
 * Fresh mode's closing "setup required" block: one heading, then each pack
 * that declares `setupSteps` (in `packs` order) followed by its commands,
 * each indented two spaces. `undefined` when no pack declares any, so the
 * caller prints nothing extra.
 */
function formatSetupBlock(
  targetDir: string,
  packs: readonly Pack[],
): string | undefined {
  const lines: string[] = [];
  for (const { manifest } of packs) {
    const steps = manifest.setupSteps ?? [];
    if (steps.length === 0) continue;
    lines.push(`pack "${manifest.name}":`, ...steps.map((step) => `  ${step}`));
  }
  if (lines.length === 0) return undefined;
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

function runFresh(options: CliOptions, platform: NodeJS.Platform): void {
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
  // And the lock/base/ledger record written after the skill install.
  assertSafeRecordDestination(options.targetDir);

  mkdirSync(options.targetDir, { recursive: true });

  const result = emitTemplate(templatesCoreDir(), options.targetDir, tokens);
  console.log(
    `wrote ${result.filesWritten.length} files to ${options.targetDir}`,
  );

  const installedPacks: { name: string; budget: CapCounts }[] = [];
  const recordedPacks: RecordedPack[] = [];
  for (const pack of packs) {
    const name = pack.manifest.name;
    const packResult = installPack(pack, options.targetDir, tokens);
    recordedPacks.push({
      manifest: pack.manifest,
      filesWritten: packResult.filesWritten,
      wiringApplied: packResult.wiringApplied,
    });
    console.log(
      `installed pack "${name}" (${packResult.filesWritten.length} files)`,
    );
    installedPacks.push({ name, budget: packResult.budget });
  }
  if (installedPacks.length > 0) {
    const summary = formatCapsSummary(
      countBaselineCaps(templatesCoreDir()),
      installedPacks,
    );
    console.log(
      summary.overCap
        ? paint(process.stdout, "warning", summary.text)
        : summary.text,
    );
  }

  const { targetDir, skipInstall, projectName } = options;

  // Built once, now that the project and its packs are on disk, and printed
  // exactly once per run: at the very end on success, or just before the
  // throw when git init / pnpm install fails -- a plain re-run of a
  // non-empty target adopts it, and adopt mode never prints setupSteps. The
  // /customize-skill failure below deliberately does not print it: its
  // message says to re-run with --fresh --force, which prints it on success.
  const setupBlock = formatSetupBlock(targetDir, packs);
  const printSetupBlock = (): void => {
    if (setupBlock !== undefined) {
      console.log(paint(process.stdout, "warning", setupBlock));
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
  console.log(
    pluginResult.filesWritten.length === 0
      ? "the /customize skill was already up to date"
      : `installed the /customize skill (${pluginResult.filesWritten.length} files)`,
  );

  let recorded: number;
  try {
    recorded = recordFreshBootstrap({
      targetDir,
      tokens,
      coreFiles: result.filesWritten,
      // A no-op install wrote nothing because the payload on disk is already
      // identical: record that payload (a missing file fails the record).
      skillFiles:
        pluginResult.filesWritten.length > 0
          ? pluginResult.filesWritten
          : CUSTOMIZE_SKILL_FILE_NAMES.map((name) =>
              [...CLAUDE_DEST_SEGMENTS, name].join("/"),
            ),
      packs: recordedPacks,
    });
  } catch (error) {
    // Same retry shape as the skill-install failure above.
    const notRun = skipInstall ? "git init" : "git init / pnpm install";
    throw new Error(
      `the project was written to ${targetDir}, but its lock/base record (.groundwork/groundwork.lock.json, .groundwork/base/) could not be written and ${notRun} did not run -- fix the cause, then re-run with --fresh --force (plus your original --name/--pack/--skip-install); a plain re-run adopts it`,
      { cause: error },
    );
  }
  console.log(
    `recorded ${String(recorded)} files in .groundwork/groundwork.lock.json`,
  );

  try {
    gitInit(targetDir);
  } catch (error) {
    printSetupBlock();
    throw new Error(
      `git init failed, but the project was written to ${targetDir}; run \`git init\`${skipInstall ? "" : " and `pnpm install`"} there yourself`,
      { cause: error },
    );
  }
  console.log("initialized git repository");

  if (!skipInstall) {
    try {
      runInstall(targetDir);
    } catch (error) {
      console.log(
        paint(
          process.stdout,
          "warning",
          `\n${projectName} written to ${targetDir}, but dependencies are not installed`,
        ),
      );
      printSetupBlock();
      throw new Error(
        `${describeInstallFailure(error)}; the project was written to ${targetDir} -- run \`pnpm install\` there yourself to finish`,
        { cause: error },
      );
    }
    console.log("installed dependencies");
  }

  console.log(
    paint(
      process.stdout,
      "success",
      `\n✓ ${projectName} is ready at ${targetDir}`,
    ),
  );
  printSetupBlock();
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
 * Loads one `--pack` for fresh mode -- called for every pack before any file
 * is written. An unknown name (the message lists the available packs) or a
 * fresh-incompatible pack is a usage error (exit 2); a pack that exists but
 * whose manifest fails to load propagates `loadPack`'s own error unchanged
 * (exit 1), since that is a broken install, not a bad invocation.
 */
function resolveFreshPack(name: string): Pack {
  const available = listPackNames();
  if (!available.includes(name)) {
    const list = available.length > 0 ? available.join(", ") : "none";
    throw new CliUsageError(
      `unknown pack "${name}" (available: ${list})\n\n${USAGE}`,
    );
  }
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
 * and `--pack` (every pack is surveyed automatically).
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
    throw new CliUsageError(
      `--pack has no effect in adopt mode -- every pack is surveyed automatically; run /customize to install one.\n\n${USAGE}`,
    );
  }
}

/**
 * Rejects flag combinations `--add-pack` cannot honor, as usage errors (exit
 * 2) naming the conflicting flags: `--add-pack` with `--pack`, `--adopt`,
 * `--fresh`, `--force` or `--skip-install` (it only stages, into a project
 * that already exists, and never runs a mode), and `--reinstall` without
 * `--add-pack`. A missing target directory is already refused by
 * {@link parseArgs}.
 */
function assertAddPackUsage(options: CliOptions): void {
  if (options.addPacks.length === 0) {
    if (options.reinstall) {
      throw new CliUsageError(
        `--reinstall only applies to --add-pack -- add --add-pack <name>, or drop --reinstall\n\n${USAGE}`,
      );
    }
    return;
  }
  const conflicting = [
    options.packs.length > 0 ? "--pack" : undefined,
    options.adopt ? "--adopt" : undefined,
    options.fresh ? "--fresh" : undefined,
    options.force ? "--force" : undefined,
    options.skipInstall ? "--skip-install" : undefined,
  ].filter((flag) => flag !== undefined);
  if (conflicting.length > 0) {
    throw new CliUsageError(
      `--add-pack cannot be combined with ${conflicting.join(", ")} -- --add-pack only stages packs into an existing project, under .groundwork/add-pack/\n\n${USAGE}`,
    );
  }
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
 * Surveys an already-established project and writes `.groundwork/` --
 * `inventory.json` and `adoption-report.md`. Never touches a project file:
 * the one addition is a purely-additive, collision-guarded copy of the
 * `/customize` skill (see `installCustomizeSkillGuarded`), so the report
 * can point straight at a working next step. Every pack under
 * `templates/packs/` is surveyed (`main` rejects `--pack` in this mode, see
 * `assertAdoptUsage`) and staged, unapplied and inert, at
 * `.groundwork/packs/<name>/` -- its manifest as `pack.json.staged`, its
 * files as `files/<path>.staged` -- all packs written to a temporary
 * sibling directory and swapped in by rename, so `packs/` is never
 * half-written (`stagePacks`); absent baseline files are staged the same
 * way as inert `<path>.staged` copies at `.groundwork/baseline/`. With a
 * previous staging in place each swap is two renames (park the old
 * directory, then move the new one in); a kill between them leaves that
 * directory absent with the old copy under its `.packs-*`/`.baseline-*`
 * work directory's `previous/` -- safe, because `inventory.json` was
 * already deleted, so nothing reads the gap as a completed run.
 *
 * Checked before anything under `.groundwork/` is deleted or written, in
 * this order: the four stale-file paths are scope-checked against
 * {@link assertAdoptWriteScope}; every pack is loaded and validated by
 * `loadPack` and surveyed (`planConflicts`, `observeWiring`); the pack
 * staging plan (`planPackStaging`) and the baseline staging plan
 * (`planBaselineStaging`) are each computed once, validated, and every path
 * they would write scope-checked; the `/customize` skill's planned install
 * paths (`plannedCustomizeSkillPaths`, a lexical check of its path
 * constants) are scope-checked; then `.groundwork/`, `.groundwork/packs`
 * and `.groundwork/baseline` are each refused if they are a symlink. So an
 * invalid pack (a malformed manifest, a prototype-sensitive key in its
 * wiring, an unstageable file tree), an invalid baseline plan, an
 * out-of-scope staging or skill-install path, or a symlinked staging
 * directory throws with the previous `.groundwork/` untouched.
 *
 * **The point of no return** is the first deletion of a stale
 * `inventory.json`/`adoption-report.md`/`adoption-decisions.json`/
 * `customization-report.md` (in that order), which follows those checks;
 * which of the four existed is
 * recorded just before. After the deletions, packs and the baseline are
 * staged from the plans already computed (their trees are not walked
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
 * write failure). Only console output follows `inventory.json`, so its
 * presence means every step of the run completed.
 */
function runAdopt(options: CliOptions, detection: ModeDetection): void {
  console.log(`adopt mode: ${detection.signal}`);

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
  const stalePaths = STALE_FILE_NAMES.map((name) => ({
    name,
    path: join(groundworkDir, name),
  }));
  const inventoryPath = join(groundworkDir, "inventory.json");
  const reportPath = join(groundworkDir, "adoption-report.md");
  assertAdoptWriteScope(
    options.targetDir,
    stalePaths.map(({ path }) => path),
  );

  // Every pack must pass loadPack's validation (including its
  // prototype-sensitive wiring-key check), and both staging plans (packs and
  // baseline) must be computed and scope-checked, before anything under
  // .groundwork/ is touched, so an invalid pack or plan fails the run with
  // the previous inventory/report still intact rather than half-cleared.
  const loadedPacks: Pack[] = listPackNames().map((name) => loadPack(name));
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
  // A constant drift guard only: it lexically checks paths built from
  // customize-paths.ts's constants, so it can catch one of those constants
  // being edited to escape the project, and nothing else -- it reads no
  // filesystem state, so it cannot detect a symlink or any other runtime
  // condition. The installer lstat-checks every directory component itself
  // (and falls back to .groundwork/customize/ when one under .claude/ is a
  // symlink or not a directory -- see fallbackReason below).
  assertAdoptPlannedScope(options.targetDir, plannedCustomizeSkillPaths());

  // A symlinked .groundwork/ or staging directory would redirect a delete
  // or a write outside the project; refuse it before anything is deleted.
  // (Each stager repeats its own check; these make the refusal precede the
  // deletions below.)
  assertNotSymlink(groundworkDir);
  assertNotSymlink(join(options.targetDir, STAGED_PACKS_DIR));
  assertNotSymlink(join(groundworkDir, STAGED_BASELINE_DIR));

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

  console.log(`wrote ${relative(options.targetDir, inventoryPath)}`);
  console.log(`wrote ${relative(options.targetDir, reportPath)}`);
  if (stagedBaselineFiles.length > 0) {
    console.log(
      `staged ${stagedBaselineFiles.length} baseline file(s) at ${stagedBaselineDir}/ for /customize`,
    );
  }
  if (stagedPacks.length > 0) {
    console.log(
      `staged ${stagedPacks.length} pack(s) at ${STAGED_PACKS_DIR}/ for /customize`,
    );
  }
  if (pluginResult.location === "already-present") {
    console.log("the /customize skill was already up to date");
  } else {
    const where =
      pluginResult.location === "claude"
        ? ".claude/skills/customize/"
        : ".groundwork/customize/";
    console.log(
      `installed the /customize skill into ${where} (${pluginResult.filesWritten.length} files)`,
    );
    if (pluginResult.fallbackReason !== undefined) {
      console.log(`  ${pluginResult.fallbackReason}`);
    }
  }

  console.log(
    paint(
      process.stdout,
      "success",
      `\n✓ adoption report ready at ${reportPath}`,
    ),
  );
  console.log(nextStep);
}

/**
 * {@link escapeControls}, then every line break it normalised to `\n` is
 * rendered as the literal text `\n`, so a project-controlled value always
 * prints on the one line it was given and cannot forge a line of its own.
 */
function escapeInline(text: string): string {
  return escapeControls(text).replaceAll("\n", "\\n");
}

/**
 * `--list-packs <dir>`: the project's origin, then one status line per pack,
 * then any undetermined note. Read-only; a missing or non-directory target is
 * a usage error naming the path, and so is one that cannot be checked at all,
 * naming the path and the errno with the original failure as `cause`.
 *
 * The origin evidence and every note can carry project-controlled text (the
 * name of a `.groundwork/` entry), so each is printed through
 * `escapeInline`: no control character reaches the terminal raw, and none
 * can break the line it sits on. Pack names, modes and descriptions come
 * from this package's own templates and print as they are.
 */
function listPackStatus(targetDir: string): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(targetDir).isDirectory();
  } catch (error) {
    if (!isAbsentError(error)) {
      throw new CliUsageError(
        `${targetDir} could not be checked (${errnoCode(error) ?? "unknown error"}) -- --list-packs <dir> needs a project directory it can inspect\n\n${USAGE}`,
        { cause: error },
      );
    }
    // Absent: reported as "not an existing directory" just below.
  }
  if (!isDirectory) {
    throw new CliUsageError(
      `${targetDir} is not an existing directory -- --list-packs <dir> needs a project directory to inspect\n\n${USAGE}`,
    );
  }
  const report = inspectPackInstallations(targetDir);
  console.log(
    `project: ${report.origin.kind} (${report.origin.evidence.map(escapeInline).join("; ")})`,
  );
  for (const {
    name,
    modes,
    description,
    status,
    ledgerVersion,
  } of report.packs) {
    // An outdated pack names the CLI version its ledger entry records.
    const ledger =
      status.source !== "ledger"
        ? ""
        : ledgerVersion === undefined
          ? " (ledger)"
          : ` (ledger ${ledgerVersion})`;
    console.log(
      `${name} (modes: ${modes.join(", ")}) [${PACK_STATUS_LABELS[status.status]}]${ledger} -- ${description}`,
    );
  }
  for (const note of report.undetermined) {
    console.log(`note: ${escapeInline(note)}`);
  }
}

/**
 * Runs the CLI and returns the exit code to set, or `undefined` to leave it
 * (`--check-update` returns 0 up to date or 3 update available; `--update`
 * returns 0).
 * `platform` is injectable so fresh mode's Windows refusal
 * (a runtime error, exit 1, raised before anything is written) is
 * unit-testable on any OS; it defaults to `process.platform`. Adopt mode,
 * `--add-pack`, `--check-update`, `--update` and `--help`/`--version`/`--list-packs`
 * run on every platform.
 */
export function main(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(USAGE);
    return undefined;
  }
  if (options.version) {
    console.log(resolveCliVersion());
    return undefined;
  }
  if (options.listPacks && options.targetDir !== "") {
    listPackStatus(options.targetDir);
    return undefined;
  }
  if (options.listPacks) {
    const names = listPackNames();
    if (names.length === 0) {
      console.log("no packs available");
    } else {
      for (const name of names) {
        const pack = loadPack(name);
        console.log(
          `${name} (modes: ${pack.manifest.modes.join(", ")}) -- ${pack.manifest.description}`,
        );
      }
    }
    return undefined;
  }
  if (options.checkUpdate) {
    // Read-only: never through mode detection, never creating anything.
    return runCheckUpdate({
      targetDir: options.targetDir,
      baseVersion: options.baseVersion,
      fetchBase: options.fetchBase,
    });
  }

  if (options.update) {
    // Staging only: never through mode detection, never writing outside
    // .groundwork/update/.
    return runUpdate({
      targetDir: options.targetDir,
      baseVersion: options.baseVersion,
      fetchBase: options.fetchBase,
    });
  }

  assertAddPackUsage(options);
  if (options.addPacks.length > 0) {
    // Staging only: never through mode detection, never a fresh or adopt run.
    runAddPack(options);
    return undefined;
  }

  const detected = detectMode(options.targetDir);
  const resolved = resolveMode(detected, {
    adopt: options.adopt,
    fresh: options.fresh,
  });

  if (resolved.mode === "adopt") {
    assertAdoptUsage(options);
    runAdopt(options, resolved);
  } else {
    runFresh(options, platform);
  }
  return undefined;
}
