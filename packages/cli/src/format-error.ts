// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Renders a thrown value and its full `cause` chain for the terminal --
 * what `bin/m3l-groundwork.mjs` prints instead of a bare `error.message`,
 * which would silently drop every chained cause.
 */

/** The value's own one-line message: an `Error`'s `message`, otherwise `String(value)`. */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** The values a node chains to: an `AggregateError`'s `errors`, then its `cause` (when set). */
function childrenOf(value: unknown): unknown[] {
  if (!(value instanceof Error)) {
    return [];
  }
  const children: unknown[] =
    value instanceof AggregateError ? [...(value.errors as unknown[])] : [];
  if (value.cause !== undefined) {
    children.push(value.cause);
  }
  return children;
}

/**
 * Formats `error` as a multi-line string: its own message on the first line,
 * then one `caused by: <message>` line per chained cause, indented two more
 * spaces per depth. An `AggregateError`'s `errors` are each listed as a
 * `caused by:` line at the next depth (before its own `cause`, if any).
 * Non-`Error` values render with `String()`. A cause cycle is cut at the
 * first repeat, so the function always terminates.
 *
 * @example
 * ```ts
 * import { formatErrorChain } from "./format-error.js";
 *
 * const error = new Error("staging failed", { cause: new Error("ENOSPC") });
 * formatErrorChain(error);
 * // "staging failed\n  caused by: ENOSPC"
 * ```
 */
export function formatErrorChain(error: unknown): string {
  const lines: string[] = [messageOf(error)];
  const seen = new Set<unknown>([error]);

  const walk = (value: unknown, depth: number): void => {
    for (const child of childrenOf(value)) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      lines.push(`${"  ".repeat(depth)}caused by: ${messageOf(child)}`);
      walk(child, depth + 1);
    }
  };
  walk(error, 1);

  return lines.join("\n");
}
