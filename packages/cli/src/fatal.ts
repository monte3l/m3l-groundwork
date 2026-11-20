// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The CLI's top-level catch handler, `bin/m3l-groundwork.mjs`'s last line of
 * defence: whatever was thrown, and whatever fails while reporting it, the
 * process ends with an exit code set and never with an uncaught throw.
 */
import { EXIT_CODES, type ExitCode } from "./exit-codes.js";
import { escapeControls, formatFatalError } from "./format-error.js";

/** Printed when neither the formatted report nor the raw stack could be printed on the raw channel. */
const LAST_RESORT = "[unprintable error]";

/**
 * `error.stack` when readable, otherwise `String(error)`, control-escaped by
 * {@link escapeControls} -- the fallback text when printing the formatted
 * chain failed.
 */
function rawText(error: unknown): string {
  // Read `stack` once, and only off an object; a throwing getter or Proxy
  // trap propagates to the caller's own fallback.
  const stack: unknown =
    typeof error === "object" && error !== null && "stack" in error
      ? error.stack
      : undefined;
  return escapeControls(String(stack ?? error));
}

/** The non-zero {@link ExitCode}s -- the only codes a fatal path may end with. */
type FatalExitCode = Exclude<ExitCode, typeof EXIT_CODES.ok>;

/** Every value in {@link EXIT_CODES} except `ok`, for the runtime check on `classify`'s result. */
const FATAL_CODES: readonly unknown[] = Object.values(EXIT_CODES).filter(
  (code) => code !== EXIT_CODES.ok,
);

/**
 * Narrows `value` to a {@link FatalExitCode}: one of `EXIT_CODES`' values
 * other than `ok`, compared with `includes` (so `NaN` never matches).
 */
function isFatalExitCode(value: unknown): value is FatalExitCode {
  return FATAL_CODES.includes(value);
}

/**
 * Reports a fatal `error`: sets the exit code first -- whatever
 * `classify(error)` returns when that is a non-zero {@link ExitCode}
 * (`./exit-codes.ts`), or `EXIT_CODES.runtime` (1) when `classify` throws or
 * returns anything else (`0`, `undefined`, `NaN`, an out-of-range number, a
 * non-number) -- then prints the
 * report through `io.print`. For any code other than `EXIT_CODES.runtime`
 * (a usage error, say) the report is exactly `formatErrorChain(error)`. For
 * a runtime failure it is
 * `formatFatalError(error, { withName: true, withStack: debug })` (both in
 * `./format-error.ts`): the same chain, its top line prefixed `<name>: `
 * when `error` is an `Error` with a readable, non-blank `name` other than
 * `Error` and a non-blank message (`TypeError: boom`), and, when `debug` is
 * set, the stack frames appended as `formatFatalError` describes
 * (control-escaped, header dropped, capped at its `MAX_STACK_LINES`). Only
 * the top error's own stack is printed: a `cause`'s stack is deliberately
 * omitted, since the chain already names every cause. If that print
 * throws, the fallbacks never touch `io.print` again (it is the channel
 * that just failed -- in the CLI, the one that paints colour), so `print`
 * is called exactly once: `io.printRaw` prints the same report, so the
 * cause chain (and any name prefix and stack) survives a failing `print`;
 * if that throws, `io.printRaw` prints `String(error.stack ?? error)`,
 * control-escaped the same way the chain is (`escapeControls` in
 * `./format-error.ts`); if that throws, `io.printRaw` prints
 * `[unprintable error]`; if even that throws, gives up silently, the exit
 * code already set. Never throws. A `setExitCode` that throws is swallowed
 * and not retried -- the report is still attempted -- but it is not
 * otherwise handled: assigning Node's `process.exitCode` cannot throw, so
 * the CLI never hits that case. Returns the code it set (1-4) -- 1 after a
 * throwing or invalid classifier -- whether or not any print succeeded, so
 * a caller (the bin script's `--json` envelope) can reuse it without
 * classifying `error` a second time.
 *
 * @param error - The value the CLI's `main()` threw.
 * @param io - Where the exit code and the report go: `print` for the
 * formatted chain, `printRaw` -- a plain write with nothing in it that can
 * fail the way `print` did -- for all three fallbacks.
 * @param classify - The non-zero exit code `error` maps to
 * (`.claude/rules/headless-mode.md` lists them); in the CLI,
 * `EXIT_CODES.usage` for a `CliUsageError` and `EXIT_CODES.runtime` for
 * anything else. Its result is checked at runtime: anything other than 1,
 * 2, 3 or 4 is treated exactly like a throwing classifier -- exit code 1
 * and the runtime report.
 * @param debug - Append the top error's own stack (never a cause's) to a
 * runtime failure's report (never to any other code's); defaults to `false`.
 * The CLI sets it when `M3L_DEBUG` is non-empty.
 * @returns The non-zero exit code passed to `io.setExitCode`.
 *
 * @example
 * ```ts
 * import { EXIT_CODES } from "./exit-codes.js";
 * import { CliUsageError, main } from "./main.js";
 * import { handleFatal } from "./fatal.js";
 *
 * try {
 *   main(process.argv.slice(2));
 * } catch (error) {
 *   const code = handleFatal(
 *     error,
 *     {
 *       setExitCode: (code) => {
 *         process.exitCode = code;
 *       },
 *       print: (text) => {
 *         console.error(text);
 *       },
 *       printRaw: (text) => {
 *         console.error(text);
 *       },
 *     },
 *     (e) =>
 *       e instanceof CliUsageError ? EXIT_CODES.usage : EXIT_CODES.runtime,
 *     (process.env["M3L_DEBUG"] ?? "") !== "",
 *   );
 *   // `code` (1-4) is the value process.exitCode now holds.
 *   if (code === EXIT_CODES.usage) console.error("see --help");
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
  classify: (error: unknown) => FatalExitCode,
  debug = false,
): FatalExitCode {
  let code: FatalExitCode = EXIT_CODES.runtime;
  try {
    // The type already excludes 0, but a JS caller (the bin script) or a
    // cast can still hand back anything: check before trusting it.
    const classified: unknown = classify(error);
    if (isFatalExitCode(classified)) code = classified;
  } catch {
    // A classifier that throws cannot vouch for any other code: a runtime failure.
  }
  try {
    io.setExitCode(code);
  } catch {
    // Nothing else can record the code; still try to print the report below.
  }
  const runtime = code === EXIT_CODES.runtime;
  const options = { withName: runtime, withStack: runtime && debug };
  try {
    io.print(formatFatalError(error, options));
    return code;
  } catch {
    // Fall through to the same report, on the raw channel.
  }
  try {
    io.printRaw(formatFatalError(error, options));
    return code;
  } catch {
    // Fall through to the raw stack.
  }
  try {
    io.printRaw(rawText(error));
    return code;
  } catch {
    // Fall through to the fixed placeholder.
  }
  try {
    io.printRaw(LAST_RESORT);
  } catch {
    // stderr itself is unusable: the exit code set above is all that is left.
  }
  return code;
}
