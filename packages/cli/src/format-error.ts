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

/** Rendered as the top line in place of a blank message when there is no `Error` name to show instead. */
const EMPTY_MESSAGE = "(empty message)";

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

/** Code points that end a line: LF, VT, FF, CR (a CR immediately followed by LF is one break), NEL, LS, PS. */
const LINE_BREAKS: ReadonlySet<number> = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029,
]);

/** `text` split on every {@link LINE_BREAKS} member, `\r\n` counting as one break; empty lines are kept. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!LINE_BREAKS.has(code)) {
      continue;
    }
    lines.push(text.slice(start, i));
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) {
      i++;
    }
    start = i + 1;
  }
  lines.push(text.slice(start));
  return lines;
}

/**
 * Whether code unit `code` is a bidi embedding/override (U+202A-U+202E: LRE,
 * RLE, PDF, LRO, RLO) or isolate (U+2066-U+2069: LRI, RLI, FSI, PDI) control
 * -- the Trojan Source class (CVE-2021-42574), which can make a terminal
 * display text in an order other than its bytes.
 */
function isBidiControl(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Whether code unit `code` is escaped: a C0 control other than TAB
 * (U+0000-U+001F except U+0009), DEL (U+007F), a C1 control other than
 * NEL (U+0080-U+009F except U+0085), or an {@link isBidiControl} code unit.
 * Every one of these is a single UTF-16 code unit, so a surrogate half never
 * matches.
 */
function isEscapedControl(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09) ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f && code !== 0x85) ||
    isBidiControl(code)
  );
}

/**
 * `line` with every {@link isEscapedControl} code unit replaced by a literal
 * escape in lowercase hex: `\uNNNN` (four digits) for a bidi control,
 * `\xNN` (two digits) for every other one.
 */
function escapeLine(line: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (isEscapedControl(code)) {
      const hex = code.toString(16);
      const escape = isBidiControl(code)
        ? `\\u${hex.padStart(4, "0")}`
        : `\\x${hex.padStart(2, "0")}`;
      out += `${line.slice(start, i)}${escape}`;
      start = i + 1;
    }
  }
  return out + line.slice(start);
}

/**
 * Makes `text` safe to write to a terminal: every line break it contains
 * (`\r\n`, `\n`, a lone `\r`, `\v`, `\f`, U+0085, U+2028, U+2029) becomes a
 * plain `\n`, and every other C0 control except TAB (U+0000-U+001F except
 * U+0009), DEL (U+007F) and every C1 control except NEL (U+0080-U+009F
 * except U+0085) is replaced by the literal text `\xNN`, lowercase two-digit
 * hex -- so an ESC renders as `\x1b` and cannot start an escape sequence.
 * Every bidi embedding/override and isolate control (U+202A-U+202E,
 * U+2066-U+2069) is replaced by the literal text `\uNNNN`, lowercase
 * four-digit hex -- so an RLO renders as `\u202e` and cannot reorder what
 * the terminal displays. TAB and every other character pass through
 * unchanged.
 *
 * @example
 * ```ts
 * import { escapeControls } from "./format-error.js";
 *
 * escapeControls("bad\u001b[2J\rline two"); // "bad\\x1b[2J\nline two"
 * escapeControls("bad\u202eexe.txt"); // "bad\\u202eexe.txt"
 * ```
 */
export function escapeControls(text: string): string {
  return splitLines(text).map(escapeLine).join("\n");
}

/** Whether `message` would render as nothing but blank lines. */
function isBlank(message: string): boolean {
  return splitLines(message).every((line) => line.trim() === "");
}

/** An `Error`'s `name` when it is a readable, non-blank string (read once, safely), otherwise `undefined`. */
function readableName(node: Inspected): string | undefined {
  if (node.kind === "aggregate" || node.kind === "error") {
    try {
      const name: unknown = node.value.name;
      if (typeof name === "string" && !isBlank(name)) {
        return name;
      }
    } catch {
      // Same rationale as inspect(): never let the report itself throw.
    }
  }
  return undefined;
}

/** What the top line shows in place of a blank message: an `Error`'s {@link readableName}, otherwise `(empty message)`. */
function blankLabel(node: Inspected): string {
  return readableName(node) ?? EMPTY_MESSAGE;
}

/**
 * The `Name: ` prefix {@link formatFatalError} gives the top line: an
 * `Error`'s {@link readableName} other than the generic `Error` (which adds
 * nothing), every line break in it rendered as a literal `\n` and every
 * other control escaped as {@link escapeControls} describes, so the prefix
 * stays on one line; `""` when there is no such name.
 */
function namePrefix(node: Inspected): string {
  const name = readableName(node);
  if (name === undefined || name === "Error") {
    return "";
  }
  return `${splitLines(name).map(escapeLine).join("\\n")}: `;
}

/** Most `stack` lines {@link formatFatalError} prints before the rest collapse into one `... and N more` line. */
const MAX_STACK_LINES = 50;

/** Whether `line` looks like a V8 stack frame (`    at ...`). */
function isFrameLine(line: string): boolean {
  return /^\s*at /.test(line);
}

/**
 * The header V8 puts on an `Error`'s `stack`, built the way
 * `Error.prototype.toString` builds it (`Name: message`, just the name when
 * the message is empty, just the message when the name is), or `undefined`
 * when `name` or `message` cannot be read or is neither a string nor
 * `undefined`.
 */
function stackHeader(error: Error): string | undefined {
  let rawName: unknown;
  let rawMessage: unknown;
  try {
    rawName = error.name;
    rawMessage = error.message;
  } catch {
    // Same rationale as inspect(): never let the report itself throw.
    return undefined;
  }
  const name = rawName === undefined ? "Error" : rawName;
  const message = rawMessage === undefined ? "" : rawMessage;
  if (typeof name !== "string" || typeof message !== "string") {
    return undefined;
  }
  if (name === "") {
    return message;
  }
  return message === "" ? name : `${name}: ${message}`;
}

/**
 * `raw` (a stack's lines) without its header: as many leading lines as
 * {@link stackHeader} occupies when the stack starts with exactly those
 * lines -- so a message line shaped like a frame is still dropped --
 * otherwise every line before the first {@link isFrameLine}, or none when
 * there is no frame line.
 */
function withoutHeader(raw: readonly string[], error: Error): string[] {
  const header = stackHeader(error);
  if (header !== undefined) {
    const headerLines = splitLines(header);
    if (headerLines.every((line, i) => raw[i] === line)) {
      return raw.slice(headerLines.length);
    }
  }
  const firstFrame = raw.findIndex(isFrameLine);
  return firstFrame === -1 ? [...raw] : raw.slice(firstFrame);
}

/**
 * The top value's `stack` as printable lines: read once, only off an
 * `Error`, and only when it is a string (a throwing getter or a non-string
 * yields none). V8's `Name: message` header, already printed as the chain's
 * top line, is dropped by position (see {@link withoutHeader}), falling
 * back to dropping the lines before the first `at ` frame when the stack
 * does not start with that header; a stack with neither is kept whole.
 * Trailing empty lines are dropped, every line is control-escaped like a
 * message, and at most {@link MAX_STACK_LINES} are kept, the rest
 * collapsing into one `    ... and N more` line.
 */
function stackLines(node: Inspected): string[] {
  if (node.kind !== "aggregate" && node.kind !== "error") {
    return [];
  }
  let stack: unknown;
  try {
    stack = node.value.stack;
  } catch {
    // Same rationale as inspect(): never let the report itself throw.
    return [];
  }
  if (typeof stack !== "string") {
    return [];
  }
  const lines = withoutHeader(splitLines(stack), node.value).map(escapeLine);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length <= MAX_STACK_LINES) {
    return lines;
  }
  const omitted = lines.length - MAX_STACK_LINES;
  return [
    ...lines.slice(0, MAX_STACK_LINES),
    `    ... and ${String(omitted)} more`,
  ];
}

/**
 * `message` as lines (split on every line break {@link escapeControls}
 * recognizes, trailing empty lines dropped, each line control-escaped), the
 * first prefixed with `head`, every further line indented one level past
 * `depth` and marked `| ` -- a bare `|` when the line is empty -- so no
 * continuation line can ever equal a real `caused by:` line.
 */
function messageLines(message: string, depth: number, head: string): string[] {
  const [first = "", ...rest] = splitLines(message).map(escapeLine);
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
 * `| ` after its indent (an empty one prints a bare `|`), so no continuation
 * line can pass for a real `caused by:` line; the top message's first line
 * is printed unmarked (but control-escaped, below). Messages split on
 * `\r\n`, `\n`, a lone `\r`, `\v`, `\f`, U+0085, U+2028 or U+2029; trailing
 * empty lines are dropped. Every line of every message -- the top message's
 * first line, any cause at any depth, a non-`Error`'s `String(value)` -- is
 * then control-escaped exactly as {@link escapeControls} describes (every C0
 * control but TAB, DEL, every C1 control but NEL become `\xNN`; every bidi
 * control in U+202A-U+202E and U+2066-U+2069 becomes `\uNNNN`), so no
 * message can emit a terminal escape sequence. A top message that is empty
 * or whitespace-only renders as the `Error`'s `name` instead (when that is
 * a readable, non-blank string), otherwise as `(empty message)`, so the
 * first line is never blank. An `AggregateError`'s `errors` are each listed
 * as a `caused by:` line at the next depth (after its own `cause`, if any);
 * an `errors` property that is not an array is ignored. At most 32 `errors`
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
  return renderChain(error, false);
}

/**
 * Formats `error` for the CLI's fatal-error report: exactly
 * {@link formatErrorChain}'s text, with two optional additions.
 *
 * - `withName`: when `error` is an `Error` whose `name` is a readable,
 *   non-blank string other than the generic `Error`, and its message is not
 *   blank, the top line is prefixed `<name>: ` (`TypeError: boom`), the
 *   name control-escaped like a message and any line break in it rendered
 *   as a literal `\n`. A blank message already renders as the name alone,
 *   so it gets no prefix; `caused by:` lines never do.
 * - `withStack`: when `error` is an `Error` whose `stack` (read once) is a
 *   string, its lines are appended after the chain -- minus V8's
 *   `Name: message` header, which repeats the top line. The header is
 *   dropped by position: as many leading lines as `Name: message` spans
 *   when the stack starts with exactly those lines (so a message line
 *   shaped like an `at ` frame never reappears), otherwise every line
 *   before the first `at ` frame. Each line is control-escaped like a
 *   message, at most {@link MAX_STACK_LINES} of them, the rest collapsing
 *   into one `... and N more` line. A missing, non-string or throwing
 *   `stack` appends nothing.
 *
 * Never throws, like {@link formatErrorChain}.
 *
 * @example
 * ```ts
 * import { formatFatalError } from "./format-error.js";
 *
 * formatFatalError(new TypeError("bad input"), { withName: true, withStack: false });
 * // "TypeError: bad input"
 * ```
 */
export function formatFatalError(
  error: unknown,
  options: { readonly withName: boolean; readonly withStack: boolean },
): string {
  const chain = renderChain(error, options.withName);
  const stack = options.withStack ? stackLines(inspect(error)) : [];
  return stack.length === 0 ? chain : `${chain}\n${stack.join("\n")}`;
}

/** {@link formatErrorChain}'s rendering, its top line prefixed with {@link namePrefix} when `withName` is set and the top message is not blank. */
function renderChain(error: unknown, withName: boolean): string {
  const top = inspect(error);
  const topMessage = messageOf(top);
  const blank = isBlank(topMessage);
  // Display only: suppression below still compares against the real message.
  const lines: string[] = messageLines(
    blank ? blankLabel(top) : topMessage,
    0,
    withName && !blank ? namePrefix(top) : "",
  );
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
