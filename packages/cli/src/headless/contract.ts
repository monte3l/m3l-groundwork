// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `groundwork.answers` v1 contract (`.claude/rules/headless-mode.md`,
 * "answers v1"): the runtime tuples every enum is drawn from, the document's
 * types and {@link validateAnswers}. `schemas/answers.v1.schema.json` is the
 * same contract for non-TypeScript callers; a test keeps the two in step, and
 * a plugin-side parity test keeps the kind, runtime and CI-depth tuples equal
 * to `packages/plugin/src/kind-facet-map.ts` (the packages share no import).
 *
 * The validator is the gate a later `--apply` trusts to drive file writes, so
 * it never hands back the caller's value: it walks the fixed shape of the
 * document, reads every property and array element exactly once through a
 * guard, and builds a new, deeply frozen plain structure from what it read.
 * It never recurses into a value it does not expect, so nesting depth is
 * bounded by the schema itself; only plain objects (prototype
 * `Object.prototype` or `null`) and plain arrays are accepted, an array's
 * `length` is read once and checked against {@link MAX_ITEMS} before any
 * element is, every string is length-capped, and a per-call work budget plus
 * an error cap stop a hostile document early. A getter, a proxy or a revoked
 * proxy becomes an error entry instead of an exception.
 */
import { isPrototypeSensitiveKey } from "../merge-json.js";
import { NPM_NAME_MAX_LENGTH, NPM_NAME_PATTERN } from "../npm-name.js";

/**
 * Every project kind the interview offers.
 *
 * @example
 * ```ts
 * import { PROJECT_KINDS } from "./headless/contract.js";
 *
 * const choices = [...PROJECT_KINDS]; // a pending entry's `choices`
 * ```
 */
export const PROJECT_KINDS = [
  "library",
  "cli",
  "frontend",
  "service",
  "plugin",
] as const;

/**
 * Every runtime target the interview offers.
 *
 * @example
 * ```ts
 * import { RUNTIME_TARGETS } from "./headless/contract.js";
 *
 * const choices = [...RUNTIME_TARGETS];
 * ```
 */
export const RUNTIME_TARGETS = ["node", "browser", "both"] as const;

/**
 * Every CI depth the interview offers, shallowest first.
 *
 * @example
 * ```ts
 * import { CI_DEPTHS } from "./headless/contract.js";
 *
 * const choices = [...CI_DEPTHS];
 * ```
 */
export const CI_DEPTHS = ["minimal", "standard", "thorough"] as const;

/**
 * The agents `templates/core` ships, by name. Explore, `test-author` and
 * `code-implementer` are never removable; `interview.keepAgents` is not
 * checked against this list by {@link validateAnswers}.
 *
 * @example
 * ```ts
 * import { BASELINE_AGENTS } from "./headless/contract.js";
 *
 * const dropped = BASELINE_AGENTS.filter((a) => a !== "code-reviewer");
 * ```
 */
export const BASELINE_AGENTS = [
  "Explore",
  "test-author",
  "code-implementer",
  "code-reviewer",
  "silent-failure-hunter",
] as const;

/**
 * The three run modes an answers document can name; `mode` is required and
 * never inferred from the target directory.
 *
 * @example
 * ```ts
 * import { ANSWER_MODES } from "./headless/contract.js";
 *
 * const [first] = ANSWER_MODES; // "fresh"
 * ```
 */
export const ANSWER_MODES = ["fresh", "adopt", "upgrade"] as const;

/**
 * Every per-file conflict resolution. `merge-keys` (key-level JSON, with
 * `takeKeys`) is adopt-only; an upgrade conflict takes the other three.
 *
 * @example
 * ```ts
 * import { CONFLICT_RESOLUTIONS } from "./headless/contract.js";
 *
 * const choices = [...CONFLICT_RESOLUTIONS];
 * ```
 */
export const CONFLICT_RESOLUTIONS = [
  "keep",
  "take",
  "merge-keys",
  "delegate",
] as const;

/** An upgrade conflict's resolutions: every one but `merge-keys`. */
const UPGRADE_RESOLUTIONS = ["keep", "take", "delegate"] as const;
/**
 * What an adopt addition can do with a staged file.
 *
 * @example
 * ```ts
 * import { ADDITION_ACTIONS } from "./headless/contract.js";
 *
 * const choices = [...ADDITION_ACTIONS]; // a pending entry's `choices`
 * ```
 */
export const ADDITION_ACTIONS = ["add", "skip"] as const;
/** What an upgrade does with a file the new baseline no longer ships. */
const REMOVAL_POLICIES = ["keep", "delete"] as const;

/** The most entries any array in the document may hold; its length is checked before an entry is read. */
const MAX_ITEMS = 10_000;
/** The most errors one call reports; validation stops once it is reached. */
const MAX_ERRORS = 100;
/**
 * The most units of work (one per object key listed, array slot reserved and
 * 256 path characters checked) one call spends. A valid document of any
 * realistic size stays far below it; a document that reuses one large array
 * everywhere is stopped here instead of costing quadratic time.
 */
const MAX_WORK = 1_000_000;
/** The longest free-text string: `adopt.missedNotes`, a pending entry's `reason` and `evidence`. */
const MAX_TEXT_LENGTH = 10_000;
/** The longest identifier-like string: a pending `pointer`, a `choices` entry, a domain, plugin id, pack name, agent name or `takeKeys` entry. */
const MAX_NAME_LENGTH = 1000;
/** The longest target-relative path (PATH_MAX on Linux). */
const MAX_PATH_LENGTH = 4096;
/** A basis hash: a lowercase hex SHA-256 digest. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/**
 * The folded spellings of a `.git` segment: `.git` itself and `git~1`, its
 * NTFS 8.3 short name.
 */
const GIT_SEGMENTS: ReadonlySet<string> = new Set([".git", "git~1"]);
/**
 * First path segments no answers document may write under, compared after
 * {@link foldPath}: every {@link GIT_SEGMENTS} spelling and `.groundwork`.
 */
const PROTECTED_ROOTS: ReadonlySet<string> = new Set([
  ...GIT_SEGMENTS,
  ".groundwork",
]);

type ProjectKind = (typeof PROJECT_KINDS)[number];
type RuntimeTarget = (typeof RUNTIME_TARGETS)[number];
type CiDepth = (typeof CI_DEPTHS)[number];
type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/**
 * How strict {@link validateAnswers} is. `partial` (a pending document)
 * allows `null` for every undecided choice and a non-empty `pending` list.
 * `complete` (what `--apply` runs) additionally requires the mode's own
 * section and every other mode section `null`; a `basis` matching the mode
 * (`inventorySha256` for adopt, `planSha256` for upgrade, `null` for fresh);
 * `interview.kind` and `interview.runtime` for fresh and adopt; every
 * conflict `resolution`, every `additions[].action`, `upgrade.applySafe` and
 * `upgrade.removals` decided; and `pending` empty. `interview.testsMandatory`,
 * `interview.ciDepth` and `interview.keepAgents` may stay `null` under
 * `complete`: `null` there means "use the baseline default".
 *
 * @example
 * ```ts
 * import type { ValidationProfile } from "./headless/contract.js";
 *
 * const profile: ValidationProfile = "complete";
 * ```
 */
export type ValidationProfile = "partial" | "complete";

/**
 * One decision nobody supplied: the JSON pointer it belongs at, why it could
 * not be decided, the allowed values when the set is finite, and what the
 * CLI saw.
 *
 * @example
 * ```ts
 * import type { PendingEntry } from "./headless/contract.js";
 *
 * const entry: PendingEntry = {
 *   pointer: "/interview/kind",
 *   reason: "kind has no default",
 *   choices: ["library", "cli", "frontend", "service", "plugin"],
 *   evidence: null,
 * };
 * ```
 */
export type PendingEntry = {
  readonly pointer: string;
  readonly reason: string;
  readonly choices: readonly string[] | null;
  readonly evidence: string | null;
};

/** The hash of the survey (`inventory.json`) or plan (`plan.json`) the answers were made against. */
type AnswersBasis =
  { readonly inventorySha256: string } | { readonly planSha256: string };

/** A conflict entry: one target-relative path and how to resolve it. */
interface ConflictAnswer<Resolution extends string> {
  readonly path: string;
  readonly resolution: Resolution | null;
}

/** An adopt conflict: a conflict entry plus the `takeKeys` of a `merge-keys` resolution. */
type AdoptConflictAnswer = ConflictAnswer<ConflictResolution> & {
  readonly takeKeys?: readonly string[];
};

/**
 * One `groundwork.answers` v1 document, as {@link validateAnswers} accepts it.
 * `null` marks an undecided choice (or an unused mode section).
 *
 * @example
 * ```ts
 * import type { AnswersV1 } from "./headless/contract.js";
 *
 * declare const answers: AnswersV1;
 * if (answers.mode === "adopt") console.log(answers.adopt?.conflicts.length);
 * ```
 */
export interface AnswersV1 {
  readonly schema: "groundwork.answers";
  readonly schemaVersion: 1;
  readonly mode: (typeof ANSWER_MODES)[number];
  readonly basis: AnswersBasis | null;
  readonly fresh: {
    readonly name: string;
    readonly skipInstall: boolean;
  } | null;
  readonly interview: {
    readonly kind: ProjectKind | null;
    readonly runtime: RuntimeTarget | null;
    readonly testsMandatory: boolean | null;
    readonly ciDepth: CiDepth | null;
    readonly keepAgents: readonly string[] | null;
  };
  readonly adopt: {
    readonly additions: readonly {
      readonly path: string;
      readonly action: (typeof ADDITION_ACTIONS)[number] | null;
    }[];
    readonly conflicts: readonly AdoptConflictAnswer[];
    readonly missedNotes: string;
  } | null;
  readonly upgrade: {
    readonly applySafe: boolean | null;
    readonly removals: (typeof REMOVAL_POLICIES)[number] | null;
    readonly conflicts: readonly ConflictAnswer<
      (typeof UPGRADE_RESOLUTIONS)[number]
    >[];
  } | null;
  readonly packs: {
    readonly install: readonly string[];
    readonly decline: readonly string[];
  };
  readonly plugins: {
    readonly enabled: readonly string[];
    readonly declined: readonly string[];
  };
  readonly guidance: {
    readonly enabled: boolean;
    readonly domains: readonly string[];
  };
  readonly pending: readonly PendingEntry[];
}

/**
 * One problem {@link validateAnswers} found: the RFC 6901 JSON pointer it
 * sits at (`""` is the root) and what is wrong.
 *
 * @example
 * ```ts
 * import type { ValidationIssue } from "./headless/contract.js";
 *
 * const format = ({ pointer, message }: ValidationIssue) =>
 *   `${pointer || "(root)"}: ${message}`;
 * ```
 */
export interface ValidationIssue {
  readonly pointer: string;
  readonly message: string;
}

/**
 * What {@link validateAnswers} returns: a new, deeply frozen copy of the
 * document, or every problem found (at least one, at most a fixed cap).
 *
 * @example
 * ```ts
 * import { validateAnswers, type ValidationResult } from "./headless/contract.js";
 *
 * const result: ValidationResult = validateAnswers({}, "partial");
 * if (!result.ok) console.error(result.errors.map((e) => e.pointer));
 * ```
 */
export type ValidationResult =
  | { readonly ok: true; readonly value: AnswersV1 }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

/** Marks a value that failed its check; an error has always been reported (or the call has stopped) when a check returns it. */
const BAD: unique symbol = Symbol("invalid");
type Bad = typeof BAD;

/** Validates one value found at `pointer` and returns its projection, or {@link BAD}. */
type Check<T> = (value: unknown, pointer: string) => T | Bad;

/** An object's known keys, each with its check. */
type Spec = Readonly<Record<string, Check<unknown>>>;

/** The projection of an object read against `S`. */
type Shape<S extends Spec> = {
  readonly [K in keyof S]: Exclude<ReturnType<S[K]>, Bad>;
};

/** Per-call state: the profile, the errors collected so far and the work spent. */
interface Ctx {
  readonly profile: ValidationProfile;
  readonly errors: ValidationIssue[];
  work: number;
}

const NO_OPTIONAL: ReadonlySet<string> = new Set();

/** Whether the call has hit the error cap or the work budget and must stop reading. */
function stopped(ctx: Ctx): boolean {
  return ctx.errors.length >= MAX_ERRORS || ctx.work > MAX_WORK;
}

/** Records an error (below the cap) and returns {@link BAD}. */
function fail(ctx: Ctx, pointer: string, message: string): Bad {
  if (ctx.errors.length < MAX_ERRORS) ctx.errors.push({ pointer, message });
  return BAD;
}

/** Spends `units` of the work budget; `false` (after an error at `pointer`) once it is exhausted. */
function charge(ctx: Ctx, units: number, pointer: string): boolean {
  if (stopped(ctx)) return false;
  ctx.work += units;
  if (ctx.work <= MAX_WORK) return true;
  fail(
    ctx,
    pointer,
    `exceeds the validation work budget of ${String(MAX_WORK)} units`,
  );
  return false;
}

/** `pointer` extended by one RFC 6901 reference token. */
function child(pointer: string, token: string | number): string {
  return `${pointer}/${String(token).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** A non-array object; `Array.isArray` throws on a revoked proxy, which counts as "not an object". */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** What {@link readFields} read: the projected fields that passed, which known keys were listed, and whether everything passed. */
interface Fields<S extends Spec> {
  readonly fields: Partial<Shape<S>>;
  readonly present: ReadonlySet<string>;
  readonly ok: boolean;
}

/**
 * Reads the plain object at `pointer` against `spec`. A non-plain prototype
 * is an error at `pointer`; every unknown or prototype-sensitive own key and
 * every missing non-optional key is an error at that key's own pointer. The
 * own enumerable keys are listed once, each known key among them is read
 * exactly once through a guard, and its check runs on what was read. Returns
 * {@link BAD} when `value` is not a readable plain object.
 */
function readFields<S extends Spec>(
  ctx: Ctx,
  value: unknown,
  pointer: string,
  spec: S,
  optional: ReadonlySet<string> = NO_OPTIONAL,
): Fields<S> | Bad {
  if (stopped(ctx)) return BAD;
  if (!isRecord(value)) return fail(ctx, pointer, "must be an object");
  let keys: readonly string[];
  try {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return fail(
        ctx,
        pointer,
        "must be a plain object (prototype Object.prototype or null)",
      );
    }
    keys = Object.keys(value);
  } catch {
    return fail(ctx, pointer, "could not be read");
  }
  if (!charge(ctx, keys.length + 1, pointer)) return BAD;
  const listed = new Set(keys);
  let ok = true;
  for (const key of keys) {
    if (isPrototypeSensitiveKey(key)) {
      ok = false;
      fail(ctx, child(pointer, key), "is a prototype-sensitive key");
    } else if (!Object.hasOwn(spec, key)) {
      ok = false;
      fail(ctx, child(pointer, key), "is not a known key");
    }
    if (stopped(ctx)) return BAD;
  }
  const out: Record<string, unknown> = {};
  const present = new Set<string>();
  for (const [key, check] of Object.entries(spec)) {
    const at = child(pointer, key);
    if (!listed.has(key)) {
      if (!optional.has(key)) {
        ok = false;
        fail(ctx, at, "is required");
      }
      continue;
    }
    present.add(key);
    let raw: unknown;
    try {
      raw = value[key];
    } catch {
      ok = false;
      fail(ctx, at, "could not be read");
      continue;
    }
    const projected = check(raw, at);
    if (projected === BAD) ok = false;
    else out[key] = projected;
    if (stopped(ctx)) return BAD;
  }
  // `out` holds only spec keys, each set to its own check's projection.
  return { fields: Object.freeze(out) as Partial<Shape<S>>, present, ok };
}

/** {@link readFields} with every key required: the frozen projection, or {@link BAD}. */
function readObject<S extends Spec>(
  ctx: Ctx,
  value: unknown,
  pointer: string,
  spec: S,
): Shape<S> | Bad {
  const read = readFields(ctx, value, pointer, spec);
  if (read === BAD || !read.ok) return BAD;
  // Every spec key is required here, so an `ok` read projected each one.
  return read.fields as Shape<S>;
}

/** The array at `pointer` and its length, read once; a message when either cannot be. */
function arrayAndLength(
  value: unknown,
): { readonly array: readonly unknown[]; readonly length: unknown } | string {
  try {
    if (!Array.isArray(value)) return "must be an array";
    const array: readonly unknown[] = value;
    if (Object.getPrototypeOf(array) !== Array.prototype) {
      return "must be a plain array";
    }
    const length: unknown = Reflect.get(array, "length");
    return { array, length };
  } catch {
    return "could not be read";
  }
}

/**
 * Reads the plain array at `pointer`: its `length` exactly once, which must be
 * a non-negative integer of at most {@link MAX_ITEMS}, then every slot once
 * through a guard (a missing or throwing slot is an error at `pointer`), each
 * projected by `item`. Returns a new frozen array, or {@link BAD}.
 */
function readArray<T>(
  ctx: Ctx,
  value: unknown,
  pointer: string,
  item: (value: unknown, index: number) => T | Bad,
): readonly T[] | Bad {
  if (stopped(ctx)) return BAD;
  const read = arrayAndLength(value);
  if (typeof read === "string") return fail(ctx, pointer, read);
  const { array, length } = read;
  if (typeof length !== "number" || !Number.isSafeInteger(length)) {
    return fail(ctx, pointer, "has a length that is not an integer");
  }
  if (length > MAX_ITEMS) {
    return fail(ctx, pointer, `must have at most ${String(MAX_ITEMS)} items`);
  }
  if (!charge(ctx, length + 1, pointer)) return BAD;
  const out: T[] = [];
  let ok = true;
  for (let index = 0; index < length; index += 1) {
    let raw: unknown;
    try {
      if (!Object.hasOwn(array, index)) {
        ok = false;
        fail(ctx, pointer, `item ${String(index)} is missing`);
        continue;
      }
      raw = array[index];
    } catch {
      ok = false;
      fail(ctx, pointer, `item ${String(index)} could not be read`);
      continue;
    }
    const projected = item(raw, index);
    if (projected === BAD) ok = false;
    else out.push(projected);
    if (stopped(ctx)) return BAD;
  }
  return ok ? Object.freeze(out) : BAD;
}

const literal =
  <const T extends string | number>(ctx: Ctx, expected: T): Check<T> =>
  (value, pointer) =>
    value === expected
      ? expected
      : fail(ctx, pointer, `must be ${JSON.stringify(expected)}`);

const oneOf =
  <T extends string>(ctx: Ctx, allowed: readonly T[]): Check<T> =>
  (value, pointer) =>
    allowed.find((candidate) => candidate === value) ??
    fail(ctx, pointer, `must be one of ${allowed.join(", ")}`);

const text =
  (ctx: Ctx, maxLength: number): Check<string> =>
  (value, pointer) => {
    if (typeof value !== "string")
      return fail(ctx, pointer, "must be a string");
    if (value.length > maxLength) {
      return fail(
        ctx,
        pointer,
        `must be at most ${String(maxLength)} characters`,
      );
    }
    return value;
  };

const boolean =
  (ctx: Ctx): Check<boolean> =>
  (value, pointer) =>
    typeof value === "boolean"
      ? value
      : fail(ctx, pointer, "must be a boolean");

const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (value, pointer) =>
    value === null ? null : check(value, pointer);

/** A decision: `null` (undecided) is allowed only under the partial profile. */
const decided =
  <T>(ctx: Ctx, check: Check<T>): Check<T | null> =>
  (value, pointer) => {
    if (value !== null) return check(value, pointer);
    return ctx.profile === "complete"
      ? fail(ctx, pointer, "must be decided under the complete profile")
      : null;
  };

/** An array of strings of at most {@link MAX_NAME_LENGTH} characters; a bad entry is an error at the array's pointer. */
const nameList =
  (ctx: Ctx): Check<readonly string[]> =>
  (value, pointer) =>
    readArray(ctx, value, pointer, (item, index) =>
      typeof item === "string" && item.length <= MAX_NAME_LENGTH
        ? item
        : fail(
            ctx,
            pointer,
            `item ${String(index)} must be a string of at most ${String(MAX_NAME_LENGTH)} characters`,
          ),
    );

const sha256 =
  (ctx: Ctx): Check<string> =>
  (value, pointer) =>
    typeof value === "string" && SHA256_PATTERN.test(value)
      ? value
      : fail(ctx, pointer, "must be 64 lowercase hexadecimal digits");

/** A project name under the same rule `--name` uses (`npm-name.ts`). */
const npmName =
  (ctx: Ctx): Check<string> =>
  (value, pointer) =>
    typeof value === "string" &&
    value.length <= NPM_NAME_MAX_LENGTH &&
    NPM_NAME_PATTERN.test(value)
      ? value
      : fail(
          ctx,
          pointer,
          `must be a valid npm package name (lowercase, optional @scope/, at most ${String(NPM_NAME_MAX_LENGTH)} characters)`,
        );

function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why one segment of a path is unsafe, or `undefined` when it is not: an
 * empty, `.` or `..` segment, a trailing dot or space (Windows strips both,
 * so `.git.` names `.git`), or a colon (NTFS alternate data stream syntax).
 *
 * @example
 * ```ts
 * import { segmentProblem } from "./headless/contract.js";
 *
 * segmentProblem(".git."); // "must not end a segment with . or a space (Windows strips both)"
 * segmentProblem("src"); // undefined
 * ```
 */
export function segmentProblem(segment: string): string | undefined {
  if (segment === "") {
    return "must not contain an empty segment (a leading, trailing or doubled /)";
  }
  if (segment === ".") return "must not contain a . segment";
  if (segment === "..") return "must not contain a .. segment";
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    return "must not end a segment with . or a space (Windows strips both)";
  }
  if (segment.includes(":")) {
    return "must not contain : (an NTFS alternate data stream)";
  }
  return undefined;
}

/**
 * The comparison key a case-insensitive, normalizing file system sees: NFC,
 * then upper case, then lower case, so that `ſ` meets `s`, `ı` meets `i` and
 * the Kelvin sign meets `k`. Two paths with the same key can name one file.
 *
 * @example
 * ```ts
 * import { foldPath } from "./headless/contract.js";
 *
 * foldPath("README.md") === foldPath("readme.md"); // true
 * ```
 */
export function foldPath(path: string): string {
  return path.normalize("NFC").toUpperCase().toLowerCase();
}

/**
 * Whether one path segment names `.git` on a case-insensitive or NTFS file
 * system: `.git` or its 8.3 short name `git~1`, compared after
 * {@link foldPath}. A segment that merely contains `.git` (`.github`) does not.
 *
 * @example
 * ```ts
 * import { isGitSegment } from "./headless/contract.js";
 *
 * "sub/.GIT/config".split("/").some((s) => isGitSegment(s)); // true
 * ```
 */
export function isGitSegment(segment: string): boolean {
  return GIT_SEGMENTS.has(foldPath(segment));
}

/**
 * Why `path` is not a safe target-relative POSIX path, or `undefined` when it
 * is. The first segment is compared after {@link foldPath} against
 * {@link PROTECTED_ROOTS}, since macOS and Windows file systems usually are
 * case-insensitive. Only the first segment is protected.
 */
function pathProblem(path: string): string | undefined {
  if (path === "") return "must not be empty";
  if (path.length > MAX_PATH_LENGTH) {
    return `must be at most ${String(MAX_PATH_LENGTH)} characters`;
  }
  if (!path.isWellFormed()) {
    // Node writes a lone surrogate as U+FFFD, so two such paths would alias.
    return "must be well-formed UTF-16 (no lone surrogate)";
  }
  if (path.includes("\0")) return "must not contain a NUL byte";
  if (hasControlCharacter(path)) return "must not contain a control character";
  if (path.includes("\\")) return "must use / as its only separator";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return "must be relative to the target";
  }
  const segments = path.split("/");
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== undefined) return problem;
  }
  const [first = ""] = segments;
  if (PROTECTED_ROOTS.has(foldPath(first))) {
    return `must not be under ${first}`;
  }
  return undefined;
}

const relativePath =
  (ctx: Ctx): Check<string> =>
  (value, pointer) => {
    if (typeof value !== "string")
      return fail(ctx, pointer, "must be a string");
    if (!charge(ctx, 1 + Math.floor(value.length / 256), pointer)) return BAD;
    const problem = pathProblem(value);
    return problem === undefined ? value : fail(ctx, pointer, problem);
  };

/**
 * An array of `{path, ...}` entries, each projected by `entry`. A path that
 * repeats an earlier entry's, compared after {@link foldPath} (what a
 * case-insensitive, normalizing file system sees), is an error at the later
 * entry's `path`. Uniqueness is per array: the same path may appear in
 * `additions` and in `conflicts`.
 */
const pathEntries =
  <T extends { readonly path: string }>(
    ctx: Ctx,
    entry: Check<T>,
  ): Check<readonly T[]> =>
  (value, pointer) => {
    const seen = new Set<string>();
    return readArray(ctx, value, pointer, (item, index) => {
      const at = child(pointer, index);
      const projected = entry(item, at);
      if (projected === BAD) return BAD;
      const key = foldPath(projected.path);
      if (seen.has(key)) {
        return fail(
          ctx,
          child(at, "path"),
          "repeats an earlier entry's path (ignoring case and Unicode normalization)",
        );
      }
      seen.add(key);
      return projected;
    });
  };

const takeKeyList =
  (ctx: Ctx): Check<readonly string[]> =>
  (value, pointer) =>
    readArray(ctx, value, pointer, (item, index) => {
      const at = child(pointer, index);
      if (typeof item !== "string") return fail(ctx, at, "must be a string");
      if (item.length > MAX_NAME_LENGTH) {
        return fail(
          ctx,
          at,
          `must be at most ${String(MAX_NAME_LENGTH)} characters`,
        );
      }
      return isPrototypeSensitiveKey(item)
        ? fail(ctx, at, "is a prototype-sensitive key")
        : item;
    });

const TAKE_KEYS_OPTIONAL: ReadonlySet<string> = new Set(["takeKeys"]);
const BASIS_KEYS_OPTIONAL: ReadonlySet<string> = new Set([
  "inventorySha256",
  "planSha256",
]);

const adoptConflict =
  (ctx: Ctx): Check<AdoptConflictAnswer> =>
  (value, pointer) => {
    const read = readFields(
      ctx,
      value,
      pointer,
      {
        path: relativePath(ctx),
        resolution: decided(ctx, oneOf(ctx, CONFLICT_RESOLUTIONS)),
        takeKeys: takeKeyList(ctx),
      },
      TAKE_KEYS_OPTIONAL,
    );
    if (read === BAD) return BAD;
    const { path, resolution, takeKeys } = read.fields;
    if (
      read.present.has("takeKeys") &&
      resolution !== undefined &&
      resolution !== null &&
      resolution !== "merge-keys"
    ) {
      return fail(
        ctx,
        child(pointer, "takeKeys"),
        "is allowed only with resolution merge-keys",
      );
    }
    if (!read.ok || path === undefined || resolution === undefined) return BAD;
    return Object.freeze(
      takeKeys === undefined
        ? { path, resolution }
        : { path, resolution, takeKeys },
    );
  };

const basis =
  (ctx: Ctx): Check<AnswersBasis> =>
  (value, pointer) => {
    const read = readFields(
      ctx,
      value,
      pointer,
      { inventorySha256: sha256(ctx), planSha256: sha256(ctx) },
      BASIS_KEYS_OPTIONAL,
    );
    if (read === BAD) return BAD;
    if (read.present.size !== 1) {
      return fail(
        ctx,
        pointer,
        "must have exactly one of inventorySha256, planSha256",
      );
    }
    if (!read.ok) return BAD;
    const { inventorySha256, planSha256 } = read.fields;
    if (inventorySha256 !== undefined) {
      return Object.freeze({ inventorySha256 });
    }
    return planSha256 === undefined ? BAD : Object.freeze({ planSha256 });
  };

const object =
  <S extends Spec>(ctx: Ctx, spec: S): Check<Shape<S>> =>
  (value, pointer) =>
    readObject(ctx, value, pointer, spec);

function topLevelSpec(ctx: Ctx) {
  const bool = boolean(ctx);
  const names = nameList(ctx);
  const freeText = text(ctx, MAX_TEXT_LENGTH);
  return {
    schema: literal(ctx, "groundwork.answers"),
    schemaVersion: literal(ctx, 1),
    mode: oneOf(ctx, ANSWER_MODES),
    basis: nullable(basis(ctx)),
    fresh: nullable(object(ctx, { name: npmName(ctx), skipInstall: bool })),
    interview: object(ctx, {
      kind: nullable(oneOf(ctx, PROJECT_KINDS)),
      runtime: nullable(oneOf(ctx, RUNTIME_TARGETS)),
      testsMandatory: nullable(bool),
      ciDepth: nullable(oneOf(ctx, CI_DEPTHS)),
      keepAgents: nullable(names),
    }),
    adopt: nullable(
      object(ctx, {
        additions: pathEntries(
          ctx,
          object(ctx, {
            path: relativePath(ctx),
            action: decided(ctx, oneOf(ctx, ADDITION_ACTIONS)),
          }),
        ),
        conflicts: pathEntries(ctx, adoptConflict(ctx)),
        missedNotes: freeText,
      }),
    ),
    upgrade: nullable(
      object(ctx, {
        applySafe: decided(ctx, bool),
        removals: decided(ctx, oneOf(ctx, REMOVAL_POLICIES)),
        conflicts: pathEntries(
          ctx,
          object(ctx, {
            path: relativePath(ctx),
            resolution: decided(ctx, oneOf(ctx, UPGRADE_RESOLUTIONS)),
          }),
        ),
      }),
    ),
    packs: object(ctx, { install: names, decline: names }),
    plugins: object(ctx, { enabled: names, declined: names }),
    guidance: object(ctx, { enabled: bool, domains: names }),
    pending: (value: unknown, pointer: string) =>
      readArray(ctx, value, pointer, (item, index) =>
        readObject(ctx, item, child(pointer, index), {
          pointer: text(ctx, MAX_NAME_LENGTH),
          reason: freeText,
          choices: nullable(names),
          evidence: nullable(freeText),
        }),
      ),
  } satisfies Spec;
}

type TopShape = Shape<ReturnType<typeof topLevelSpec>>;

/** The basis key each mode's `--apply` checks against; fresh has none. */
const BASIS_KEY_BY_MODE: Readonly<
  Record<(typeof ANSWER_MODES)[number], string | null>
> = {
  fresh: null,
  adopt: "inventorySha256",
  upgrade: "planSha256",
};

/** The cross-field rules only the complete profile enforces, over whatever top-level fields passed their own checks. */
function checkComplete(ctx: Ctx, top: Partial<TopShape>): void {
  const { mode } = top;
  if (mode === undefined) return; // already reported
  for (const section of ANSWER_MODES) {
    const value = top[section];
    if (value === undefined) continue;
    if (section === mode && value === null) {
      fail(ctx, `/${section}`, `is required when mode is ${mode}`);
    } else if (section !== mode && value !== null) {
      fail(ctx, `/${section}`, `must be null when mode is ${mode}`);
    }
  }
  const { basis: basisValue } = top;
  if (basisValue !== undefined) {
    const expected = BASIS_KEY_BY_MODE[mode];
    if (expected === null && basisValue !== null) {
      fail(ctx, "/basis", "must be null when mode is fresh");
    } else if (expected !== null && basisValue === null) {
      fail(ctx, "/basis", `is required when mode is ${mode}`);
    } else if (
      expected !== null &&
      basisValue !== null &&
      !Object.hasOwn(basisValue, expected)
    ) {
      fail(ctx, "/basis", `must carry ${expected} when mode is ${mode}`);
    }
  }
  if (mode !== "upgrade") {
    for (const field of ["kind", "runtime"] as const) {
      if (top.interview?.[field] === null) {
        fail(ctx, `/interview/${field}`, `is required when mode is ${mode}`);
      }
    }
  }
  if (top.pending !== undefined && top.pending.length > 0) {
    fail(ctx, "/pending", "must be empty under the complete profile");
  }
}

/**
 * Validates an untrusted value (typically `JSON.parse` output) as a
 * `groundwork.answers` v1 document under `profile`. Never throws: anything it
 * cannot read, a cycle, a non-plain object, a getter or proxy trap that
 * throws, an array or string over its size cap, becomes an error with the
 * RFC 6901 pointer of where it sits (`""` is the root). Unknown keys,
 * prototype-sensitive keys and missing keys are reported at their own
 * pointer; collections are arrays of `{path, ...}` with safe relative paths,
 * unique within each array ignoring case and Unicode normalization. Stops
 * early once 100 errors are collected or its work budget is spent.
 *
 * On success `value` is a new, deeply frozen plain structure projected from
 * what was read (each property and element exactly once); it shares no
 * reference with the input, and symbol keys or extra array properties are
 * dropped, so mutating the input afterwards cannot change it.
 *
 * @example
 * ```ts
 * import { readFile } from "node:fs/promises";
 * import { validateAnswers } from "./headless/contract.js";
 *
 * const parsed: unknown = JSON.parse(await readFile("answers.json", "utf8"));
 * const result = validateAnswers(parsed, "complete");
 * if (!result.ok) {
 *   for (const { pointer, message } of result.errors) {
 *     console.error(`${pointer || "(root)"}: ${message}`);
 *   }
 * }
 * ```
 */
export function validateAnswers(
  value: unknown,
  profile: ValidationProfile,
): ValidationResult {
  const ctx: Ctx = { profile, errors: [], work: 0 };
  const read = readFields(ctx, value, "", topLevelSpec(ctx));
  if (read !== BAD && profile === "complete" && !stopped(ctx)) {
    checkComplete(ctx, read.fields);
  }
  // A check returns BAD only after reporting (or once the call has stopped,
  // which needs an error), so a failed read always leaves errors behind.
  if (read === BAD || !read.ok || ctx.errors.length > 0) {
    return { ok: false, errors: Object.freeze([...ctx.errors]) };
  }
  // Every top-level key is required, so an `ok` read projected each one.
  const answers: AnswersV1 = read.fields as TopShape;
  return { ok: true, value: answers };
}
