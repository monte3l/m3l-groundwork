// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Which release a project was installed from ({@link resolveUpdateBase}),
 * and how that release's templates differ from the running CLI's
 * ({@link diffAgainstHistory}). Both only read: the project, the CLI's own
 * templates and the shipped template history. Every hash is of raw template
 * bytes, before token substitution, as the history records them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_FILE, readLock } from "./lock.js";
import type { Lock } from "./lock.js";
import {
  comparableManifestHash,
  compareVersions,
  projectEntry,
  sha256Hex,
  templateFileHashes,
} from "./pack-installation.js";
import type { LedgerEntry } from "./pack-installation.js";
import { listPackNames, loadPack, packManifestSha256 } from "./packs.js";
import { packHashesAt } from "./template-history.js";
import type { TemplateHistory } from "./template-history.js";
import { CliUsageError } from "./usage.js";

/** The fewest project files a release's hashes must match for inference to name it. */
const MIN_INFERENCE_MATCHES = 5;

const BASE_VERSION_ADVICE = "pass --base-version <x.y.z>";

/**
 * Where an update base came from: `--base-version`, the project's lock, or
 * inference over its files.
 *
 * @example
 * ```ts
 * const source: UpdateBaseSource = "lock";
 * ```
 */
type UpdateBaseSource = "flag" | "lock" | "inferred";

/**
 * The release a project was installed from, how it was determined, the
 * project's lock when it has a valid one, and any note on how the base was
 * chosen (an inference tie).
 *
 * @example
 * ```ts
 * const base: UpdateBase = { version: "1.4.0", source: "lock", lock: undefined, notes: [] };
 * ```
 */
export interface UpdateBase {
  readonly version: string;
  readonly source: UpdateBaseSource;
  readonly lock: Lock | undefined;
  readonly notes: readonly string[];
}

/**
 * {@link resolveUpdateBase}'s input: the project, the loaded template
 * history, the running CLI's version, the optional `--base-version`, and
 * the running CLI's `templates/core` (an inference candidate named by the
 * running version; absent or omitted, there is no such candidate).
 *
 * @example
 * ```ts
 * const input: ResolveUpdateBaseInput = { targetDir: "/p", history, runningVersion: "1.5.0" };
 * ```
 */
export interface ResolveUpdateBaseInput {
  readonly targetDir: string;
  readonly history: TemplateHistory;
  readonly runningVersion: string;
  readonly baseVersion?: string | undefined;
  readonly coreDir?: string | undefined;
}

function hasVersion(history: TemplateHistory, version: string): boolean {
  return Object.hasOwn(history.versions, version);
}

/** The history's versions, newest first (a non-plain version sorts as equal). */
function newestFirst(history: TemplateHistory): string[] {
  return Object.keys(history.versions).sort(
    (a, b) => compareVersions(b, a) ?? 0,
  );
}

/**
 * Whether `version` is a plain release at or above `runningVersion`: a
 * tarball's history never lists its own release, so such a base needs no
 * history entry.
 */
function atOrAboveRunning(version: string, runningVersion: string): boolean {
  const order = compareVersions(version, runningVersion);
  return order !== undefined && order >= 0;
}

/** One release inference weighs: its name and its raw `core` hashes. */
interface InferenceCandidate {
  readonly version: string;
  readonly core: Readonly<Record<string, string>>;
}

/**
 * The history's releases oldest first, then the running CLI's live
 * templates (when `coreDir` exists and the history does not already hold
 * `runningVersion`) as the newest.
 */
function inferenceCandidates(
  history: TemplateHistory,
  runningVersion: string,
  coreDir: string | undefined,
): InferenceCandidate[] {
  const candidates = newestFirst(history)
    .reverse()
    .map((version) => ({
      version,
      core: history.versions[version]?.core ?? {},
    }));
  if (
    coreDir !== undefined &&
    existsSync(coreDir) &&
    !hasVersion(history, runningVersion)
  ) {
    candidates.push({
      version: runningVersion,
      core: templateFileHashes(coreDir),
    });
  }
  return candidates;
}

/**
 * The oldest candidate whose `core` hashes match the most of the project's
 * regular files, plus a note when others tie with it, or `undefined` when
 * none matches at least {@link MIN_INFERENCE_MATCHES}. Ties go to the
 * oldest: over-reporting an update beats a false "up to date". A symlink, a
 * file behind a symlinked directory, or an unreadable file never matches.
 */
function inferBase(
  targetDir: string,
  candidates: readonly InferenceCandidate[],
): { version: string; notes: string[] } | undefined {
  const cache = new Map<string, string | undefined>();
  const projectHash = (rel: string): string | undefined => {
    if (cache.has(rel)) return cache.get(rel);
    let hash: string | undefined;
    if (projectEntry(targetDir, rel).kind === "file") {
      try {
        hash = sha256Hex(readFileSync(join(targetDir, ...rel.split("/"))));
      } catch {
        // Inference is evidence only: a file this process cannot read is
        // simply not a match, and a refusal follows if too few match.
        hash = undefined;
      }
    }
    cache.set(rel, hash);
    return hash;
  };

  const scored = candidates.map(({ version, core }) => ({
    version,
    matches: Object.entries(core).filter(
      ([rel, hash]) => projectHash(rel) === hash,
    ).length,
  }));
  const top = Math.max(0, ...scored.map(({ matches }) => matches));
  if (top < MIN_INFERENCE_MATCHES) return undefined;
  const tied = scored
    .filter(({ matches }) => matches === top)
    .map(({ version }) => version);
  const [oldest] = tied;
  if (oldest === undefined) return undefined;
  const notes =
    tied.length > 1
      ? [
          `inference tie: ${tied.join(", ")} each match ${String(top)} project file(s) -- took the oldest, ${oldest}; ${BASE_VERSION_ADVICE} to choose another`,
        ]
      : [];
  return { version: oldest, notes };
}

/** `readLock`'s note without its trailing "ignored": here a bad lock refuses. */
function lockProblem(note: string): string {
  return note.replace(/ -- (?:the lock was )?ignored$/, "");
}

/**
 * Resolves the release `targetDir` was installed from: `baseVersion` (the
 * `--base-version` flag) when given, else the lock's `baseVersion`, else the
 * candidate whose `core` hashes match the most project files by raw bytes:
 * every history release, plus the live templates under `coreDir` named
 * `runningVersion` (ties go to the oldest, with a note; at least five must
 * match). A flag or lock version at or above `runningVersion` need not be in
 * the history: a tarball's history never lists its own release.
 *
 * @throws `CliUsageError` when the lock is invalid or unreadable (even with
 * a flag: its skip list feeds the comparison), when the flag's or the lock's
 * version is below `runningVersion` and not one the history records, when
 * the lock was written by a
 * CLI newer than `runningVersion` (naming the `npx` command for that
 * version), or when inference finds no release (asking for
 * `--base-version <x.y.z>`).
 *
 * @example
 * ```ts
 * import { loadTemplateHistory } from "./template-history.js";
 * const loaded = loadTemplateHistory();
 * if ("history" in loaded) {
 *   const base = resolveUpdateBase({ targetDir: "/p", history: loaded.history, runningVersion: "1.5.0" });
 *   console.log(`base ${base.version} (${base.source})`);
 * }
 * ```
 */
export function resolveUpdateBase(input: ResolveUpdateBaseInput): UpdateBase {
  const { targetDir, history, runningVersion, baseVersion, coreDir } = input;
  const read = readLock(targetDir);
  if ("note" in read) {
    throw new CliUsageError(
      `the project's lock cannot be used (${lockProblem(read.note)}) -- repair or delete ${LOCK_FILE}`,
    );
  }
  const lock = "lock" in read ? read.lock : undefined;

  if (baseVersion !== undefined) {
    if (
      !atOrAboveRunning(baseVersion, runningVersion) &&
      !hasVersion(history, baseVersion)
    ) {
      throw new CliUsageError(
        `--base-version ${baseVersion} is not a release this CLI's template history records (known: ${newestFirst(history).join(", ") || "none"})`,
      );
    }
    return { version: baseVersion, source: "flag", lock, notes: [] };
  }

  if (lock !== undefined) {
    const version = lock.baseVersion;
    const order = compareVersions(version, runningVersion);
    if (order !== undefined && order > 0) {
      throw new CliUsageError(
        `${LOCK_FILE} records base ${version}, newer than this CLI (${runningVersion}) -- run npx @monte3l/groundwork@${version} instead`,
      );
    }
    if (
      !atOrAboveRunning(version, runningVersion) &&
      !hasVersion(history, version)
    ) {
      throw new CliUsageError(
        `${LOCK_FILE} records base ${version}, which this CLI's template history does not hold -- ${BASE_VERSION_ADVICE}`,
      );
    }
    return { version, source: "lock", lock, notes: [] };
  }

  const inferred = inferBase(
    targetDir,
    inferenceCandidates(history, runningVersion, coreDir),
  );
  if (inferred === undefined) {
    throw new CliUsageError(
      `cannot tell which release this project was installed from (no ${LOCK_FILE}, and fewer than ${String(MIN_INFERENCE_MATCHES)} files match any recorded release) -- ${BASE_VERSION_ADVICE}`,
    );
  }
  return {
    version: inferred.version,
    source: "inferred",
    lock,
    notes: inferred.notes,
  };
}

/**
 * The paths a template comparison reports, sorted: changed upstream, added
 * upstream, and removed upstream.
 *
 * @example
 * ```ts
 * const diff: FileDiff = { changed: ["package.json"], added: [], removed: [] };
 * ```
 */
export interface FileDiff {
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * One installed pack's comparison: its files, and whether its manifest
 * changed.
 *
 * @example
 * ```ts
 * const pack: PackDiff = { name: "quality", changed: [], added: ["x"], removed: [], manifestChanged: false };
 * ```
 */
interface PackDiff extends FileDiff {
  readonly name: string;
  readonly manifestChanged: boolean;
}

/**
 * {@link diffAgainstHistory}'s result: the core comparison, one entry per
 * ledger pack that could be compared, and a note per one that could not.
 *
 * @example
 * ```ts
 * const result: HistoryDiff = { core: { changed: [], added: [], removed: [] }, packs: [], notes: [] };
 * ```
 */
export interface HistoryDiff {
  readonly core: FileDiff;
  readonly packs: readonly PackDiff[];
  readonly notes: readonly string[];
}

/**
 * {@link diffAgainstHistory}'s input. `coreDir` and `packsRoot` are the
 * running CLI's `templates/core` and `templates/packs`; `ledger` is
 * `readInstalledPacksLedger(targetDir).entries`.
 *
 * @example
 * ```ts
 * const input: DiffAgainstHistoryInput = {
 *   targetDir: "/p", history, baseVersion: "1.4.0", coreDir, packsRoot, ledger: [],
 * };
 * ```
 */
export interface DiffAgainstHistoryInput {
  readonly targetDir: string;
  readonly history: TemplateHistory;
  readonly baseVersion: string;
  readonly coreDir: string;
  readonly packsRoot: string;
  readonly lock?: Lock | undefined;
  readonly ledger: readonly LedgerEntry[];
  /**
   * `false` skips the core comparison (an empty core diff, and `baseVersion`
   * need not be in the history): the base is at or above the running CLI.
   * Default `true`.
   */
  readonly compareCore?: boolean | undefined;
}

/** Whether `path` is on the lock's skip list, or under a skipped directory. */
function isSkipped(skip: readonly string[], path: string): boolean {
  return skip.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/** The paths every count leaves out: the skip list, and declined or removed lock entries. */
function excludedBy(lock: Lock | undefined): (path: string) => boolean {
  if (lock === undefined) return () => false;
  const dropped = new Set(
    lock.files
      .filter((file) => file.status === "declined" || file.status === "removed")
      .map((file) => file.path),
  );
  return (path) => dropped.has(path) || isSkipped(lock.skip, path);
}

/** `recorded` (the base release) against `current` (the running CLI), unfiltered. */
function compareHashes(
  recorded: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
  keep: (path: string) => boolean,
  keepRemoved: (path: string) => boolean,
): FileDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [path, hash] of Object.entries(current)) {
    if (!keep(path)) continue;
    if (!Object.hasOwn(recorded, path)) added.push(path);
    else if (recorded[path] !== hash) changed.push(path);
  }
  for (const path of Object.keys(recorded)) {
    if (!Object.hasOwn(current, path) && keep(path) && keepRemoved(path)) {
      removed.push(path);
    }
  }
  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
  };
}

/**
 * Compares the templates recorded at `baseVersion` against the running
 * CLI's, by raw-bytes sha256 keyed by project path (an escaped dotfile name
 * restored, no token substitution). Paths on the lock's skip list, and lock
 * entries `declined` or `removed`, are left out of every count. A core path
 * removed upstream counts only when the lock lists it `installed` or `kept`
 * -- or, with no lock, when it is a regular file in the project. An absent
 * `coreDir` is compared as an empty tree. `compareCore: false` skips the
 * core comparison altogether.
 *
 * Each ledger pack is compared at its own ledger `cliVersion`, else at
 * `baseVersion`; a pack the running CLI no longer ships, or one the history
 * lacks at that version, is a note instead. Its manifest is compared in the
 * canonical form the ledger records (`packManifestSha256`); a recorded
 * manifest whose text the history lacks or cannot parse is a note, never a
 * change.
 *
 * @throws `Error` when the core is compared and the history does not hold
 * `baseVersion` (resolve it with {@link resolveUpdateBase} first), or the
 * raw `fs` error of a failed read of the CLI's own templates.
 *
 * @example
 * ```ts
 * const diff = diffAgainstHistory({
 *   targetDir: "/p", history, baseVersion: "1.4.0", coreDir, packsRoot, ledger: [],
 * });
 * console.log(`${String(diff.core.changed.length)} file(s) changed upstream`);
 * ```
 */
export function diffAgainstHistory(
  input: DiffAgainstHistoryInput,
): HistoryDiff {
  const { targetDir, history, baseVersion, coreDir, packsRoot, lock, ledger } =
    input;
  const excluded = excludedBy(lock);
  const keep = (path: string): boolean => !excluded(path);
  let core: FileDiff = { changed: [], added: [], removed: [] };
  if (input.compareCore !== false) {
    const entry = hasVersion(history, baseVersion)
      ? history.versions[baseVersion]
      : undefined;
    if (entry === undefined) {
      throw new Error(`the template history does not hold ${baseVersion}`);
    }
    const tracked = new Set(
      (lock?.files ?? [])
        .filter((file) => file.status === "installed" || file.status === "kept")
        .map((file) => file.path),
    );
    core = compareHashes(
      entry.core,
      // An absent `coreDir` is an empty tree: `runCheckUpdate` refuses a CLI
      // install without one, so only a caller's own fixture (comparing packs
      // alone) reaches this.
      existsSync(coreDir) ? templateFileHashes(coreDir) : {},
      keep,
      lock === undefined
        ? (path) => projectEntry(targetDir, path).kind === "file"
        : (path) => tracked.has(path),
    );
  }

  const packs: PackDiff[] = [];
  const notes: string[] = [];
  const shipped = ledger.length === 0 ? [] : listPackNames(packsRoot);
  for (const { name, cliVersion } of ledger) {
    if (!shipped.includes(name)) {
      notes.push(`pack "${name}" is not shipped by this CLI -- not compared`);
      continue;
    }
    const version = cliVersion ?? baseVersion;
    const recorded = packHashesAt(history, version, name);
    if (recorded === undefined) {
      notes.push(
        `pack "${name}" is not recorded at ${version} in the template history -- not compared`,
      );
      continue;
    }
    const pack = loadPack(name, packsRoot);
    const manifest = comparableManifestHash(history, recorded.manifest);
    if (manifest.kind === "missing") {
      notes.push(
        `pack "${name}"'s recorded pack.json is not in the template history -- its manifest was not compared`,
      );
    } else if (manifest.kind === "unparsable") {
      notes.push(
        `pack "${name}": ${manifest.reason} -- its manifest was not compared`,
      );
    }
    packs.push({
      name,
      ...compareHashes(
        recorded.files,
        templateFileHashes(pack.filesDir),
        keep,
        () => true,
      ),
      manifestChanged:
        manifest.kind === "hash" &&
        manifest.hash !== packManifestSha256(pack.manifest),
    });
  }
  return {
    core,
    packs: packs.sort((a, b) => (a.name < b.name ? -1 : 1)),
    notes,
  };
}
