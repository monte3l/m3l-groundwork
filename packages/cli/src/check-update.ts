// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `m3l-groundwork <dir> --check-update [--base-version <x.y.z>]`: offline and
 * read-only, reports whether the running CLI's templates differ from the
 * release the project was installed from. Exit code 0 when up to date, 3
 * when an update is available; a bad invocation or an unsuitable target is a
 * `CliUsageError` (exit 2), anything else an `Error` (exit 1).
 */
import { resolveCliVersion } from "./inventory.js";
import type { Lock } from "./lock.js";
import { loadMigrations } from "./migrations.js";
import {
  compareVersions,
  inspectPackInstallations,
  LEDGER_PATH,
  PACK_STATUS_LABELS,
  projectNameOf,
  readInstalledPacksLedger,
} from "./pack-installation.js";
import { packsRootDir } from "./packs.js";
import type { TemplateHistory } from "./template-history.js";
import { buildTheirsTree } from "./theirs-tree.js";
import { buildTokens } from "./tokens.js";
import { diffAgainstHistory, resolveUpdateBase } from "./update-base.js";
import type { FileDiff } from "./update-base.js";
import { classifyProject } from "./update-classify.js";
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

/**
 * `--check-update`'s options: the project directory, and the
 * `--base-version` override when given.
 *
 * @example
 * ```ts
 * const options: CheckUpdateOptions = { targetDir: "/path/to/project", baseVersion: "1.4.0" };
 * ```
 */
export interface CheckUpdateOptions {
  readonly targetDir: string;
  readonly baseVersion?: string | undefined;
}

/**
 * Optional overrides for {@link runCheckUpdate}: the loaded template history
 * (default: `loadTemplateHistory()`), the running CLI version (default:
 * `resolveCliVersion()`) and the running CLI's `templates/core` (default:
 * the installed one, which must be readable; an explicit directory that is
 * absent is compared as an empty tree); for the `if you update:` preview,
 * the classifier (default: `classifyProject`), the theirs-tree builder
 * (default: `buildTheirsTree`) and the migrations file (default: the
 * shipped one).
 *
 * @example
 * ```ts
 * const deps: CheckUpdateDeps = { runningVersion: "1.5.0" };
 * ```
 */
export interface CheckUpdateDeps {
  readonly history?: { history: TemplateHistory } | { note: string };
  readonly runningVersion?: string;
  readonly coreDir?: string;
  readonly classify?: typeof classifyProject;
  readonly buildTheirs?: typeof buildTheirsTree;
  readonly migrationsPath?: string;
}

/** Exit code: the project's templates match the running CLI's. */
const UP_TO_DATE = 0;
/** Exit code: the running CLI ships different templates. */
const UPDATE_AVAILABLE = 3;

/** Refuses a `targetDir` that is not an existing directory, creating nothing. */
function assertDirectory(targetDir: string): void {
  assertUpdateTarget(
    targetDir,
    "--check-update",
    "a bootstrapped or adopted project to inspect",
  );
}

/** `<n> file(s) changed upstream, <a> added, <r> removed`. */
function countLine(diff: FileDiff): string {
  return `${String(diff.changed.length)} file(s) changed upstream, ${String(diff.added.length)} added, ${String(diff.removed.length)} removed`;
}

function fileCount(diff: FileDiff): number {
  return diff.changed.length + diff.added.length + diff.removed.length;
}

function hasChanges(diff: FileDiff): boolean {
  return fileCount(diff) > 0;
}

/** The preview's injectable parts (see {@link CheckUpdateDeps}). */
interface PreviewDeps {
  readonly classify: typeof classifyProject;
  readonly buildTheirs: typeof buildTheirsTree;
  readonly migrationsPath: string | undefined;
}

/**
 * The `if you update:` line, its notes, how many comparisons it skipped,
 * and whether an update would change the project (`undefined` when the
 * classifier did not run).
 */
interface UpdatePreview {
  readonly line: string | undefined;
  readonly notes: readonly string[];
  readonly skipped: number;
  readonly available: boolean | undefined;
}

/**
 * The `if you update: ...` line (or none when nothing would change) and its
 * notes: builds the running CLI's theirs tree, classifies the project
 * against it, and removes the tree before returning. Never throws for a
 * preview failure: a tree that cannot be built, damaged migrations, a
 * classifier failure or a ledger pack this CLI no longer ships is a note
 * counted in `skipped`, and a tree that cannot be removed is a note naming
 * the leftover directory.
 */
function updatePreview(
  targetDir: string,
  history: TemplateHistory,
  input: {
    readonly lock: Lock | undefined;
    readonly baseVersion: string;
    readonly runningVersion: string;
    readonly coreDir: string;
    readonly packNames: readonly string[];
    readonly packVersions: Readonly<Record<string, string>>;
    readonly outdatedPacks: number;
  },
  deps: PreviewDeps,
): UpdatePreview {
  const notes: string[] = [];
  let skipped = 0;
  const loaded = loadMigrations(deps.migrationsPath);
  if ("note" in loaded) {
    notes.push(loaded.note);
    skipped += 1;
  }
  const migrations = "migrations" in loaded ? loaded.migrations : [];
  const tokens = input.lock?.tokens ?? buildTokens(projectNameOf(targetDir));
  let theirs: ReturnType<typeof buildTheirsTree>;
  try {
    theirs = deps.buildTheirs({
      tokens,
      packNames: input.packNames,
      coreDir: input.coreDir,
    });
  } catch (error) {
    notes.push(`update preview skipped: ${messageOf(error)}`);
    return {
      line: undefined,
      notes,
      skipped: skipped + 1,
      available: undefined,
    };
  }
  let line: string | undefined;
  let available: boolean | undefined;
  try {
    for (const name of theirs.missingPacks) {
      notes.push(
        `pack "${name}" no longer ships with this CLI -- its files are left alone`,
      );
      skipped += 1;
    }
    const result = deps.classify({
      targetDir,
      lock: input.lock,
      history,
      baseVersion: input.baseVersion,
      ledgerPacks: input.packNames,
      tokens,
      theirsDir: theirs.dir,
      theirsSources: theirs.sources,
      migrations,
      runningVersion: input.runningVersion,
      origin: updateOrigin(targetDir, input.lock),
      missingPacks: theirs.missingPacks,
      ledgerPackVersions: input.packVersions,
    });
    notes.push(...result.notes);
    skipped += result.notes.length;
    available = isUpdateAvailable(result.entries, input.outdatedPacks);
    const parts = formatUpdateCounts(result.summary);
    if (parts.length > 0) line = `if you update: ${parts.join(", ")}`;
  } catch (error) {
    notes.push(`update preview skipped: ${messageOf(error)}`);
    skipped += 1;
  } finally {
    try {
      theirs.cleanup();
    } catch (error) {
      // Best effort: a leftover temp directory never replaces the report
      // or the preview's own failure; it is reported so it can be removed.
      notes.push(
        `could not remove the temporary directory ${theirs.dir} (${messageOf(error)}) -- remove it by hand`,
      );
    }
  }
  return { line, notes, skipped, available };
}

/** The lines `--check-update` prints, computed before any is printed. */
interface CheckUpdateReport {
  readonly lines: readonly string[];
  readonly available: boolean;
}

/**
 * Runs `--check-update` against `options.targetDir` and returns the exit
 * code: 0 when up to date, 3 when an update is available -- the test
 * `--update` shares (`isUpdateAvailable`): when the preview ran, an entry
 * an update would act on or an outdated ledger pack; when it could not,
 * any upstream difference. Everything is
 * computed before anything is printed. Prints, through `console.log`,
 * `base <X> (<flag|lock|inferred>), CLI <Y>`, then a count line for the
 * core templates and for each ledger pack that differs, then -- when the
 * base is older than the running CLI -- `if you update: <counts>` (what an
 * update would do to this project's files: update cleanly, need a merge,
 * conflict, need review, new, removed, renamed; omitted when all are zero;
 * the temporary theirs tree it is computed from is always removed), any
 * `note:` lines (migrations or packs the preview could not use,
 * a tie in inference, the project inspection's notes, a ledger pack that
 * could not be compared, a pack whose files show it installed -- or could
 * not be classified -- without a ledger entry), and finally
 * `update available`, `up to date (N comparison(s) skipped -- see notes)`
 * when any comparison was skipped,
 * `up to date (base X (<source>), CLI Y): N file(s) changed upstream, but your project already matches or keeps them`
 * when upstream differs but nothing here would change, or `up to date (base X (<source>), CLI Y)`. A
 * base at or above the running version skips the core comparison; ledger
 * packs recorded at an older version are still compared. Never writes
 * anything.
 *
 * @throws `CliUsageError` (exit 2) when the target is missing or not a
 * directory, holds an unfinished adopt run, is of unknown origin with no
 * lock (even with `--base-version`), or when {@link resolveUpdateBase}
 * refuses (an invalid lock, a lock newer than the CLI, no resolvable base).
 * A plain `Error` (exit 1) when the shipped template history or the CLI's
 * own `templates/core` cannot be loaded: that is a packaging defect, never
 * reported as "up to date".
 *
 * @example
 * ```ts
 * import process from "node:process";
 * process.exitCode = runCheckUpdate({ targetDir: "/path/to/project" });
 * ```
 */
export function runCheckUpdate(
  options: CheckUpdateOptions,
  deps: CheckUpdateDeps = {},
): number {
  const { targetDir, baseVersion } = options;
  assertDirectory(targetDir);
  assertUpdatableOrigin(targetDir);

  const loaded = requireTemplateHistory(
    deps.history,
    "cannot check for an update",
  );
  const report = buildReport(targetDir, loaded, {
    runningVersion: deps.runningVersion ?? resolveCliVersion(),
    coreDir: deps.coreDir ?? installedCoreDir("cannot check for an update"),
    baseVersion,
    preview: {
      classify: deps.classify ?? classifyProject,
      buildTheirs: deps.buildTheirs ?? buildTheirsTree,
      migrationsPath: deps.migrationsPath,
    },
  });
  for (const line of report.lines) console.log(line);
  return report.available ? UPDATE_AVAILABLE : UP_TO_DATE;
}

/**
 * Every line {@link runCheckUpdate} prints, and whether any comparison
 * found a change. Prints nothing itself.
 */
function buildReport(
  targetDir: string,
  loaded: { history: TemplateHistory },
  settings: {
    readonly runningVersion: string;
    readonly coreDir: string;
    readonly baseVersion: string | undefined;
    readonly preview: PreviewDeps;
  },
): CheckUpdateReport {
  const { history } = loaded;
  const { runningVersion, coreDir, baseVersion } = settings;
  const base = resolveUpdateBase({
    targetDir,
    history,
    runningVersion,
    baseVersion,
    coreDir,
  });
  const order = compareVersions(base.version, runningVersion);
  const coreUpToDate = order !== undefined && order >= 0;

  const ledger = readInstalledPacksLedger(targetDir);
  const diff = diffAgainstHistory({
    targetDir,
    history,
    baseVersion: base.version,
    coreDir,
    packsRoot: packsRootDir(),
    lock: base.lock,
    // A pack recorded at the running version itself has nothing to compare.
    ledger: ledger.entries.filter(
      ({ cliVersion }) =>
        compareVersions(cliVersion ?? base.version, runningVersion) !== 0,
    ),
    compareCore: !coreUpToDate,
  });
  const inspection = inspectPackInstallations(targetDir, undefined, {
    history: loaded,
    runningVersion,
  });

  // Only ledger packs are compared: one whose files show it installed
  // without a ledger entry has no recorded version, so it is a note.
  const unledgered = inspection.packs
    .filter(
      ({ name, status }) =>
        status.source === "detected" && !ledger.names.includes(name),
    )
    .flatMap(({ name, status }) => {
      switch (status.status) {
        case "installed":
        case "partial":
          return [
            `pack "${name}" looks ${PACK_STATUS_LABELS[status.status]}, but ${LEDGER_PATH} does not list it -- not compared`,
          ];
        case "undetermined":
          return [`pack "${name}" could not be classified -- not compared`];
        case "not-installed":
        case "outdated":
          return [];
        default: {
          const exhaustive: never = status.status;
          throw new Error(`unhandled pack status ${String(exhaustive)}`);
        }
      }
    });

  const lines = [
    `base ${base.version} (${base.source}), CLI ${runningVersion}`,
  ];
  let changed = false;
  let upstreamFiles = 0;
  if (hasChanges(diff.core)) {
    changed = true;
    upstreamFiles += fileCount(diff.core);
    lines.push(countLine(diff.core));
  }
  for (const pack of diff.packs) {
    if (!hasChanges(pack) && !pack.manifestChanged) continue;
    changed = true;
    upstreamFiles += fileCount(pack);
    const manifest = pack.manifestChanged ? ", manifest changed" : "";
    lines.push(`pack "${pack.name}": ${countLine(pack)}${manifest}`);
  }
  const preview: UpdatePreview = coreUpToDate
    ? { line: undefined, notes: [], skipped: 0, available: undefined }
    : updatePreview(
        targetDir,
        history,
        {
          lock: base.lock,
          baseVersion: base.version,
          runningVersion,
          coreDir,
          packNames: ledger.names,
          packVersions: ledgerPackVersions(ledger.entries),
          outdatedPacks: inspection.packs.filter(
            ({ status }) =>
              status.source === "ledger" && status.status === "outdated",
          ).length,
        },
        settings.preview,
      );
  if (preview.line !== undefined) lines.push(preview.line);
  const notes = new Set([
    ...base.notes,
    ...inspection.undetermined,
    ...ledger.undetermined,
    ...diff.notes,
    ...unledgered,
    ...preview.notes,
  ]);
  for (const note of notes) lines.push(`note: ${escapeInline(note)}`);

  const skipped = diff.notes.length + unledgered.length + preview.skipped;
  // The preview, when it ran, decides as --update would; otherwise any
  // upstream difference counts.
  const available = preview.available ?? changed;
  const upToDate = `up to date (base ${base.version} (${base.source}), CLI ${runningVersion})`;
  if (available) lines.push("update available");
  else if (skipped > 0) {
    lines.push(
      `up to date (${String(skipped)} comparison(s) skipped -- see notes)`,
    );
  } else if (changed) {
    lines.push(
      `${upToDate}: ${String(upstreamFiles)} file(s) changed upstream, but your project already matches or keeps them`,
    );
  } else {
    lines.push(upToDate);
  }
  return { lines, available };
}
