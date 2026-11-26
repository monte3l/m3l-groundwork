// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The update flow's classification: for every file, compares the release
 * the project was installed from (base), the project itself (ours) and what
 * the running CLI would write (theirs), and decides what an update would do.
 * Read-only: nothing here writes to the project.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fetchedBaseFile } from "./fetch-base.js";
import type { FetchedBase } from "./fetch-base.js";
import { BASE_DIR, BASE_SUFFIX } from "./lock.js";
import type { Lock, LockFile } from "./lock.js";
import { isRecord, jsonEqual } from "./merge-json.js";
import { mergeJsonText, pointerToken } from "./merge-json3.js";
import { applicableMigrations } from "./migrations.js";
import type { Migration } from "./migrations.js";
import {
  projectEntry,
  readProjectFile,
  sha256Hex,
} from "./pack-installation.js";
import { errnoCode } from "./survey/internal/read-guard.js";
import type { TemplateHistory } from "./template-history.js";
import type { FileSource } from "./theirs-tree.js";
import { applyTokens } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

/**
 * What an update would do to one file. `take`, `merge`, `add`, `delete`
 * and `rename` change it; `conflict` and `review` need the owner; `current`,
 * `keep` and `skip` leave it alone.
 *
 * @example
 * ```ts
 * const action: UpdateAction = "take";
 * ```
 */
export type UpdateAction =
  | "take"
  | "merge"
  | "conflict"
  | "review"
  | "add"
  | "delete"
  | "rename"
  | "current"
  | "keep"
  | "skip";

/**
 * What an update does with an entry unless told otherwise: apply it, ask
 * the owner, or leave the file alone.
 *
 * @example
 * ```ts
 * const choice: UpdateDefault = "ask";
 * ```
 */
type UpdateDefault = "apply" | "ask" | "skip";

/**
 * Where a base came from: the `.groundwork/base/` snapshot, the lock's
 * recorded hash, or the shipped template history.
 *
 * @example
 * ```ts
 * const from: BaseFrom = "snapshot";
 * ```
 */
type BaseFrom = "snapshot" | "lock" | "history";

/**
 * The base of one file: its full content, only its sha256, or nothing known.
 *
 * @example
 * ```ts
 * const base: UpdateBaseContent = { kind: "hash", sha256: "0".repeat(64), from: "lock" };
 * ```
 */
type UpdateBaseContent =
  | {
      readonly kind: "content";
      readonly bytes: Uint8Array;
      readonly from: BaseFrom;
    }
  | { readonly kind: "hash"; readonly sha256: string; readonly from: BaseFrom }
  | { readonly kind: "none" };

/**
 * How a three-way JSON merge resolves one key, as a JSON pointer.
 *
 * @example
 * ```ts
 * const diff: KeyDiff = { pointer: "/devDependencies/vitest", resolution: "theirs" };
 * ```
 */
interface KeyDiff {
  readonly pointer: string;
  readonly resolution: "ours" | "theirs" | "conflict";
}

/**
 * {@link classifyFile}'s input: one path's three sides and the lock's say
 * about it. An absent side is `undefined`.
 *
 * @example
 * ```ts
 * const input: ClassifyFileInput = {
 *   path: "lefthook.yml",
 *   source: "core",
 *   skipped: false,
 *   base: { kind: "none" },
 *   ours: undefined,
 *   theirs: new TextEncoder().encode("pre-commit: {}\n"),
 *   jsonMerge: false,
 * };
 * ```
 */
export interface ClassifyFileInput {
  readonly path: string;
  readonly source: FileSource;
  readonly skipped: boolean;
  readonly base: UpdateBaseContent;
  readonly ours?: Uint8Array | undefined;
  readonly theirs?: Uint8Array | undefined;
  readonly jsonMerge: boolean;
  readonly status?: LockFile["status"] | undefined;
  readonly renamedTo?: string | undefined;
}

/**
 * One classified file: the action, its default, why, and the three sides'
 * sha256 (`null` for an absent side or an unknown base).
 *
 * @example
 * ```ts
 * const entry: UpdateFileEntry = classifyFile(input);
 * console.log(`${entry.path}: ${entry.action} (${entry.reason})`);
 * ```
 */
export interface UpdateFileEntry {
  readonly path: string;
  readonly source: FileSource;
  readonly action: UpdateAction;
  readonly default: UpdateDefault;
  readonly reason: string;
  readonly baseSha256: string | null;
  readonly oursSha256: string | null;
  readonly theirsSha256: string | null;
  readonly baseFrom: BaseFrom | null;
  readonly renamedTo?: string;
  readonly keyDiffs?: readonly KeyDiff[];
}

function hashOf(bytes: Uint8Array): string {
  return sha256Hex(Buffer.from(bytes));
}

/** Whether `bytes` is present and is the base (by content, or by hash). */
function matchesBase(
  base: UpdateBaseContent,
  bytes: Uint8Array | undefined,
): boolean {
  if (bytes === undefined) return false;
  switch (base.kind) {
    case "content":
      return Buffer.compare(bytes, base.bytes) === 0;
    case "hash":
      return hashOf(bytes) === base.sha256;
    case "none":
      return false;
    default: {
      const exhaustive: never = base;
      throw new Error(`unhandled base kind ${String(exhaustive)}`);
    }
  }
}

function sidesEqual(
  ours: Uint8Array | undefined,
  theirs: Uint8Array | undefined,
): boolean {
  if (ours === undefined || theirs === undefined) return ours === theirs;
  return Buffer.compare(ours, theirs) === 0;
}

/** Marks a key absent on one side. */
const ABSENT: unique symbol = Symbol("absent");

function slotEqual(a: unknown, b: unknown): boolean {
  if (a === ABSENT || b === ABSENT) return a === b;
  return jsonEqual(a, b);
}

/**
 * Per-key resolutions of a three-way JSON merge, at the deepest key where
 * all three sides are objects -- the same pointers `mergeJson3` reports
 * conflicts at.
 */
function collectKeyDiffs(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: string,
  out: KeyDiff[],
): void {
  if (slotEqual(ours, theirs)) return;
  if (isRecord(base) && isRecord(ours) && isRecord(theirs)) {
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(ours),
      ...Object.keys(theirs),
    ]);
    for (const key of keys) {
      collectKeyDiffs(
        Object.hasOwn(base, key) ? base[key] : ABSENT,
        Object.hasOwn(ours, key) ? ours[key] : ABSENT,
        Object.hasOwn(theirs, key) ? theirs[key] : ABSENT,
        `${path}/${pointerToken(key)}`,
        out,
      );
    }
    return;
  }
  if (slotEqual(ours, base)) out.push({ pointer: path, resolution: "theirs" });
  else if (slotEqual(theirs, base)) {
    out.push({ pointer: path, resolution: "ours" });
  } else out.push({ pointer: path, resolution: "conflict" });
}

type Verdict = Pick<UpdateFileEntry, "action" | "default" | "reason"> & {
  readonly keyDiffs?: readonly KeyDiff[];
};

/** Both sides changed a JSON file the base's content is known for. */
function classifyJson(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
): Verdict {
  const decoder = new TextDecoder();
  const [baseText, oursText, theirsText] = [base, ours, theirs].map((bytes) =>
    decoder.decode(bytes),
  );
  const merged = mergeJsonText(
    baseText ?? "",
    oursText ?? "",
    theirsText ?? "",
  );
  if ("unmergeable" in merged) {
    return {
      action: "review",
      default: "skip",
      reason: `both sides changed it, and it cannot be merged as JSON: ${merged.unmergeable}`,
    };
  }
  const keyDiffs: KeyDiff[] = [];
  collectKeyDiffs(
    JSON.parse(baseText ?? "") as unknown,
    JSON.parse(oursText ?? "") as unknown,
    JSON.parse(theirsText ?? "") as unknown,
    "",
    keyDiffs,
  );
  if (merged.conflicts.length > 0) {
    return {
      action: "conflict",
      default: "ask",
      reason: `both sides changed ${merged.conflicts.join(", ")}`,
      keyDiffs,
    };
  }
  return {
    action: "merge",
    default: "apply",
    reason: "both sides changed different keys; they merge cleanly",
    keyDiffs,
  };
}

/** The decision table, rules 0-10 in order. */
function decide(input: ClassifyFileInput): Verdict {
  const { base, ours, theirs, status, renamedTo } = input;
  // 0: the lock's skip list wins over everything.
  if (input.skipped) {
    return { action: "skip", default: "skip", reason: "the lock skips it" };
  }
  // 1: a migration moved it upstream (nothing to move when the project
  // never had it).
  if (renamedTo !== undefined) {
    if (ours === undefined) {
      return {
        action: "current",
        default: "skip",
        reason: `moved upstream to ${renamedTo}, but the project does not have it`,
      };
    }
    return matchesBase(base, ours)
      ? {
          action: "rename",
          default: "apply",
          reason: `moved upstream to ${renamedTo}`,
        }
      : {
          action: "rename",
          default: "ask",
          reason: `moved upstream to ${renamedTo}, and the local copy differs from its base`,
        };
  }
  // 2: the owner declined, kept or removed it.
  if (status === "declined" || status === "kept" || status === "removed") {
    const unchanged =
      matchesBase(base, theirs) || (base.kind === "none" && !theirs);
    return unchanged
      ? {
          action: "skip",
          default: "skip",
          reason: `${status} earlier, and unchanged upstream`,
        }
      : {
          action: "review",
          default: "skip",
          reason: `${status} earlier, but changed upstream since`,
        };
  }
  // 3: nothing to do.
  if (sidesEqual(ours, theirs)) {
    return { action: "current", default: "skip", reason: "already current" };
  }
  // 4: only the project changed it.
  if (matchesBase(base, theirs)) {
    return {
      action: "keep",
      default: "skip",
      reason: "changed only locally; upstream is unchanged",
    };
  }
  // 9: no base to compare against.
  if (base.kind === "none") {
    if (theirs === undefined) {
      return {
        action: "keep",
        default: "skip",
        reason: "not shipped upstream, and no base records where it came from",
      };
    }
    if (ours === undefined) {
      return { action: "add", default: "apply", reason: "new upstream" };
    }
    return {
      action: "review",
      default: "skip",
      reason:
        "both sides have it, but there is no base to tell which side changed it",
    };
  }
  // 10: removed upstream.
  if (theirs === undefined) {
    return matchesBase(base, ours)
      ? { action: "delete", default: "apply", reason: "removed upstream" }
      : {
          action: "review",
          default: "skip",
          reason: "removed upstream, but changed locally",
        };
  }
  // 6: deleted locally, changed upstream.
  if (ours === undefined) {
    return {
      action: "review",
      default: "skip",
      reason: "deleted locally, but changed upstream",
    };
  }
  // 5: only upstream changed it.
  if (matchesBase(base, ours)) {
    return {
      action: "take",
      default: "apply",
      reason: "changed only upstream",
    };
  }
  // 8: both changed, and only the base's hash is known.
  if (base.kind === "hash") {
    return {
      action: "review",
      default: "skip",
      reason:
        "both sides changed it, and only the base's hash is known -- no three-way merge",
    };
  }
  // 7: both changed, base content known.
  if (input.jsonMerge) return classifyJson(base.bytes, ours, theirs);
  return {
    action: "merge",
    default: "apply",
    reason:
      "both sides changed it; a text merge runs at update time and may still find conflicts",
  };
}

function baseHash(base: UpdateBaseContent): string | null {
  switch (base.kind) {
    case "content":
      return hashOf(base.bytes);
    case "hash":
      return base.sha256;
    case "none":
      return null;
    default: {
      const exhaustive: never = base;
      throw new Error(`unhandled base kind ${String(exhaustive)}`);
    }
  }
}

/**
 * Classifies one file by the update decision table, in order: (0) a skipped
 * path is `skip`; (1) a migration rename is `rename` (`apply` when ours is
 * the base, else `ask`; `current` when ours is absent); (2) a
 * `declined`/`kept`/`removed` file is `skip` when theirs is the base, else
 * `review`; (3) ours equal to theirs is `current`; (4)
 * theirs equal to the base is `keep`; (9) with no base: theirs only is
 * `add`, both differing is `review`, ours only is `keep`; (10) removed
 * upstream is `delete` when ours is the base, else `review`; (6) deleted
 * locally but changed upstream is `review`; (5) ours equal to the base is
 * `take`; (8) both changed with a hash-only base is `review`; (7) both
 * changed with a known base is `merge`, or for JSON `merge`/`conflict` per
 * key (`review` when unmergeable). Pure: reads and writes nothing.
 *
 * @example
 * ```ts
 * import { classifyFile } from "./update-classify.js";
 *
 * const enc = (text: string) => new TextEncoder().encode(text);
 * const entry = classifyFile({
 *   path: "lefthook.yml",
 *   source: "core",
 *   skipped: false,
 *   base: { kind: "content", bytes: enc("old\n"), from: "snapshot" },
 *   ours: enc("old\n"),
 *   theirs: enc("new\n"),
 *   jsonMerge: false,
 * });
 * console.log(entry.action); // "take"
 * ```
 */
export function classifyFile(input: ClassifyFileInput): UpdateFileEntry {
  const verdict = decide(input);
  const { base, ours, theirs, renamedTo } = input;
  return {
    path: input.path,
    source: input.source,
    action: verdict.action,
    default: verdict.default,
    reason: verdict.reason,
    baseSha256: baseHash(base),
    oursSha256: ours === undefined ? null : hashOf(ours),
    theirsSha256: theirs === undefined ? null : hashOf(theirs),
    baseFrom: base.kind === "none" ? null : base.from,
    ...(verdict.action === "rename" && renamedTo !== undefined
      ? { renamedTo }
      : {}),
    ...(verdict.keyDiffs === undefined ? {} : { keyDiffs: verdict.keyDiffs }),
  };
}

/**
 * Where the project came from, for {@link classifyProject}: a fresh
 * bootstrap, an adopted project (the lock's `"adopt"` origin), or unknown.
 *
 * @example
 * ```ts
 * const origin: UpdateOrigin = "adopted";
 * ```
 */
export type UpdateOrigin = "fresh" | "adopted" | "unknown";

/**
 * {@link classifyProject}'s input: the project and its lock (when there is
 * one), the template history and the base release, the ledger's packs, the
 * token table, a built theirs tree (see `buildTheirsTree`), the shipped
 * migrations, the running CLI's version and the project's origin. Optional:
 * `missingPacks`, the ledger packs this CLI no longer ships (their files are
 * left alone), and `ledgerPackVersions`, the CLI version each ledger pack
 * was installed with (its files' base; default `baseVersion`), and
 * `fetchedBase`, a release `--fetch-base` rebuilt from npm (see
 * {@link classifyProject}).
 *
 * @example
 * ```ts
 * const input: ClassifyProjectInput = {
 *   targetDir: "/path/to/project",
 *   history,
 *   baseVersion: "1.4.0",
 *   ledgerPacks: [],
 *   tokens: { PROJECT_NAME: "acme" },
 *   theirsDir: theirs.dir,
 *   theirsSources: theirs.sources,
 *   migrations: [],
 *   runningVersion: "1.5.0",
 *   origin: "fresh",
 * };
 * ```
 */
export interface ClassifyProjectInput {
  readonly targetDir: string;
  readonly lock?: Lock | undefined;
  readonly history: TemplateHistory;
  readonly baseVersion: string;
  readonly ledgerPacks: readonly string[];
  readonly tokens: TokenTable;
  readonly theirsDir: string;
  readonly theirsSources: ReadonlyMap<string, FileSource>;
  readonly migrations: readonly Migration[];
  readonly runningVersion: string;
  readonly origin: UpdateOrigin;
  readonly missingPacks?: readonly string[] | undefined;
  readonly ledgerPackVersions?: Readonly<Record<string, string>> | undefined;
  readonly fetchedBase?: FetchedBase | undefined;
}

/**
 * {@link classifyProject}'s result: every entry (sorted by path), the count
 * of each action, and notes about what could not be read.
 *
 * @example
 * ```ts
 * const { summary } = classifyProject(input);
 * console.log(summary.take);
 * ```
 */
export interface ClassifyProjectResult {
  readonly entries: readonly UpdateFileEntry[];
  readonly summary: Readonly<Record<UpdateAction, number>>;
  readonly notes: readonly string[];
}

/** The actions that change a file, so an adopted project's owner must see them. */
const CHANGES: ReadonlySet<UpdateAction> = new Set<UpdateAction>([
  "take",
  "merge",
  "conflict",
  "add",
  "delete",
  "rename",
]);

/** The JSON files pack wiring merges into: the owner's in an adopted project. */
const WIRING_TARGETS: ReadonlySet<string> = new Set([
  "package.json",
  ".claude/settings.json",
  "bin/lib/verify-steps.packs.json",
]);

type ProjectRead =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * A project file's bytes, read only when it is a regular file reached
 * without a symlink: `absent`, or `unreadable` with a reason naming `rel`
 * (a symlink, a directory, a FIFO, a read failure). Never throws.
 *
 * @example
 * ```ts
 * import { readGuarded } from "./update-classify.js";
 *
 * const read = readGuarded("/path/to/project", "eslint.config.js");
 * if (read.kind === "unreadable") console.log(read.reason);
 * ```
 */
export function readGuarded(targetDir: string, rel: string): ProjectRead {
  const entry = projectEntry(targetDir, rel);
  if (entry.kind === "absent") return { kind: "absent" };
  if (entry.kind === "file") {
    try {
      return { kind: "bytes", bytes: readFileSync(join(targetDir, rel)) };
    } catch (error) {
      return {
        kind: "unreadable",
        reason: `${rel} could not be read (${errnoCode(error) ?? "unknown error"})`,
      };
    }
  }
  const read = readProjectFile(targetDir, rel);
  return {
    kind: "unreadable",
    reason: read.ok ? `${rel} changed while it was read` : read.reason,
  };
}

/** Every regular file under `dir`, as `/`-separated relative paths. */
function treeFiles(dir: string): Set<string> {
  return new Set(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"),
      ),
  );
}

function asSource(value: string): FileSource | undefined {
  if (value === "core" || value === "skill") return value;
  return value.startsWith("pack:") ? `pack:${value.slice(5)}` : undefined;
}

/** What resolving a base needs: {@link ClassifyProjectInput} without the theirs tree. */
type BaseInput = Pick<
  ClassifyProjectInput,
  | "targetDir"
  | "lock"
  | "history"
  | "baseVersion"
  | "ledgerPacks"
  | "tokens"
  | "ledgerPackVersions"
  | "fetchedBase"
>;

type HistoryHashes = ReadonlyMap<
  string,
  { readonly sha256: string; readonly source: FileSource }
>;

/** Where `path` comes from: theirs, else the lock's record, else the history, else core. */
function sourceOf(
  path: string,
  lockFile: LockFile | undefined,
  history: HistoryHashes,
  theirsSources?: ReadonlyMap<string, FileSource>,
): FileSource {
  return (
    theirsSources?.get(path) ??
    asSource(lockFile?.source ?? "") ??
    history.get(path)?.source ??
    "core"
  );
}

/**
 * The base release's template hashes: core at `baseVersion`, then each
 * ledger pack at the version it was installed with (default `baseVersion`).
 */
function historyHashes(
  input: BaseInput,
): Map<string, { readonly sha256: string; readonly source: FileSource }> {
  const out = new Map<
    string,
    { readonly sha256: string; readonly source: FileSource }
  >();
  const { versions } = input.history;
  const versionOf = (
    key: string,
  ): TemplateHistory["versions"][string] | undefined =>
    Object.hasOwn(versions, key) ? versions[key] : undefined;
  const core = versionOf(input.baseVersion);
  for (const [path, sha256] of Object.entries(core?.core ?? {})) {
    out.set(path, { sha256, source: "core" });
  }
  const packVersions = input.ledgerPackVersions ?? {};
  for (const name of input.ledgerPacks) {
    const own = Object.hasOwn(packVersions, name)
      ? packVersions[name]
      : undefined;
    const version = versionOf(own ?? input.baseVersion);
    const pack =
      version !== undefined && Object.hasOwn(version.packs, name)
        ? version.packs[name]
        : undefined;
    for (const [path, sha256] of Object.entries(pack?.files ?? {})) {
      out.set(path, { sha256, source: `pack:${name}` });
    }
  }
  return out;
}

/** The release `source`'s files were installed from: a ledger pack's own version, else `baseVersion`. */
function releaseOf(input: BaseInput, source: FileSource): string {
  if (!source.startsWith("pack:")) return input.baseVersion;
  const name = source.slice("pack:".length);
  const versions = input.ledgerPackVersions ?? {};
  return (
    (Object.hasOwn(versions, name) ? versions[name] : undefined) ??
    input.baseVersion
  );
}

/**
 * The `--fetch-base` bytes of `path` when they are its base: fetched for the
 * release `source` was installed from, and hashing (as published, else with
 * the tokens applied) to `sha256`. A mismatch is a note; `undefined` when
 * there is no fetched file to use.
 */
function fetchedContent(
  input: BaseInput,
  path: string,
  source: FileSource,
  known: { readonly sha256: string; readonly from: BaseFrom },
  notes: string[],
): UpdateBaseContent | undefined {
  const fetched = input.fetchedBase;
  if (fetched === undefined || fetched.version !== releaseOf(input, source)) {
    return undefined;
  }
  const raw = fetchedBaseFile(fetched, source, path);
  if (raw === undefined) return undefined;
  const tokenized = Buffer.from(
    applyTokens(new TextDecoder().decode(raw), input.tokens),
    "utf8",
  );
  const bytes = [raw, tokenized].find((b) => hashOf(b) === known.sha256);
  if (bytes === undefined) {
    notes.push(
      `the ${path} fetched from @monte3l/groundwork@${fetched.version} does not match the ${known.from === "lock" ? "lock's" : "template history's"} hash -- only the hash is used`,
    );
    return undefined;
  }
  return { kind: "content", bytes, from: known.from };
}

/**
 * The base of `path`: the snapshot when the lock's hash verifies it, else
 * the history's blob (tokens applied), else -- when only a hash is known --
 * the `--fetch-base` bytes that hash to it, else the hash.
 */
function resolveBase(
  input: BaseInput,
  path: string,
  source: FileSource,
  lockFile: LockFile | undefined,
  history: ReadonlyMap<string, { readonly sha256: string }>,
  notes: string[],
): UpdateBaseContent {
  const recorded = lockFile?.baseSha256 ?? null;
  if (recorded !== null) {
    const rel = `${BASE_DIR}/${path}${BASE_SUFFIX}`;
    const snapshot = readGuarded(input.targetDir, rel);
    if (snapshot.kind === "bytes") {
      if (hashOf(snapshot.bytes) === recorded) {
        return { kind: "content", bytes: snapshot.bytes, from: "snapshot" };
      }
      notes.push(
        `${rel} does not match the lock's hash for ${path} -- only the hash is used`,
      );
    } else if (snapshot.kind === "unreadable") {
      notes.push(`${snapshot.reason} -- only the lock's hash is used`);
    } else {
      notes.push(
        `${rel} is missing, though the lock records a base for ${path} -- only the lock's hash is used`,
      );
    }
    const known = { sha256: recorded, from: "lock" } as const;
    return (
      fetchedContent(input, path, source, known, notes) ?? {
        kind: "hash",
        ...known,
      }
    );
  }
  const known = history.get(path);
  if (known === undefined) return { kind: "none" };
  const { blobs } = input.history;
  const blob = Object.hasOwn(blobs, known.sha256)
    ? blobs[known.sha256]
    : undefined;
  if (blob === undefined) {
    const hashed = { sha256: known.sha256, from: "history" } as const;
    return (
      fetchedContent(input, path, source, hashed, notes) ?? {
        kind: "hash",
        ...hashed,
      }
    );
  }
  return {
    kind: "content",
    bytes: Buffer.from(applyTokens(blob, input.tokens), "utf8"),
    from: "history",
  };
}

function emptySummary(): Record<UpdateAction, number> {
  return {
    take: 0,
    merge: 0,
    conflict: 0,
    review: 0,
    add: 0,
    delete: 0,
    rename: 0,
    current: 0,
    keep: 0,
    skip: 0,
  };
}

/** `entry` turned into a `review` the owner must settle, for `reason`. */
function asReview(entry: UpdateFileEntry, reason: string): UpdateFileEntry {
  return {
    path: entry.path,
    source: entry.source,
    action: "review",
    default: "skip",
    reason,
    baseSha256: entry.baseSha256,
    oursSha256: entry.oursSha256,
    theirsSha256: entry.theirsSha256,
    baseFrom: entry.baseFrom,
  };
}

/**
 * The base content {@link classifyProject} compares `path` against, with the
 * same precedence (a lock-verified `.groundwork/base/` snapshot, else the
 * history's blob with the tokens applied, else a matching `fetchedBase`
 * file), or `undefined` when only a hash or
 * nothing is known. Reads the snapshot; writes nothing.
 *
 * @example
 * ```ts
 * import { resolveBaseBytes } from "./update-classify.js";
 *
 * const base = resolveBaseBytes(input, "eslint.config.js");
 * if (base !== undefined) console.log(base.byteLength);
 * ```
 */
export function resolveBaseBytes(
  input: ClassifyProjectInput,
  path: string,
): Uint8Array | undefined {
  const lockFile = input.lock?.files.find((file) => file.path === path);
  const history = historyHashes(input);
  const source = sourceOf(path, lockFile, history, input.theirsSources);
  const base = resolveBase(input, path, source, lockFile, history, []);
  return base.kind === "content" ? base.bytes : undefined;
}

/**
 * Whether `--fetch-base` could help: some path the lock or the base
 * release's history records, and the lock does not skip, has a base known
 * only by its hash (no verified snapshot, no history blob) and was
 * installed from `baseVersion` itself -- the release a fetch would bring.
 * Ignores `input.fetchedBase`. Reads the snapshots; writes nothing.
 *
 * @example
 * ```ts
 * import { hasHashOnlyBase } from "./update-classify.js";
 *
 * if (hasHashOnlyBase(input)) console.log("a fetched base would help");
 * ```
 */
export function hasHashOnlyBase(input: BaseInput): boolean {
  const offline: BaseInput = { ...input, fetchedBase: undefined };
  const lockFiles = new Map((input.lock?.files ?? []).map((f) => [f.path, f]));
  const skip = new Set(input.lock?.skip ?? []);
  const history = historyHashes(input);
  return [...new Set([...lockFiles.keys(), ...history.keys()])].some((path) => {
    if (skip.has(path)) return false;
    const lockFile = lockFiles.get(path);
    const source = sourceOf(path, lockFile, history);
    return (
      releaseOf(input, source) === input.baseVersion &&
      resolveBase(offline, path, source, lockFile, history, []).kind === "hash"
    );
  });
}

/**
 * Classifies every file of the project with {@link classifyFile}: the union
 * of the lock's paths, the theirs tree's files and the base release's
 * history paths (core and each ledger pack). Applies the lock's `skip` list
 * and per-file status, and the migrations that fall between the base and the
 * running version (a renamed path is one `rename` entry carrying its new
 * path, which gets no entry of its own). Every `.json` path merges as JSON.
 * A file of a pack in `missingPacks` is never applied: anything but a
 * `skip`-default entry becomes `review`. In an adopted project, the three
 * files pack wiring merges into are `review` whenever the entry would change
 * them, and every other `merge` or `add` defaults to `ask`. A lock base whose
 * `.groundwork/base/` snapshot is missing, unreadable or mismatched falls
 * back to the lock's hash, with a note. A project path that is a symlink, a
 * directory or unreadable is `review` with a note naming it, never an error
 * and never read as absent. The template history keeps a blob for every
 * `__TOKEN__` file, so a tokenized file always gets a content base with the
 * tokens applied; a hash-only history base applies to untokenized files
 * only, compared against the project's bytes as-is. A base known only by
 * its hash (lock or history) takes `input.fetchedBase`'s file for that path
 * instead, when it was fetched for the release the file was installed from
 * and hashes to the recorded base as published or with the tokens applied;
 * one that does not match is ignored with a note. Writes nothing.
 *
 * @example
 * ```ts
 * import { buildTheirsTree } from "./theirs-tree.js";
 * import { classifyProject } from "./update-classify.js";
 *
 * const theirs = buildTheirsTree({ tokens, packNames: [] });
 * try {
 *   const { summary } = classifyProject({
 *     targetDir: "/path/to/project",
 *     lock,
 *     history,
 *     baseVersion: lock.baseVersion,
 *     ledgerPacks: [],
 *     tokens,
 *     theirsDir: theirs.dir,
 *     theirsSources: theirs.sources,
 *     migrations: [],
 *     runningVersion: "1.5.0",
 *     origin: "fresh",
 *   });
 *   console.log(summary.take);
 * } finally {
 *   theirs.cleanup();
 * }
 * ```
 */
export function classifyProject(
  input: ClassifyProjectInput,
): ClassifyProjectResult {
  const { lock, targetDir, theirsDir } = input;
  const notes: string[] = [];
  const lockFiles = new Map((lock?.files ?? []).map((f) => [f.path, f]));
  const skip = new Set(lock?.skip ?? []);
  const theirsFiles = treeFiles(theirsDir);
  const history = historyHashes(input);
  // Only renames matter here: a migration's `removedWiring` is loaded with
  // it but applied by the later staging step, not by the classification.
  const renames = new Map(
    applicableMigrations(
      input.migrations,
      input.baseVersion,
      input.runningVersion,
    ).flatMap(({ renames: list }) =>
      (list ?? []).map(({ from, to }) => [from, to] as const),
    ),
  );
  const paths = [
    ...new Set([
      ...lockFiles.keys(),
      ...theirsFiles,
      ...history.keys(),
      ...renames.keys(),
    ]),
  ].sort();

  const missing = new Set(input.missingPacks ?? []);
  const classified = paths.map((path): UpdateFileEntry => {
    const lockFile = lockFiles.get(path);
    const source = sourceOf(path, lockFile, history, input.theirsSources);
    const ours = readGuarded(targetDir, path);
    const entry = classifyFile({
      path,
      source,
      skipped: skip.has(path),
      base: resolveBase(input, path, source, lockFile, history, notes),
      ours: ours.kind === "bytes" ? ours.bytes : undefined,
      theirs: theirsFiles.has(path)
        ? readFileSync(join(theirsDir, path))
        : undefined,
      jsonMerge: path.endsWith(".json"),
      status: lockFile?.status,
      renamedTo: renames.get(path),
    });
    if (ours.kind === "unreadable") {
      notes.push(`${ours.reason} -- left for review`);
      return entry.action === "skip"
        ? entry
        : asReview(entry, `${ours.reason}; it was not read`);
    }
    if (entry.source.startsWith("pack:") && entry.default !== "skip") {
      const name = entry.source.slice("pack:".length);
      if (missing.has(name)) {
        return asReview(
          entry,
          `pack "${name}" no longer ships with this CLI; its files are left alone`,
        );
      }
    }
    if (input.origin !== "adopted") return entry;
    if (WIRING_TARGETS.has(path) && CHANGES.has(entry.action)) {
      return asReview(
        entry,
        "an adopted project owns this file; review the wiring change by hand",
      );
    }
    if (
      (entry.action === "merge" || entry.action === "add") &&
      entry.default === "apply"
    ) {
      return { ...entry, default: "ask" };
    }
    return entry;
  });

  // A rename's target is carried by the rename entry itself, never a second
  // entry an update could apply on its own.
  const targets = new Set(
    classified.flatMap((entry) =>
      entry.action === "rename" && entry.renamedTo !== undefined
        ? [entry.renamedTo]
        : [],
    ),
  );
  const entries = classified.filter((entry) => !targets.has(entry.path));
  const summary = emptySummary();
  for (const { action } of entries) summary[action] += 1;
  return { entries, summary, notes };
}
