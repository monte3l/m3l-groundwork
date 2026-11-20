// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The CLI's process exit codes, in one table. The contract for what each code
 * means lives in `.claude/rules/headless-mode.md` ("Exit codes"); only these
 * five values are part of it.
 */

/**
 * Every exit code the CLI can end with, keyed by outcome; what each one
 * means is specified in `.claude/rules/headless-mode.md` ("Exit codes").
 *
 * @example
 * ```ts
 * import { EXIT_CODES } from "./exit-codes.js";
 *
 * process.exitCode = EXIT_CODES.usage; // 2
 * ```
 */
export const EXIT_CODES = {
  ok: 0,
  runtime: 1,
  usage: 2,
  pending: 3,
  drift: 4,
} as const;

/**
 * One of the values in {@link EXIT_CODES}: `0 | 1 | 2 | 3 | 4`.
 *
 * @example
 * ```ts
 * import { EXIT_CODES, type ExitCode } from "./exit-codes.js";
 *
 * const code: ExitCode = EXIT_CODES.drift;
 * ```
 */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
