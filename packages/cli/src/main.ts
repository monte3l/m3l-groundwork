/**
 * Phase A entry point: `m3l-groundwork <target-dir> [--name <name>]`. No
 * prompts, no interactivity, no network call beyond the package install --
 * this must work on a plane against a warm pnpm store.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { emitTemplate } from "./emit.js";
import { installCustomizeSkill } from "./plugin.js";
import { gitInit, runInstall } from "./git.js";
import type { TokenTable } from "./tokens.js";

export interface CliOptions {
  targetDir: string;
  projectName: string;
  skipInstall: boolean;
  force: boolean;
}

const USAGE =
  "usage: m3l-groundwork <target-dir> [--name <project-name>] [--skip-install] [--force]";

/** Parses argv into structured options. Throws with USAGE on a missing target dir. */
export function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const targetArg = positional[0];
  if (targetArg === undefined) {
    throw new Error(USAGE);
  }

  const targetDir = resolve(targetArg);
  const nameIndex = argv.indexOf("--name");
  const explicitName = nameIndex === -1 ? undefined : argv[nameIndex + 1];

  return {
    targetDir,
    projectName: explicitName ?? basename(targetDir),
    skipInstall: argv.includes("--skip-install"),
    force: argv.includes("--force"),
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

export function main(argv: string[]): void {
  const options = parseArgs(argv);

  if (!isEmptyOrMissing(options.targetDir) && !options.force) {
    throw new Error(
      `${options.targetDir} already exists and is not empty (pass --force to overwrite)`,
    );
  }

  mkdirSync(options.targetDir, { recursive: true });

  const tokens: TokenTable = {
    PROJECT_NAME: options.projectName,
    YEAR: String(new Date().getFullYear()),
  };

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
