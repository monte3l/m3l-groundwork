/**
 * Entry point: `m3l-groundwork <target-dir> [options]`. No prompts, no
 * interactivity, no network call beyond the package install -- this must
 * work on a plane against a warm pnpm store.
 *
 * Two modes, auto-detected from the target directory (`--adopt`/`--fresh`
 * force either): **fresh** writes the baseline into an empty directory, as
 * before, and installs any `--pack` requested. **adopt** surveys an
 * already-established project and writes only a report -- see `mode.ts`,
 * `survey/survey.ts`, `conflicts.ts`, and `report.ts`. Adopt mode never
 * touches a project file, including a pack's: it surveys every pack under
 * `templates/packs/` into the report and defers installation to
 * `/customize`; see `runAdopt`.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { resolveAsset } from "./assets.js";
import type { CapCounts } from "./caps.js";
import { CAP_LIMITS, countBaselineCaps } from "./caps.js";
import { emitTemplate } from "./emit.js";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "./plugin.js";
import { gitInit, runInstall } from "./git.js";
import { gradeHarness } from "./harness/grade.js";
import { detectMode, resolveMode } from "./mode.js";
import { surveyProject } from "./survey/survey.js";
import { planConflicts } from "./conflicts.js";
import {
  buildInventory,
  resolveCliVersion,
  writeInventory,
} from "./inventory.js";
import type { PackSurvey } from "./inventory.js";
import {
  listPackNames,
  loadPack,
  installPack,
  observeWiring,
  stagePackFiles,
} from "./packs.js";
import { renderReport } from "./report.js";
import type { TokenTable } from "./tokens.js";
import type { ModeDetection } from "./mode.js";
import { gradeToolchain } from "./toolchain/grade.js";

export interface CliOptions {
  targetDir: string;
  projectName: string;
  skipInstall: boolean;
  force: boolean;
  adopt: boolean;
  fresh: boolean;
  help: boolean;
  version: boolean;
  listPacks: boolean;
  packs: string[];
}

const USAGE = [
  "usage: m3l-groundwork <target-dir> [options]",
  "",
  "  --name <project-name>   Override the project name (default: the target directory's basename)",
  "  --skip-install          Skip the final `pnpm install` (fresh mode only)",
  "  --force                 Overwrite a non-empty target directory (fresh mode only)",
  "  --adopt                 Force adopt mode, even if the target looks empty",
  "  --fresh                 Force fresh-bootstrap mode, even if the target looks pre-existing",
  "  --pack <name>           Install an opt-in pack from templates/packs/ (fresh mode only; repeatable)",
  "  --list-packs            Print every available pack and exit",
  "  --help, -h              Print this message",
  "  --version, -v           Print the CLI's version",
  "",
  "With no --adopt/--fresh override, the target directory is inspected: an",
  "empty or missing directory bootstraps fresh; a directory that already",
  "looks like a project (package.json, .git, or loose source files) is",
  "surveyed and adopted instead -- see .groundwork/adoption-report.md.",
  "",
  "--pack and --force are rejected in adopt mode -- adopt mode never writes",
  "project files. Every available pack is surveyed into the report",
  "automatically; run /customize to install one.",
].join("\n");

// --name takes a single value; --pack is repeatable. Every other
// recognized flag is a bare boolean.
const VALUE_FLAGS = new Set(["--name"]);
const REPEATABLE_VALUE_FLAGS = new Set(["--pack"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);
const LIST_PACKS_FLAGS = new Set(["--list-packs"]);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--skip-install",
  "--force",
  "--adopt",
  "--fresh",
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
 * npx @monte3l/groundwork@next ./my-app --bogus
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

/** Parses argv into structured options. Throws with USAGE on a missing target dir, unless --help/--version/--list-packs is present. */
export function parseArgs(argv: string[]): CliOptions {
  const { positional, flags, values, repeatableValues } = tokenizeArgv(argv);

  const help = [...HELP_FLAGS].some((flag) => flags.has(flag));
  const version = [...VERSION_FLAGS].some((flag) => flags.has(flag));
  const listPacks = [...LIST_PACKS_FLAGS].some((flag) => flags.has(flag));

  if (help || version || listPacks) {
    return {
      targetDir: "",
      projectName: "",
      skipInstall: false,
      force: false,
      adopt: false,
      fresh: false,
      help,
      version,
      listPacks,
      packs: [],
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
  const packs = [...new Set(repeatableValues.get("--pack") ?? [])].sort();

  return {
    targetDir,
    projectName: explicitName ?? basename(targetDir),
    skipInstall: flags.has("--skip-install"),
    force: flags.has("--force"),
    adopt: flags.has("--adopt"),
    fresh: flags.has("--fresh"),
    help: false,
    version: false,
    listPacks: false,
    packs,
  };
}

/** Resolves `templates/core` for a source checkout or a published tarball -- see `assets.ts`. */
export function templatesCoreDir(): string {
  return resolveAsset({ repo: "templates/core", local: "templates/core" });
}

function isEmptyOrMissing(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

function buildTokens(projectName: string): TokenTable {
  return { PROJECT_NAME: projectName, YEAR: String(new Date().getFullYear()) };
}

function formatCounts(counts: CapCounts): string {
  return `${counts.agents} agents, ${counts.skills} skills, ${counts.hooks} hooks, ${counts.workflows} workflows, ${counts.scripts} scripts`;
}

/** The post-`--pack`-install caps summary line(s) printed to fresh-mode's console output. */
export function formatCapsSummary(
  baseline: CapCounts,
  installed: { name: string; budget: CapCounts }[],
): string {
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
  return lines.join("\n");
}

function runFresh(options: CliOptions): void {
  if (!isEmptyOrMissing(options.targetDir) && !options.force) {
    throw new Error(
      `${options.targetDir} already exists and is not empty (pass --force to overwrite, or --adopt to survey it instead)`,
    );
  }

  mkdirSync(options.targetDir, { recursive: true });

  const tokens = buildTokens(options.projectName);

  const result = emitTemplate(templatesCoreDir(), options.targetDir, tokens);
  console.log(
    `wrote ${result.filesWritten.length} files to ${options.targetDir}`,
  );

  const installedPacks: { name: string; budget: CapCounts }[] = [];
  for (const name of options.packs) {
    const pack = loadPack(name);
    if (!pack.manifest.modes.includes("fresh")) {
      throw new Error(
        `pack "${name}" does not support fresh mode (modes: ${pack.manifest.modes.join(", ")})`,
      );
    }
    const packResult = installPack(pack, options.targetDir, tokens);
    console.log(
      `installed pack "${name}" (${packResult.filesWritten.length} files)`,
    );
    installedPacks.push({ name, budget: packResult.budget });
  }
  if (installedPacks.length > 0) {
    console.log(
      formatCapsSummary(countBaselineCaps(templatesCoreDir()), installedPacks),
    );
  }

  const pluginResult = installCustomizeSkill(options.targetDir);
  console.log(
    `installed the /customize skill (${pluginResult.filesWritten.length} files)`,
  );

  gitInit(options.targetDir);
  console.log("initialized git repository");

  if (!options.skipInstall) {
    runInstall(options.targetDir);
    console.log("installed dependencies");
  }

  console.log(`\n✓ ${options.projectName} is ready at ${options.targetDir}`);
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
 * Surveys an already-established project and writes `.groundwork/` --
 * `inventory.json` and `adoption-report.md`. Never touches a project file:
 * the one addition is a purely-additive, collision-guarded copy of the
 * `/customize` skill (see `installCustomizeSkillGuarded`), so the report
 * can point straight at a working next step. Every pack under
 * `templates/packs/` is surveyed (`main` rejects `--pack` in this mode, see
 * `assertAdoptUsage`) and staged, unapplied, at `.groundwork/packs/<name>/`.
 */
function runAdopt(options: CliOptions, detection: ModeDetection): void {
  console.log(`adopt mode: ${detection.signal}`);

  const survey = surveyProject(options.targetDir);
  const templateRoot = templatesCoreDir();
  const tokens = buildTokens(options.projectName);
  const conflicts = planConflicts(templateRoot, options.targetDir, tokens);

  const groundworkDir = join(options.targetDir, ".groundwork");

  const packs: PackSurvey[] = listPackNames().map((name) => {
    const pack = loadPack(name);
    const fileConflicts = planConflicts(
      pack.filesDir,
      options.targetDir,
      tokens,
    );
    const wiringObservations = observeWiring(options.targetDir, pack.manifest);
    stagePackFiles(pack, groundworkDir);
    return {
      name: pack.manifest.name,
      modes: pack.manifest.modes,
      budget: pack.manifest.budget,
      fileConflicts,
      wiring: pack.manifest.wiring,
      wiringObservations,
      adoptNotes: pack.manifest.adoptNotes,
    };
  });

  const inventory = buildInventory({
    detection,
    templateRoot,
    targetDir: options.targetDir,
    survey,
    conflicts,
    packs,
    harnessGrade: gradeHarness(options.targetDir),
    toolchainGrade: gradeToolchain(options.targetDir),
  });

  const inventoryPath = writeInventory(inventory, groundworkDir);

  const reportPath = join(groundworkDir, "adoption-report.md");
  writeFileSync(reportPath, renderReport(inventory));

  console.log(`wrote ${relative(options.targetDir, inventoryPath)}`);
  console.log(`wrote ${relative(options.targetDir, reportPath)}`);
  if (packs.length > 0) {
    console.log(
      `staged ${packs.length} pack(s) at .groundwork/packs/ for /customize`,
    );
  }

  const pluginResult = installCustomizeSkillGuarded(options.targetDir);
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
  }

  console.log(`\n✓ adoption report ready at ${reportPath}`);
  console.log("Next: open this project in Claude Code and run /customize.");
}

export function main(argv: string[]): void {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.version) {
    console.log(resolveCliVersion());
    return;
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
    return;
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
    runFresh(options);
  }
}
