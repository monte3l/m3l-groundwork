// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Renders a thrown value and its full `cause` chain for the terminal --
 * what `bin/m3l-groundwork.mjs` prints instead of a bare `error.message`,
 * which would silently drop every chained cause.
 */

/** Rendered in place of a value that cannot be read or stringified (a throwing getter, a null-prototype object, a `Symbol` message). */
const UNPRINTABLE = "[unprintable value]";

/**
 * Most links followed along any one branch -- printed and suppressed links
 * alike -- before that branch ends with a `...` line.
 */
const MAX_DEPTH = 32;

/** Shortest cause message that is suppressed merely for appearing inside its parent's message. */
const MIN_SUBSTRING_LENGTH = 8;

/**
 * Stands in for a child whose `cause`/`errors` accessor threw. A fresh
 * instance per occurrence, so two unreadable children are never mistaken
 * for one repeated value by the cycle check.
 */
class Unreadable {}

/** The value's own one-line message, or {@link UNPRINTABLE} when reading or stringifying it fails. */
function messageOf(value: unknown): string {
  try {
    if (value instanceof Unreadable) {
      return UNPRINTABLE;
    }
    // Read once: an accessor may answer differently on every read.
    const raw: unknown = value instanceof Error ? value.message : value;
    // String(symbol) would succeed, but a Symbol is not a message.
    return typeof raw === "symbol" ? UNPRINTABLE : String(raw);
  } catch {
    // The formatter runs while reporting another failure; a value that
    // cannot be read or stringified must not replace that report with its
    // own error.
    return UNPRINTABLE;
  }
}

/** `Array.isArray`, narrowing to `unknown[]` rather than `any[]`. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * The values a node chains to: an `AggregateError`'s `errors` (when really
 * an array), then its `cause` (when set). An accessor that throws yields an
 * {@link Unreadable} child in its place.
 */
function childrenOf(value: unknown): unknown[] {
  if (!(value instanceof Error)) {
    return [];
  }
  const children: unknown[] = [];
  if (value instanceof AggregateError) {
    try {
      const errors: unknown = value.errors;
      if (isArray(errors)) {
        // A loop, not push(...errors): spreading a huge array as call
        // arguments can throw a RangeError.
        for (const entry of errors) {
          children.push(entry);
        }
      }
    } catch {
      children.push(new Unreadable());
    }
  }
  try {
    const cause: unknown = value.cause;
    if (cause !== undefined) {
      children.push(cause);
    }
  } catch {
    children.push(new Unreadable());
  }
  return children;
}

/** Whether `message` adds nothing to `parentMessage` and need not be printed again. */
function isRedundant(message: string, parentMessage: string): boolean {
  if (message === "") {
    // Every string "includes" the empty string.
    return false;
  }
  return (
    message.trim() === parentMessage.trim() ||
    (message.length >= MIN_SUBSTRING_LENGTH && parentMessage.includes(message))
  );
}

/** One pending child visit in the iterative walk. */
interface Visit {
  readonly value: unknown;
  /** The nearest printed ancestor's message, compared against for suppression. */
  readonly parentMessage: string;
  /** Indent level: grows only on a printed link. */
  readonly depth: number;
  /** Links followed from the top: grows on every link, printed or suppressed. */
  readonly steps: number;
  /** Shared by one parent's children, so a cut emits one `...` line, not one per sibling. */
  readonly cut: { done: boolean };
}

/** Pushes `value`'s child visits onto `stack`, reversed so they pop in their original order. */
function pushVisits(
  stack: Visit[],
  value: unknown,
  parentMessage: string,
  depth: number,
  steps: number,
): void {
  const cut = { done: false };
  const children = childrenOf(value);
  for (let i = children.length - 1; i >= 0; i--) {
    stack.push({ value: children[i], parentMessage, depth, steps, cut });
  }
}

/**
 * Formats `error` as a multi-line string: its own message on the first line,
 * then one `caused by: <message>` line per chained cause, indented two more
 * spaces per depth. An `AggregateError`'s `errors` are each listed as a
 * `caused by:` line at the next depth (before its own `cause`, if any); an
 * `errors` property that is not an array is ignored.
 *
 * A message is an `Error`'s `message`, otherwise `String(value)`; it renders
 * as `[unprintable value]` when stringifying throws, when it is a `Symbol`,
 * or when the `message`, `cause` or `errors` accessor itself throws.
 *
 * A cause is not printed again (its own causes still are, at the same
 * indent) when its message is non-empty and either equals its parent's after
 * `trim()` or is at least 8 characters long and contained in its parent's
 * message.
 *
 * A cause cycle is cut at the first repeat. Every branch follows at most 32
 * links -- suppressed links count too -- and a branch cut there gets a `...`
 * line in place, at the cut point, with any sibling branches still printed
 * after it. The walk is iterative, so the function always terminates and
 * never throws, however long the chain.
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
  const stack: Visit[] = [];
  pushVisits(stack, error, topMessage, 1, 1);

  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    const { value, parentMessage, depth, steps, cut } = visit;
    if (seen.has(value)) {
      continue;
    }
    if (steps > MAX_DEPTH) {
      if (!cut.done) {
        cut.done = true;
        lines.push(`${"  ".repeat(depth)}...`);
      }
      continue;
    }
    seen.add(value);
    const message = messageOf(value);
    if (isRedundant(message, parentMessage)) {
      // Already printed as part of the parent's message.
      pushVisits(stack, value, parentMessage, depth, steps + 1);
      continue;
    }
    lines.push(`${"  ".repeat(depth)}caused by: ${message}`);
    pushVisits(stack, value, message, depth + 1, steps + 1);
  }

  return lines.join("\n");
}
