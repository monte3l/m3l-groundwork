// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Renders a thrown value and its full `cause` chain for the terminal --
 * what `bin/m3l-groundwork.mjs` prints instead of a bare `error.message`,
 * which would silently drop every chained cause.
 */

/** Rendered in place of a value that cannot be read or stringified (a throwing getter, a null-prototype object, a `Symbol` message, a revoked Proxy). */
const UNPRINTABLE = "[unprintable value]";

/** Rendered in place of an object already printed elsewhere in the output (not an ancestor, so not a cycle). */
const SEE_ABOVE = "(see above)";

/**
 * Most links followed along any one branch -- printed and suppressed links
 * alike -- before that branch ends with a `...` line.
 */
const MAX_DEPTH = 32;

/** Most `errors` members printed per parent before the rest collapse into one `... and N more` line; the `cause` sits outside this cap. */
const MAX_CHILDREN = 32;

/** Shortest cause message that is suppressed merely for appearing inside its parent's message. */
const MIN_SUBSTRING_LENGTH = 8;

/**
 * Stands in for a child whose `cause`/`errors` accessor threw. A fresh
 * instance per occurrence, so two unreadable children are never mistaken
 * for one repeated value.
 */
class Unreadable {}

/** A value classified once, so an accessor or Proxy trap answering differently on a later read cannot change the verdict. */
type Inspected =
  | { readonly kind: "aggregate"; readonly value: AggregateError }
  | { readonly kind: "error"; readonly value: Error }
  | { readonly kind: "other"; readonly value: unknown }
  | { readonly kind: "unreadable" };

/** Classifies `value`; an `instanceof` check that throws (a Proxy's `getPrototypeOf` trap, a revoked Proxy) makes it unreadable. */
function inspect(value: unknown): Inspected {
  try {
    if (value instanceof Unreadable) {
      return { kind: "unreadable" };
    }
    if (value instanceof AggregateError) {
      return { kind: "aggregate", value };
    }
    if (value instanceof Error) {
      return { kind: "error", value };
    }
    return { kind: "other", value };
  } catch {
    // The formatter runs while reporting another failure; a value that
    // cannot even be classified must not replace that report with its own.
    return { kind: "unreadable" };
  }
}

/** The value's own message (unindented, possibly multi-line), or {@link UNPRINTABLE} when reading or stringifying it fails. */
function messageOf(node: Inspected): string {
  try {
    let raw: unknown;
    switch (node.kind) {
      case "unreadable":
        return UNPRINTABLE;
      case "aggregate":
      case "error":
        // Read once: an accessor may answer differently on every read.
        raw = node.value.message;
        break;
      case "other":
        raw = node.value;
        break;
      default: {
        const exhaustive: never = node;
        return String(exhaustive);
      }
    }
    // String(symbol) would succeed, but a Symbol is not a message.
    return typeof raw === "symbol" ? UNPRINTABLE : String(raw);
  } catch {
    // Same rationale as inspect(): never let the report itself throw.
    return UNPRINTABLE;
  }
}

/** `Array.isArray`, narrowing to `unknown[]` rather than `any[]`. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether `value` has an identity worth tracking: only an object or a function can repeat or form a cycle. */
function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

/** The values a node chains to -- its `cause` first, then at most {@link MAX_CHILDREN} `errors` members -- and how many members were left out. */
interface Children {
  readonly kept: unknown[];
  readonly omitted: number;
}

/**
 * The values a node chains to: its `cause` (when set), then an
 * `AggregateError`'s `errors` (when really an array), capped at
 * {@link MAX_CHILDREN} members. The cause is reserved outside that cap, so
 * no number of members can hide it. An accessor that throws yields an
 * {@link Unreadable} child in its place.
 */
function childrenOf(node: Inspected): Children {
  if (node.kind !== "aggregate" && node.kind !== "error") {
    return { kept: [], omitted: 0 };
  }
  const kept: unknown[] = [];
  let omitted = 0;
  try {
    const cause: unknown = node.value.cause;
    if (cause !== undefined) {
      kept.push(cause);
    }
  } catch {
    kept.push(new Unreadable());
  }
  if (node.kind === "aggregate") {
    try {
      const errors: unknown = node.value.errors;
      if (isArray(errors)) {
        // Read only the entries that can be printed; a huge array is
        // counted by its length, never walked.
        const length = errors.length;
        const take = Math.min(length, MAX_CHILDREN);
        for (let i = 0; i < take; i++) {
          kept.push(errors[i]);
        }
        omitted = length - take;
      }
    } catch {
      kept.push(new Unreadable());
    }
  }
  return { kept, omitted };
}

/** Whether `message` adds nothing to `parentMessage` and need not be printed again. */
function isRedundant(message: string, parentMessage: string): boolean {
  if (message.trim() === "") {
    // Every string "includes" the empty string, and an all-whitespace
    // message would "equal" any other one after trim().
    return false;
  }
  return (
    message.trim() === parentMessage.trim() ||
    (message.length >= MIN_SUBSTRING_LENGTH && parentMessage.includes(message))
  );
}

/** One link of the path from the top value down to the node being visited. */
interface Ancestor {
  readonly value: unknown;
  readonly parent: Ancestor | undefined;
}

/** Whether `value` already appears on the `ancestors` path -- a genuine cycle. The path is at most {@link MAX_DEPTH} + 1 long. */
function isAncestor(value: unknown, ancestors: Ancestor | undefined): boolean {
  for (let link = ancestors; link !== undefined; link = link.parent) {
    if (link.value === value) {
      return true;
    }
  }
  return false;
}

/** Fields every pending visit carries. */
interface VisitBase {
  /** Indent level: grows only on a printed link. */
  readonly depth: number;
  /** Links followed from the top: grows on every link, printed or suppressed. */
  readonly steps: number;
  /** Shared by one parent's visits, so a cut emits one `...` line, not one per sibling. */
  readonly cut: { done: boolean };
}

/** A pending child, or the trailing `... and N more` marker of a parent with more than {@link MAX_CHILDREN} `errors` members (its `cause` is not counted). */
type Visit =
  | (VisitBase & {
      readonly kind: "child";
      readonly value: unknown;
      /** The nearest printed ancestor's message, compared against for suppression. */
      readonly parentMessage: string;
      /** The path from the top value down to (and including) this child's parent. */
      readonly ancestors: Ancestor;
    })
  | (VisitBase & { readonly kind: "more"; readonly omitted: number });

/** Pushes `node`'s child visits onto `stack`, reversed so they pop in their original order, the `... and N more` marker last. */
function pushVisits(
  stack: Visit[],
  node: Inspected,
  parentMessage: string,
  depth: number,
  steps: number,
  ancestors: Ancestor,
): void {
  const cut = { done: false };
  const { kept, omitted } = childrenOf(node);
  if (omitted > 0) {
    stack.push({ kind: "more", omitted, depth, steps, cut });
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    stack.push({
      kind: "child",
      value: kept[i],
      parentMessage,
      depth,
      steps,
      cut,
      ancestors,
    });
  }
}

/**
 * `message` as lines (split on `\n` or `\r\n`, trailing empty lines dropped),
 * the first prefixed with `head`, every further line indented one level past
 * `depth` and marked `| ` -- a bare `|` when the line is empty -- so no
 * continuation line can ever equal a real `caused by:` line.
 */
function messageLines(message: string, depth: number, head: string): string[] {
  const [first = "", ...rest] = message.split(/\r?\n/);
  while (rest.length > 0 && rest[rest.length - 1] === "") {
    rest.pop();
  }
  const continuation = `${"  ".repeat(depth + 1)}|`;
  return [
    `${head}${first}`,
    ...rest.map((line) =>
      line === "" ? continuation : `${continuation} ${line}`,
    ),
  ];
}

/** `message` as a `caused by:` line at `depth`, every further line indented one level deeper and marked `| `. */
function causedByLines(message: string, depth: number): string[] {
  return messageLines(message, depth, `${"  ".repeat(depth)}caused by: `);
}

/**
 * Formats `error` as a multi-line string: its own message on the first line
 * (any further line of it indented two spaces), then one
 * `caused by: <message>` line per chained cause, indented two more spaces
 * per depth; any further line of a cause's message is indented two spaces
 * past its own `caused by:` line. Every such continuation line is marked
 * `| ` after its indent (an empty one prints a bare `|`), so no message line
 * can pass for a real `caused by:` line. Messages split on `\n` or `\r\n`;
 * trailing empty lines are dropped. An `AggregateError`'s `errors` are each listed as a
 * `caused by:` line at the next depth (after its own `cause`, if any); an
 * `errors` property that is not an array is ignored. At most 32 `errors`
 * members are printed per parent; the rest collapse into one
 * `... and N more` line at the children's indent. A `cause` never counts
 * against that cap, so it is always printed.
 *
 * A message is an `Error`'s `message`, otherwise `String(value)`; it renders
 * as `[unprintable value]` when stringifying throws, when it is a `Symbol`,
 * when the `message`, `cause` or `errors` accessor itself throws, or when the
 * value cannot even be classified (a Proxy whose `getPrototypeOf` trap
 * throws, a revoked Proxy) -- such a value has no children.
 *
 * A cause is not printed again (its own causes still are, at the same
 * indent) when its message is not empty or whitespace-only and either equals
 * the nearest printed ancestor's message after `trim()` or is at least 8
 * characters long and contained in it.
 *
 * An object (or function) that is its own ancestor -- a cause cycle -- is
 * cut silently at the repeat; one already printed on another branch renders
 * as `caused by: (see above)`. Primitives are never deduplicated. Every
 * branch follows at most 32 links -- suppressed links count too -- and a
 * parent whose children are cut there gets exactly one `...` line, at the
 * cut point, with any sibling branches still printed after it. The walk is
 * iterative and bounded, so the function always terminates and never
 * throws, however long the chain.
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
  const top = inspect(error);
  const topMessage = messageOf(top);
  const lines: string[] = messageLines(topMessage, 0, "");
  const seen = new Set<object>();
  if (isObjectLike(error)) {
    seen.add(error);
  }
  const stack: Visit[] = [];
  pushVisits(stack, top, topMessage, 1, 1, {
    value: error,
    parent: undefined,
  });

  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    const { depth, steps, cut } = visit;
    const indent = "  ".repeat(depth);
    if (visit.kind === "child" && isAncestor(visit.value, visit.ancestors)) {
      // A cycle: everything from here on is already being printed above.
      continue;
    }
    if (steps > MAX_DEPTH) {
      if (!cut.done) {
        cut.done = true;
        lines.push(`${indent}...`);
      }
      continue;
    }
    if (visit.kind === "more") {
      lines.push(`${indent}... and ${String(visit.omitted)} more`);
      continue;
    }
    const { value, parentMessage, ancestors } = visit;
    if (isObjectLike(value)) {
      if (seen.has(value)) {
        lines.push(`${indent}caused by: ${SEE_ABOVE}`);
        continue;
      }
      seen.add(value);
    }
    const node = inspect(value);
    const message = messageOf(node);
    const path: Ancestor = { value, parent: ancestors };
    if (isRedundant(message, parentMessage)) {
      // Already printed as part of the parent's message.
      pushVisits(stack, node, parentMessage, depth, steps + 1, path);
      continue;
    }
    lines.push(...causedByLines(message, depth));
    pushVisits(stack, node, message, depth + 1, steps + 1, path);
  }

  return lines.join("\n");
}
