// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Renders a thrown value and its full `cause` chain for the terminal --
 * what `bin/m3l-groundwork.mjs` prints instead of a bare `error.message`,
 * which would silently drop every chained cause.
 */

/** Rendered in place of a value `String()` itself throws on (a null-prototype object, a throwing `Symbol.toPrimitive`). */
const UNPRINTABLE = "[unprintable value]";

/** Deepest `caused by:` level printed; a longer chain ends with a `...` line. */
const MAX_DEPTH = 32;

/** The value's own one-line message: an `Error`'s `message`, otherwise `String(value)`, or {@link UNPRINTABLE} when that throws. */
function messageOf(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    // The formatter runs while reporting another failure; a value that
    // cannot be stringified must not replace that report with its own error.
    return UNPRINTABLE;
  }
}

/** `Array.isArray`, narrowing to `unknown[]` rather than `any[]`. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** The values a node chains to: an `AggregateError`'s `errors` (when really an array), then its `cause` (when set). */
function childrenOf(value: unknown): unknown[] {
  if (!(value instanceof Error)) {
    return [];
  }
  const errors: unknown =
    value instanceof AggregateError ? value.errors : undefined;
  const children: unknown[] = isArray(errors) ? [...errors] : [];
  if (value.cause !== undefined) {
    children.push(value.cause);
  }
  return children;
}

/**
 * Formats `error` as a multi-line string: its own message on the first line,
 * then one `caused by: <message>` line per chained cause, indented two more
 * spaces per depth. An `AggregateError`'s `errors` are each listed as a
 * `caused by:` line at the next depth (before its own `cause`, if any); an
 * `errors` property that is not an array is ignored. Non-`Error` values
 * render with `String()`, or `[unprintable value]` when that throws. A cause
 * whose message is already contained in its parent's message is not printed
 * again (its own causes still are, at the same depth). A cause cycle is cut
 * at the first repeat and a chain deeper than 32 levels ends with a `...`
 * line, so the function always terminates and never throws.
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
  const topMessage = messageOf(error);
  const lines: string[] = [topMessage];
  const seen = new Set<unknown>([error]);

  let truncated = false;

  const walk = (value: unknown, parentMessage: string, depth: number): void => {
    for (const child of childrenOf(value)) {
      if (seen.has(child)) {
        continue;
      }
      if (depth > MAX_DEPTH) {
        truncated = true;
        return;
      }
      seen.add(child);
      const message = messageOf(child);
      if (parentMessage.includes(message)) {
        // Already printed as part of the parent's message.
        walk(child, parentMessage, depth);
        continue;
      }
      lines.push(`${"  ".repeat(depth)}caused by: ${message}`);
      walk(child, message, depth + 1);
    }
  };
  walk(error, topMessage, 1);

  if (truncated) {
    lines.push(`${"  ".repeat(MAX_DEPTH + 1)}...`);
  }

  return lines.join("\n");
}
