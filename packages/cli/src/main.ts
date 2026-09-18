/**
 * Entry point: `m3l-groundwork <target-dir> [options]`. No prompts, no
 * interactivity, no network call beyond the package install -- this must
 * work on a plane against a warm pnpm store.
 *
 * Two modes, auto-detected from the target directory (`--adopt`/`--fresh`
 * force either): **fresh** writes the baseline into an empty directory, as
 * before. **adopt** surveys an already-established project and writes only
 * a report -- see `mode.ts`, `survey/survey.ts`, `conflicts.ts`, and
 * `report.ts`. Adopt mode never touches a project file; see `runAdopt`.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { emitTemplate } from "./emit.js";
import {
  installCustomizeSkill,
  installCustomizeSkillGuarded,
} from "./plugin.js";
import { gitInit, runInstall } from "./git.js";
import { detectMode, resolveMode } from "./mode.js";
import { surveyProject } from "./survey/survey.js";
import { planConflicts } from "./conflicts.js";
import {
  buildInventory,
  resolveCliVersion,
  writeInventory,
} from "./inventory.js";
import { renderReport } from "./report.js";
import type { TokenTable } from "./tokens.js";
import type { ModeDetection } from "./mode.js";

export interface CliOptions {
  targetDir: string;
  projectName: string;
  skipInstall: boolean;
  force: boolean;
  adopt: boolean;
  fresh: boolean;
  help: boolean;
  version: boolean;
}

const USAGE = [
  "usage: m3l-groundwork <target-dir> [options]",
  "",
  "  --name <project-name>   Override the project name (default: the target directory's basename)",
  "  --skip-install          Skip the final `pnpm install` (fresh mode only)",
  "  --force                 Overwrite a non-empty target directory (fresh mode only)",
  "  --adopt                 Force adopt mode, even if the target looks empty",
  "  --fresh                 Force fresh-bootstrap mode, even if the target looks pre-existing",
  "  --help                  Print this message",
  "  --version               Print the CLI's version",
  "",
  "With no --adopt/--fresh override, the target directory is inspected: an",
  "empty or missing directory bootstraps fresh; a directory that already",
  "looks like a project (package.json, .git, or loose source files) is",
  "surveyed and adopted instead -- see .groundwork/adoption-report.md.",
].join("\n");

// --name takes a value; every other recognized flag is a bare boolean.
const VALUE_FLAGS = new Set(["--name"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

interface TokenizedArgv {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

/** Splits argv into positionals, boolean flags, and value-flag pairs -- a value-flag's value is never mistaken for a positional. */
function tokenizeArgv(argv: string[]): TokenizedArgv {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value !== undefined) {
        values.set(arg, value);
        i++;
      }
      continue;
    }

    flags.add(arg);
  }

  return { positional, flags, values };
}

/** Parses argv into structured options. Throws with USAGE on a missing target dir, unless --help/--version is present. */
export function parseArgs(argv: string[]): CliOptions {
  const { positional, flags, values } = tokenizeArgv(argv);

  const help = [...HELP_FLAGS].some((flag) => flags.has(flag));
  const version = [...VERSION_FLAGS].some((flag) => flags.has(flag));

  if (help || version) {
    return {
      targetDir: "",
      projectName: "",
      skipInstall: false,
      force: false,
      adopt: false,
      fresh: false,
      help,
      version,
    };
  }

  const targetArg = positional[0];
  if (targetArg === undefined) {
    throw new Error(USAGE);
  }

  const targetDir = resolve(targetArg);
  const explicitName = values.get("--name");

  return {
    targetDir,
    projectName: explicitName ?? basename(targetDir),
    skipInstall: flags.has("--skip-install"),
    force: flags.has("--force"),
    adopt: flags.has("--adopt"),
    fresh: flags.has("--fresh"),
    help: false,
    version: false,
  };
}

/** Resolves `templates/core` relative to this module, whether run from source or dist. */
export function templatesCoreDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "templates", "core");
}

function isEmptyOrMissing(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

function buildTokens(projectName: string): TokenTable {
  return { PROJECT_NAME: projectName, YEAR: String(new Date().getFullYear()) };
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
 * Surveys an already-established project and writes `.groundwork/` --
 * `inventory.json` and `adoption-report.md`. Never touches a project file:
 * the one addition is a purely-additive, collision-guarded copy of the
 * `/customize` skill (see `installCustomizeSkillGuarded`), so the report
 * can point straight at a working next step.
 */
function runAdopt(options: CliOptions, detection: ModeDetection): void {
  if (options.force) {
    throw new Error(
      "--force has no effect in adopt mode -- adopt mode never writes project files; run /customize to reconcile instead.",
    );
  }

  console.log(`adopt mode: ${detection.signal}`);

  const survey = surveyProject(options.targetDir);
  const templateRoot = templatesCoreDir();
  const tokens = buildTokens(options.projectName);
  const conflicts = planConflicts(templateRoot, options.targetDir, tokens);

  const inventory = buildInventory({
    detection,
    templateRoot,
    targetDir: options.targetDir,
    survey,
    conflicts,
  });

  const groundworkDir = join(options.targetDir, ".groundwork");
  const inventoryPath = writeInventory(inventory, groundworkDir);

  const reportPath = join(groundworkDir, "adoption-report.md");
  writeFileSync(reportPath, renderReport(inventory));

  console.log(`wrote ${relative(options.targetDir, inventoryPath)}`);
  console.log(`wrote ${relative(options.targetDir, reportPath)}`);

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

  const detected = detectMode(options.targetDir);
  const resolved = resolveMode(detected, {
    adopt: options.adopt,
    fresh: options.fresh,
  });

  if (resolved.mode === "adopt") {
    runAdopt(options, resolved);
  } else {
    runFresh(options);
  }
}
