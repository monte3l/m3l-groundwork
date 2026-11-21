// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The CLI's usage error, in a module of its own so both `main.ts` (which
 * re-exports it) and the headless modules it dispatches to can throw it
 * without importing each other.
 */

/**
 * Thrown for a bad invocation (unknown flag, missing target dir, missing flag
 * value, contradictory mode flags, an unusable `--apply` answers file) --
 * distinguished from a runtime error so the CLI exits 2, not 1.
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
