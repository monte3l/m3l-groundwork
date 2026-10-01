// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The CLI's top-level catch handler, `bin/m3l-groundwork.mjs`'s last line of
 * defence: whatever was thrown, and whatever fails while reporting it, the
 * process ends with an exit code set and never with an uncaught throw.
 */
import { formatErrorChain } from "./format-error.js";

/** Printed when neither the formatted chain nor the raw stack could be printed. */
const LAST_RESORT = "[unprintable error]";

/** `error.stack` when readable, otherwise `String(error)` -- the fallback text when printing the formatted chain failed. */
function rawText(error: unknown): string {
  // Read `stack` once, and only off an object; a throwing getter or Proxy
  // trap propagates to the caller's own fallback.
  const stack: unknown =
    typeof error === "object" && error !== null && "stack" in error
      ? error.stack
      : undefined;
  return String(stack ?? error);
}

/**
 * Reports a fatal `error`: sets the exit code first -- 2 when
 * `isUsageError(error)` says it is a usage error, 1 otherwise, including
 * when `isUsageError` itself throws -- then prints `formatErrorChain(error)`
 * through `io.print`. If that print throws, the fallbacks never touch
 * `io.print` again (it is the channel that just failed -- in the CLI, the
 * one that paints colour): `io.printRaw` prints `String(error.stack ?? error)`
 * instead; if that throws, `io.printRaw` prints `[unprintable error]`; if
 * even that throws, gives up silently, the exit code already set. Never
 * throws. A `setExitCode` that throws is swallowed and not retried -- the
 * report is still attempted -- but it is not otherwise handled: assigning
 * Node's `process.exitCode` cannot throw, so the CLI never hits that case.
 *
 * @param error - The value the CLI's `main()` threw.
 * @param io - Where the exit code and the report go: `print` for the formatted chain, `printRaw` -- a plain write with nothing in it that can fail the way `print` did -- for both fallbacks.
 * @param isUsageError - Whether `error` is a bad invocation rather than a runtime failure.
 *
 * @example
 * ```ts
 * import { CliUsageError, main } from "./main.js";
 * import { handleFatal } from "./fatal.js";
 *
 * try {
 *   main(process.argv.slice(2));
 * } catch (error) {
 *   handleFatal(
 *     error,
 *     {
 *       setExitCode: (code) => {
 *         process.exitCode = code;
 *       },
 *       print: (text) => {
 *         console.error(text);
 *       },
 *       printRaw: (text) => {
 *         process.stderr.write(`${text}\n`);
 *       },
 *     },
 *     (e) => e instanceof CliUsageError,
 *   );
 * }
 * ```
 */
export function handleFatal(
  error: unknown,
  io: {
    setExitCode(code: number): void;
    print(text: string): void;
    printRaw(text: string): void;
  },
  isUsageError: (error: unknown) => boolean,
): void {
  let code = 1;
  try {
    code = isUsageError(error) ? 2 : 1;
  } catch {
    // A classifier that throws cannot vouch for a usage error: a runtime failure.
  }
  try {
    io.setExitCode(code);
  } catch {
    // Nothing else can record the code; still try to print the report below.
  }
  try {
    io.print(formatErrorChain(error));
    return;
  } catch {
    // Fall through to the raw stack, on the raw channel.
  }
  try {
    io.printRaw(rawText(error));
    return;
  } catch {
    // Fall through to the fixed placeholder.
  }
  try {
    io.printRaw(LAST_RESORT);
  } catch {
    // stderr itself is unusable: the exit code set above is all that is left.
  }
}
