// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `m3l-groundwork <dir> --update [--base-version <x.y.z>]`: offline, stages
 * an update from the project's release to the running CLI's for
 * `/customize update` to apply. The CLI never applies it: it writes nothing
 * outside `<dir>/.groundwork/update/` -- the versions each file needs
 * (`files/`, `merged/`, `base/`), the current pack manifests (`packs/`), the
 * `/customize` payload (`customize/`), the proposed lock (`lock-next.json`)
 * and, last, `plan.json`. Every refusal happens before the first write.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckUpdateDeps } from "./check-update.js";
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_FILE_NAMES,
} from "./customize-paths.js";
import { assertDirectoryComponent, FsGuardRefusal } from "./fs-guard.js";
import { gitMergeFile, gitVersion } from "./git.js";
import { resolveCliVersion } from "./inventory.js";
import { buildLock, LOCK_FILE, serializeLock } from "./lock.js";
import type { Lock, LockFile } from "./lock.js";
import { isRecord } from "./merge-json.js";
import { mergeJsonText } from "./merge-json3.js";
import { applicableMigrations, loadMigrations } from "./migrations.js";
import {
  isPackOutdated,
  projectNameOf,
  readInstalledPacksLedger,
  sha256Hex,
  templateFileHashes,
} from "./pack-installation.js";
import type { LedgerEntry } from "./pack-installation.js";
import { diffPackWiring } from "./pack-wiring-diff.js";
import type { PackWiringDiff } from "./pack-wiring-diff.js";
import { loadPack, serializePackManifest } from "./packs.js";
import type { PackManifest, PackWiring } from "./packs.js";
import { inspectCustomizeSkill } from "./plugin.js";
import {
  findStagedPathCollision,
  isIncompleteStagingError,
  prepareStaging,
  stageAtomically,
  stagedNameFor,
  writeStagedBytes,
} from "./staging.js";
import type { StagingTarget } from "./staging.js";
import { errnoCode, isAbsentError } from "./survey/internal/read-guard.js";
import { packHashesAt } from "./template-history.js";
import type { TemplateHistory } from "./template-history.js";
import { buildTheirsTree } from "./theirs-tree.js";
import type { FileSource, TheirsTree } from "./theirs-tree.js";
import { buildTokens } from "./tokens.js";
import { resolveUpdateBase } from "./update-base.js";
import {
  classifyProject,
  readGuarded,
  resolveBaseBytes,
} from "./update-classify.js";
import type {
  ClassifyProjectInput,
  UpdateFileEntry,
} from "./update-classify.js";
import {
  assertUpdatableOrigin,
  assertUpdateTarget,
  escapeInline,
  formatUpdateCounts,
  installedCoreDir,
  isUpdateAvailable,
  ledgerPackVersions,
  messageOf,
  requireTemplateHistory,
  updateOrigin,
} from "./update-common.js";
import { CliUsageError, USAGE } from "./usage.js";
import { assertUpdateWriteScope } from "./write-scope.js";

/**
 * `--update`'s options: the project directory, and the `--base-version`
 * override when given.
 *
 * @example
 * ```ts
 * const options: UpdateOptions = { targetDir: "/path/to/project", baseVersion: "1.4.0" };
 * ```
 */
export interface UpdateOptions {
  readonly targetDir: string;
  readonly baseVersion?: string | undefined;
}

/** The project-relative staging directory, and its name under `.groundwork/`. */
const STAGED_UPDATE_DIR = ".groundwork/update";
const UPDATE_DIR_NAME = "update";
const PLAN_FILE = "plan.json";
const LOCK_NEXT_FILE = "lock-next.json";
/** `lock-next.json`'s `updatedAt` with no previous lock: `/customize update` stamps the real time. */
const EPOCH = "1970-01-01T00:00:00.000Z";
/** Opens every packaging-defect message. */
const WHAT = "cannot stage an update";
const GIT_UNAVAILABLE_NOTE =
  "git is not available -- text files changed on both sides need a manual merge";

/** Where an entry's versions are staged, relative to `.groundwork/update/`. */
interface StagedLocations {
  readonly theirs?: string;
  readonly merged?: string;
  readonly base?: string;
}

type PlanFileEntry = UpdateFileEntry & {
  readonly staged: StagedLocations;
  readonly conflicts?: number;
};

/** One file to stage: the path it concerns, its staged name, its bytes. */
interface StageItem {
  readonly path: string;
  readonly staged: string;
  readonly bytes: Uint8Array;
}

/** One planned entry, what it stages, and theirs (for `lock-next.json`). */
interface StagedEntry {
  readonly entry: PlanFileEntry;
  readonly items: readonly StageItem[];
  readonly theirsPath: string;
  readonly theirs: Uint8Array | undefined;
}

/** What every entry's staging needs. */
interface EntryContext {
  readonly input: ClassifyProjectInput;
  readonly baseVersion: string;
  readonly runningVersion: string;
  readonly gitAvailable: boolean;
  readonly notes: string[];
}

/** `path`'s bytes, or `undefined` when it is absent. */
function readIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isAbsentError(error)) return undefined;
    throw new Error(
      `${WHAT}: could not read ${path} (${errnoCode(error) ?? "unknown error"})`,
      { cause: error },
    );
  }
}

/** Refuses a symlinked or non-directory `.groundwork` or `.groundwork/update`, before any write. */
function assertStagingDirs(targetDir: string): void {
  const advice = "remove or rename it, then re-run with --update";
  for (const path of [
    join(targetDir, ".groundwork"),
    join(targetDir, STAGED_UPDATE_DIR),
  ]) {
    try {
      assertDirectoryComponent(path, advice);
    } catch (error) {
      // fs-guard's refusals (a symlink, a non-directory) are facts about the
      // project, so a usage error; a failure to inspect stays what it is.
      if (error instanceof FsGuardRefusal) {
        throw new CliUsageError(`${error.message}\n\n${USAGE}`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

/** UTF-8 text of every buffer, or `undefined` when any is not valid UTF-8. */
function decodeAll(
  buffers: readonly Uint8Array[],
): readonly string[] | undefined {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return buffers.map((bytes) => decoder.decode(bytes));
  } catch {
    // Not UTF-8: the caller turns the entry into a review.
    return undefined;
  }
}

/** Stages one entry's versions per its action (see {@link runUpdate}). */
function stageEntry(
  entry: UpdateFileEntry,
  theirsDir: string,
  ctx: EntryContext,
): StagedEntry {
  const theirsPath =
    entry.action === "rename" && entry.renamedTo !== undefined
      ? entry.renamedTo
      : entry.path;
  const theirs = readIfPresent(join(theirsDir, theirsPath));
  const items: StageItem[] = [];
  const stage = (
    dir: "files" | "merged" | "base",
    bytes: Uint8Array,
  ): string => {
    const staged = `${dir}/${stagedNameFor(theirsPath)}`;
    items.push({ path: theirsPath, staged, bytes });
    return staged;
  };
  const done = (planned: PlanFileEntry): StagedEntry => ({
    entry: planned,
    items,
    theirsPath,
    theirs,
  });
  /** Theirs under files/ and, when the base came from the history, base/. */
  const forReview = (
    planned: UpdateFileEntry & { readonly conflicts?: number },
    base: Uint8Array | undefined,
    merged?: Uint8Array,
  ): StagedEntry => {
    const historyBase =
      entry.baseFrom === "history" && base !== undefined
        ? stage("base", base)
        : undefined;
    const staged: StagedLocations = {
      ...(theirs === undefined ? {} : { theirs: stage("files", theirs) }),
      ...(merged === undefined ? {} : { merged: stage("merged", merged) }),
      ...(historyBase === undefined ? {} : { base: historyBase }),
    };
    return done({ ...planned, staged });
  };
  const asReview = (reason: string, base: Uint8Array | undefined) =>
    forReview(
      { ...entry, action: "review", default: "skip", reason },
      base,
      undefined,
    );

  switch (entry.action) {
    case "current":
    case "keep":
    case "skip":
    case "delete":
      return done({ ...entry, staged: {} });
    case "take":
    case "add":
    case "rename": {
      if (theirs === undefined) {
        throw new Error(
          `${WHAT}: this CLI's templates have no ${theirsPath}, though ${entry.path} is planned as ${entry.action}`,
        );
      }
      return done({ ...entry, staged: { theirs: stage("files", theirs) } });
    }
    case "conflict":
    case "review":
      return forReview(entry, resolveBaseBytes(ctx.input, entry.path));
    case "merge":
      break;
    default: {
      const exhaustive: never = entry.action;
      throw new Error(`unhandled update action ${String(exhaustive)}`);
    }
  }

  const base = resolveBaseBytes(ctx.input, entry.path);
  // The same guarded read classify used: the file may have changed since.
  const read = readGuarded(ctx.input.targetDir, entry.path);
  if (read.kind === "unreadable") {
    ctx.notes.push(`${read.reason} -- ${entry.path} is left for review`);
    return asReview(read.reason, base);
  }
  const ours = read.kind === "bytes" ? read.bytes : undefined;
  if (theirs === undefined || base === undefined || ours === undefined) {
    return asReview(
      "the base, local or new version of this file could not be read for a merge",
      base,
    );
  }
  const texts = decodeAll([base, ours, theirs]);
  const [baseText, oursText, theirsText] = texts ?? [];
  if (
    baseText === undefined ||
    oursText === undefined ||
    theirsText === undefined
  ) {
    return asReview("both sides changed it, and it is not UTF-8 text", base);
  }
  if (entry.path.endsWith(".json")) {
    const merged = mergeJsonText(baseText, oursText, theirsText);
    if ("unmergeable" in merged) {
      return asReview(
        `both sides changed it, and it cannot be merged as JSON: ${merged.unmergeable}`,
        base,
      );
    }
    if (merged.conflicts.length > 0) {
      return forReview(
        {
          ...entry,
          action: "conflict",
          default: "ask",
          reason: `both sides changed ${merged.conflicts.join(", ")}`,
        },
        base,
      );
    }
    return forReview(entry, base, Buffer.from(merged.text, "utf8"));
  }
  if (!ctx.gitAvailable) {
    ctx.notes.push(GIT_UNAVAILABLE_NOTE);
    return asReview(
      "both sides changed it, and git is not available to merge it",
      base,
    );
  }
  const merged = gitMergeFile({
    ours: oursText,
    base: baseText,
    theirs: theirsText,
    baseVersion: ctx.baseVersion,
    cliVersion: ctx.runningVersion,
  });
  if ("unavailable" in merged) {
    ctx.notes.push(
      `${entry.path} could not be merged (${merged.unavailable}) -- it needs a manual merge`,
    );
    return asReview(
      `both sides changed it, and it could not be merged: ${merged.unavailable}`,
      base,
    );
  }
  const mergedBytes = Buffer.from(merged.text, "utf8");
  if (merged.conflicts > 0) {
    return forReview(
      {
        ...entry,
        action: "conflict",
        default: "ask",
        reason: `both sides changed the same lines (${String(merged.conflicts)} conflict(s))`,
        conflicts: merged.conflicts,
      },
      base,
      mergedBytes,
    );
  }
  // A clean merge stages only merged/ (and base/ from the history).
  const historyBase =
    entry.baseFrom === "history" ? stage("base", base) : undefined;
  return done({
    ...entry,
    staged: {
      merged: stage("merged", mergedBytes),
      ...(historyBase === undefined ? {} : { base: historyBase }),
    },
  });
}

/**
 * The lock after every default is accepted: see {@link runUpdate}. Only an
 * `apply`-default entry (and a `current` one, already theirs) advances; any
 * other keeps its previous record or, with none, gets one carrying its OLD
 * base (`baseHashOf`), so a later run still sees the update it left alone.
 * `updatedAt` stays the previous lock's (or the epoch) so the proposal is
 * deterministic; `/customize update` stamps the real time.
 */
function nextLock(
  previous: Lock | undefined,
  staged: readonly StagedEntry[],
  settings: {
    readonly origin: Lock["origin"];
    readonly tokens: Lock["tokens"];
    readonly runningVersion: string;
    readonly sources: ReadonlyMap<string, FileSource>;
    readonly baseHashOf: (path: string) => string | undefined;
  },
): Lock {
  const files = new Map<string, LockFile>(
    (previous?.files ?? []).map((file) => [file.path, file]),
  );
  const install = (
    path: string,
    source: string,
    theirs: Uint8Array | undefined,
  ): void => {
    if (theirs === undefined) return;
    files.set(path, {
      path,
      source,
      baseSha256: sha256Hex(Buffer.from(theirs)),
      status: "installed",
    });
  };
  for (const { entry, theirsPath, theirs } of staged) {
    const sourceOf = (path: string): string =>
      files.get(path)?.source ?? settings.sources.get(path) ?? entry.source;
    /** Left alone: the previous record stays; with none, the OLD base is recorded. */
    const keepOld = (): void => {
      if (files.has(entry.path)) return;
      const baseSha256 = settings.baseHashOf(entry.path);
      if (baseSha256 === undefined) return;
      files.set(entry.path, {
        path: entry.path,
        source: sourceOf(entry.path),
        baseSha256,
        status: "installed",
      });
    };
    if (entry.default !== "apply" && entry.action !== "current") {
      keepOld();
      continue;
    }
    switch (entry.action) {
      case "delete":
        files.delete(entry.path);
        break;
      case "rename": {
        const source = settings.sources.get(theirsPath) ?? sourceOf(entry.path);
        files.delete(entry.path);
        install(theirsPath, source, theirs);
        break;
      }
      case "take":
      case "add":
      case "merge":
      case "current":
        install(entry.path, sourceOf(entry.path), theirs);
        break;
      case "keep":
      case "skip":
      case "review":
      case "conflict":
        keepOld();
        break;
      default: {
        const exhaustive: never = entry.action;
        throw new Error(`unhandled update action ${String(exhaustive)}`);
      }
    }
  }
  return buildLock({
    baseVersion: settings.runningVersion,
    origin: settings.origin,
    tokens: settings.tokens,
    via: "update",
    updatedAt: previous?.updatedAt ?? EPOCH,
    skip: previous?.skip ?? [],
    files: [...files.values()],
  });
}

/** One ledger pack in the plan. */
interface PlannedPack {
  readonly name: string;
  readonly ledgerVersion: string | null;
  readonly outdated: boolean;
  readonly wiring: PackWiringDiff;
}

const NO_WIRING_CHANGE: PackWiringDiff = {
  added: [],
  removed: [],
  changed: [],
};

function isStringKeyedRecordOf(
  value: unknown,
  check: (item: unknown) => boolean,
): boolean {
  return isRecord(value) && Object.values(value).every(check);
}

/** Whether `value` has the shape {@link diffPackWiring} walks. */
function isPackWiring(value: unknown): value is PackWiring {
  if (!isRecord(value)) return false;
  const hookEntry = (entry: unknown): boolean =>
    isRecord(entry) &&
    Array.isArray(entry["hooks"]) &&
    (entry["hooks"] as readonly unknown[]).every(
      (hook) => isRecord(hook) && typeof hook["command"] === "string",
    );
  const topLevel = value["settingsTopLevel"];
  return (
    isStringKeyedRecordOf(
      value["settings"],
      (entries) =>
        Array.isArray(entries) &&
        (entries as readonly unknown[]).every(hookEntry),
    ) &&
    (topLevel === undefined || isRecord(topLevel)) &&
    isStringKeyedRecordOf(
      value["packageScripts"],
      (script) => typeof script === "string",
    ) &&
    Array.isArray(value["verifySteps"]) &&
    (value["verifySteps"] as readonly unknown[]).every(
      (step) => isRecord(step) && typeof step["id"] === "string",
    )
  );
}

/**
 * The wiring diff from the manifest the history records for `name` at
 * `version` to `current`; no change, with a note, when it is not recorded
 * or not a readable manifest.
 */
function wiringDiffOf(
  history: TemplateHistory,
  version: string,
  current: PackManifest,
  targetDir: string,
  notes: string[],
): PackWiringDiff {
  const { name } = current;
  const recorded = packHashesAt(history, version, name);
  const blob =
    recorded !== undefined && Object.hasOwn(history.blobs, recorded.manifest)
      ? history.blobs[recorded.manifest]
      : undefined;
  if (blob === undefined) {
    notes.push(
      `pack "${name}": the template history has no manifest for ${version} -- its wiring changes are not planned`,
    );
    return NO_WIRING_CHANGE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    // A damaged blob is missing data, reported as a note just below.
    parsed = undefined;
  }
  const wiring = isRecord(parsed) ? parsed["wiring"] : undefined;
  if (!isPackWiring(wiring)) {
    notes.push(
      `pack "${name}": the manifest recorded for ${version} is not readable -- its wiring changes are not planned`,
    );
    return NO_WIRING_CHANGE;
  }
  return diffPackWiring({ ...current, wiring }, current, targetDir);
}

/** Plans (and stages the current manifest of) each ledger pack this CLI still ships. */
function planPacks(
  entries: readonly LedgerEntry[],
  context: {
    readonly missing: ReadonlySet<string>;
    readonly history: TemplateHistory;
    readonly baseVersion: string;
    readonly runningVersion: string;
    readonly targetDir: string;
    readonly notes: string[];
  },
): { readonly packs: PlannedPack[]; readonly items: StageItem[] } {
  const packs: PlannedPack[] = [];
  const items: StageItem[] = [];
  const shipped = [...entries]
    .filter(({ name }) => !context.missing.has(name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of shipped) {
    const { manifest, filesDir } = loadPack(entry.name);
    const text = serializePackManifest(manifest);
    if (text === undefined) {
      throw new Error(`${WHAT}: pack "${entry.name}"'s manifest is not JSON`);
    }
    items.push({
      path: `templates/packs/${entry.name}/pack.json`,
      staged: `packs/${entry.name}/${stagedNameFor("pack.json")}`,
      bytes: Buffer.from(text, "utf8"),
    });
    const outdated = isPackOutdated(
      entry,
      { manifestSha256: sha256Hex(text), files: templateFileHashes(filesDir) },
      context.history,
      context.runningVersion,
    );
    packs.push({
      name: entry.name,
      ledgerVersion: entry.cliVersion ?? null,
      outdated,
      wiring: outdated
        ? wiringDiffOf(
            context.history,
            entry.cliVersion ?? context.baseVersion,
            manifest,
            context.targetDir,
            context.notes,
          )
        : NO_WIRING_CHANGE,
    });
  }
  return { packs, items };
}

/** The CLI's `/customize` payload, from the theirs tree. */
function customizeItems(theirsDir: string): StageItem[] {
  return CUSTOMIZE_SKILL_FILE_NAMES.flatMap((name) => {
    const path = [...CLAUDE_DEST_SEGMENTS, name].join("/");
    const bytes = readIfPresent(join(theirsDir, path));
    return bytes === undefined
      ? []
      : [{ path, staged: `customize/${stagedNameFor(name)}`, bytes }];
  });
}

/**
 * The error for a staging failure: the root failure's message, that any
 * previous `.groundwork/update/` and the rest of the project were left as
 * they were, and the re-run. Looks through `staging.ts`'s adopt-flavoured
 * "is incomplete" wrapper; an `AssertionError` (a bug) stays itself, an
 * `AggregateError` (the restore failed too) stays one.
 */
function stagingFailure(cause: unknown): Error {
  if (cause instanceof assert.AssertionError) return cause;
  if (cause instanceof AggregateError) {
    // Already ends with --update's own advice (`target.rerun`).
    return new AggregateError(
      cause.errors,
      `could not stage the update into ${STAGED_UPDATE_DIR}/: ${cause.message}`,
      { cause },
    );
  }
  const root = isIncompleteStagingError(cause) ? cause.cause : cause;
  return new Error(
    `could not stage the update into ${STAGED_UPDATE_DIR}/ (${messageOf(root)}); any previous staging there and the rest of the project were left as they were -- fix the cause and re-run with --update`,
    { cause: root },
  );
}

/** The `next:` line: `/customize update`, after refreshing a stale `/customize` copy. */
function nextStep(skill: ReturnType<typeof inspectCustomizeSkill>): string {
  return skill === "current"
    ? "next: run /customize update"
    : `next: update the groundwork plugin (or replace .claude/skills/customize/ with the copy staged in ${STAGED_UPDATE_DIR}/customize/, dropping the .staged suffix), then run /customize update`;
}

/** Everything staged, and the lines printed once it is. */
interface StagedUpdate {
  readonly lines: readonly string[];
}

/**
 * Stages an update of `options.targetDir` from its release (the lock's, the
 * `--base-version` override, or inferred) to the running CLI's, under
 * `<targetDir>/.groundwork/update/`, and returns the exit code 0. Nothing
 * is printed until everything is computed. Prints
 * `already up to date (base X (<source>), CLI Y)` and writes nothing -- an
 * earlier `.groundwork/update/` is left untouched -- when no file would
 * change and no ledger pack is outdated. Otherwise stages, through one
 * atomic swap (`stageAtomically`): `files/<path>.staged` (theirs, for a
 * take, add, rename -- at the new path --, conflict, or review whose new
 * version exists), `merged/<path>.staged` (a clean JSON or `git merge-file`
 * merge, or a text conflict's diff3 markers), `base/<path>.staged` (for a
 * merge, conflict or review whose base came from the template history),
 * `packs/<name>/pack.json.staged` per ledger pack this CLI still ships,
 * `customize/<name>.staged` (the CLI's `/customize` payload),
 * `lock-next.json` (the lock once every default is accepted) and, last,
 * `plan.json` (`kind: "m3l-groundwork/update-plan"`). A text merge with
 * conflicts becomes `conflict`; one git cannot run for becomes `review`
 * with a note. Two runs on an unchanged project stage byte-identical files
 * and a plan that differs only in `generatedAt`. Then prints
 * `staged update <base> -> <cli>: <counts>`, the `next:` step and any
 * `note:` lines.
 *
 * @throws `CliUsageError` (exit 2), with nothing written, when the target is
 * missing or not a directory, `.groundwork` or `.groundwork/update` is a
 * symlink or not a directory, the project holds an unfinished adopt run or
 * is of unknown origin with no lock, or the base cannot be resolved (an
 * invalid lock, a lock newer than the CLI, no inferable release). A plain
 * `Error` (exit 1) when the template history, the migrations or the CLI's
 * own templates cannot be loaded, or when staging fails -- any previous
 * `.groundwork/update/` then survives, with the failure as `cause` (an
 * `AggregateError` when restoring it failed too).
 *
 * @example
 * ```ts
 * import process from "node:process";
 * process.exitCode = runUpdate({ targetDir: "/path/to/project" });
 * ```
 */
export function runUpdate(
  options: UpdateOptions,
  deps: CheckUpdateDeps = {},
): number {
  const { targetDir } = options;
  assertUpdateTarget(
    targetDir,
    "--update",
    "a bootstrapped or adopted project to stage an update for",
  );
  assertStagingDirs(targetDir);
  assertUpdatableOrigin(targetDir);
  const { history } = requireTemplateHistory(deps.history, WHAT);
  const runningVersion = deps.runningVersion ?? resolveCliVersion();
  const coreDir = deps.coreDir ?? installedCoreDir(WHAT);
  const base = resolveUpdateBase({
    targetDir,
    history,
    runningVersion,
    baseVersion: options.baseVersion,
    coreDir,
  });
  const loadedMigrations = loadMigrations(deps.migrationsPath);
  if ("note" in loadedMigrations) {
    throw new Error(
      `${WHAT}: ${loadedMigrations.note} -- this CLI install is damaged; reinstall @monte3l/groundwork`,
    );
  }
  const ledger = readInstalledPacksLedger(targetDir);
  const tokens = base.lock?.tokens ?? buildTokens(projectNameOf(targetDir));
  let theirs: TheirsTree;
  try {
    theirs = (deps.buildTheirs ?? buildTheirsTree)({
      tokens,
      packNames: ledger.names,
      coreDir,
    });
  } catch (cause) {
    throw new Error(
      `${WHAT}: this CLI's templates could not be laid out (${messageOf(cause)})`,
      { cause },
    );
  }
  const notes: string[] = [...base.notes, ...ledger.undetermined];
  let staged: StagedUpdate;
  let failed = false;
  try {
    staged = stageUpdate(targetDir, {
      history,
      runningVersion,
      base,
      migrations: loadedMigrations.migrations,
      ledger: ledger.entries,
      ledgerNames: ledger.names,
      tokens,
      theirs,
      notes,
      classify: deps.classify ?? classifyProject,
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      theirs.cleanup();
    } catch (error) {
      // Best effort: a leftover temp directory never replaces the staging
      // outcome; it is reported so it can be removed -- on stderr when
      // staging failed, since no note is printed then.
      const leftover = `could not remove the temporary directory ${theirs.dir} (${messageOf(error)}) -- remove it by hand`;
      if (failed) console.warn(`warning: ${escapeInline(leftover)}`);
      else notes.push(leftover);
    }
  }
  for (const line of staged.lines) console.log(line);
  for (const note of new Set(notes)) {
    console.log(`note: ${escapeInline(note)}`);
  }
  return 0;
}

/** {@link runUpdate}'s work once the theirs tree is built: plans, stages, and returns the lines to print. */
function stageUpdate(
  targetDir: string,
  run: {
    readonly history: TemplateHistory;
    readonly runningVersion: string;
    readonly base: ReturnType<typeof resolveUpdateBase>;
    readonly migrations: ClassifyProjectInput["migrations"];
    readonly ledger: readonly LedgerEntry[];
    readonly ledgerNames: readonly string[];
    readonly tokens: Lock["tokens"];
    readonly theirs: TheirsTree;
    readonly notes: string[];
    readonly classify: typeof classifyProject;
  },
): StagedUpdate {
  const { history, runningVersion, base, theirs, notes } = run;
  for (const name of theirs.missingPacks) {
    notes.push(
      `pack "${name}" no longer ships with this CLI -- its files are left alone`,
    );
  }
  const origin = updateOrigin(targetDir, base.lock);
  const input: ClassifyProjectInput = {
    targetDir,
    lock: base.lock,
    history,
    baseVersion: base.version,
    ledgerPacks: run.ledgerNames,
    tokens: run.tokens,
    theirsDir: theirs.dir,
    theirsSources: theirs.sources,
    migrations: run.migrations,
    runningVersion,
    origin,
    missingPacks: theirs.missingPacks,
    ledgerPackVersions: ledgerPackVersions(run.ledger),
  };
  const result = run.classify(input);
  notes.push(...result.notes);
  const planned = planPacks(run.ledger, {
    missing: new Set(theirs.missingPacks),
    history,
    baseVersion: base.version,
    runningVersion,
    targetDir,
    notes,
  });
  if (
    !isUpdateAvailable(
      result.entries,
      planned.packs.filter(({ outdated }) => outdated).length,
    )
  ) {
    return {
      lines: [
        `already up to date (base ${base.version} (${base.source}), CLI ${runningVersion})`,
      ],
    };
  }

  const tool = gitVersion();
  const ctx: EntryContext = {
    input,
    baseVersion: base.version,
    runningVersion,
    gitAvailable: tool !== null,
    notes,
  };
  const stagedEntries = result.entries.map((entry) =>
    stageEntry(entry, theirs.dir, ctx),
  );
  const summary = { ...result.summary };
  for (const [index, { entry }] of stagedEntries.entries()) {
    const before = result.entries[index]?.action;
    if (before !== undefined && before !== entry.action) {
      summary[before] -= 1;
      summary[entry.action] += 1;
    }
  }
  const lockOrigin: Lock["origin"] =
    base.lock?.origin ?? (origin === "adopted" ? "adopt" : "fresh");
  const lockNext = serializeLock(
    nextLock(base.lock, stagedEntries, {
      origin: lockOrigin,
      tokens: run.tokens,
      runningVersion,
      sources: theirs.sources,
      baseHashOf: (path) => {
        const bytes = resolveBaseBytes(input, path);
        if (bytes !== undefined) return sha256Hex(Buffer.from(bytes));
        const versions = history.versions;
        return Object.hasOwn(versions, base.version)
          ? versions[base.version]?.core[path]
          : undefined;
      },
    }),
  );
  const customize = customizeItems(theirs.dir);
  const items = [
    ...stagedEntries.flatMap(({ items: entryItems }) => entryItems),
    ...planned.items,
    ...customize,
    {
      path: LOCK_FILE,
      staged: LOCK_NEXT_FILE,
      bytes: Buffer.from(lockNext, "utf8"),
    },
  ].sort((a, b) => (a.staged < b.staged ? -1 : a.staged > b.staged ? 1 : 0));
  const collision = findStagedPathCollision(items.map(({ staged }) => staged));
  if (collision !== undefined) {
    throw new Error(`${WHAT}: two staged files collide: ${collision}`);
  }
  assertUpdateWriteScope(targetDir, [
    ...items.map(({ staged }) => `${STAGED_UPDATE_DIR}/${staged}`),
    `${STAGED_UPDATE_DIR}/${PLAN_FILE}`,
  ]);

  const skill = inspectCustomizeSkill(targetDir);
  const lockBytes =
    base.lock === undefined
      ? undefined
      : readIfPresent(join(targetDir, LOCK_FILE));
  const plan = {
    schemaVersion: 1,
    kind: "m3l-groundwork/update-plan",
    cliVersion: runningVersion,
    generatedAt: new Date().toISOString(),
    targetDir,
    origin,
    requiredMode: origin === "adopted" ? "adopt" : "fresh",
    base: {
      version: base.version,
      source: base.source,
      lockSha256: lockBytes === undefined ? null : sha256Hex(lockBytes),
    },
    tokens: run.tokens,
    merge: {
      tool: tool === null ? "none" : "git-merge-file",
      gitVersion: tool,
    },
    files: stagedEntries.map(({ entry }) => entry),
    packs: planned.packs,
    migrations: applicableMigrations(
      run.migrations,
      base.version,
      runningVersion,
    ).map(({ id }) => id),
    skill: { status: skill, files: customize.map(({ staged }) => staged) },
    summary,
    undetermined: [...new Set(notes)],
  };

  const target: StagingTarget = {
    groundworkDir: join(targetDir, ".groundwork"),
    dirName: UPDATE_DIR_NAME,
    noun: "update",
    plural: false,
    rerun: "re-run with --update",
  };
  try {
    prepareStaging(target);
    stageAtomically(target, (newDir) => {
      const files = items.map(({ path, staged, bytes }) => ({
        path,
        staged,
        sha256: writeStagedBytes("runUpdate", bytes, newDir, staged),
      }));
      // Last: plan.json's presence means the staging completed.
      writeFileSync(
        join(newDir, PLAN_FILE),
        `${JSON.stringify({ ...plan, staged: { files } }, null, 2)}\n`,
        { flag: "wx" },
      );
    });
  } catch (cause) {
    throw stagingFailure(cause);
  }

  const parts = formatUpdateCounts(summary);
  const outdated = planned.packs.filter((pack) => pack.outdated).length;
  if (outdated > 0) parts.push(`${String(outdated)} pack(s) outdated`);
  return {
    lines: [
      `staged update ${base.version} -> ${runningVersion}: ${parts.join(", ")}`,
      nextStep(skill),
    ],
  };
}
