// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The CLI's usage text and its usage-error class, in a module of their own so
 * both `main.ts` (argument parsing, mode routing) and `add-pack.ts` (the
 * `--add-pack` run) can throw a usage error without importing each other.
 * `main.ts` re-exports {@link CliUsageError}.
 */

/**
 * The text every usage error ends with, and what `--help` prints.
 *
 * @example
 * ```ts
 * import { CliUsageError, USAGE } from "./usage.js";
 * throw new CliUsageError(`--bogus is not an option\n\n${USAGE}`);
 * ```
 */
export const USAGE: string = [
  "usage: m3l-groundwork <target-dir> [options]",
  "",
  "  --name <project-name>   Override the project name (default: the target directory's basename)",
  "  --skip-install          Skip the final `pnpm install` (fresh mode only)",
  "  --force                 Overwrite a non-empty target directory (fresh mode only)",
  "  --adopt                 Force adopt mode, even if the target looks empty",
  "  --fresh                 Force fresh-bootstrap mode, even if the target looks pre-existing",
  "  --pack <name>           Install an opt-in pack from templates/packs/ (fresh mode only; repeatable)",
  "  --add-pack <name>       Stage a pack into an already bootstrapped or adopted project,",
  "                          under .groundwork/add-pack/<name>/, for /customize add-pack",
  "                          to install (repeatable; writes nothing else)",
  "  --reinstall             With --add-pack: stage a pack the project already has",
  "  --list-packs [<dir>]    Print every available pack and exit; with a directory,",
  "                          also report which packs that project has (read-only)",
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
  "",
  "--add-pack skips mode detection and cannot be combined with --pack,",
  "--adopt, --fresh, --force or --skip-install; with it, --name only",
  "proposes the PROJECT_NAME token (default: package.json's name).",
].join("\n");

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
