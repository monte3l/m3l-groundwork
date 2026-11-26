// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `m3l-groundwork <dir> --check-update [--base-version <x.y.z>]`: offline and
 * read-only, reports whether the running CLI's templates differ from the
 * release the project was installed from. Exit code 0 when up to date, 3
 * when an update is available; a bad invocation or an unsuitable target is a
 * `CliUsageError` (exit 2), anything else an `Error` (exit 1).
 */
import { readdirSync, statSync } from "node:fs";
import { resolveAsset } from "./assets.js";
import { escapeControls } from "./format-error.js";
import { resolveCliVersion } from "./inventory.js";
import { LOCK_FILE, readLock } from "./lock.js";
import {
  classifyProjectOrigin,
  compareVersions,
  inspectPackInstallations,
  LEDGER_PATH,
  PACK_STATUS_LABELS,
  readInstalledPacksLedger,
} from "./pack-installation.js";
import { packsRootDir } from "./packs.js";
import { errnoCode, isAbsentError } from "./survey/internal/read-guard.js";
import { loadTemplateHistory } from "./template-history.js";
import type { TemplateHistory } from "./template-history.js";
import { diffAgainstHistory, resolveUpdateBase } from "./update-base.js";
import type { FileDiff } from "./update-base.js";
import { CliUsageError, USAGE } from "./usage.js";

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
 * absent is compared as an empty tree).
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
}

/** Exit code: the project's templates match the running CLI's. */
const UP_TO_DATE = 0;
/** Exit code: the running CLI ships different templates. */
const UPDATE_AVAILABLE = 3;

/** Project-controlled text on one line, with no raw control character. */
function escapeInline(text: string): string {
  return escapeControls(text).replaceAll("\n", "\\n");
}

/** Refuses a `targetDir` that is not an existing directory, creating nothing. */
function assertDirectory(targetDir: string): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(targetDir).isDirectory();
  } catch (error) {
    if (!isAbsentError(error)) {
      throw new CliUsageError(
        `${targetDir} could not be checked (${errnoCode(error) ?? "unknown error"}) -- --check-update needs a project directory it can inspect\n\n${USAGE}`,
        { cause: error },
      );
    }
    // Absent: reported as "not an existing directory" just below.
  }
  if (!isDirectory) {
    throw new CliUsageError(
      `${targetDir} is not an existing directory -- --check-update needs a bootstrapped or adopted project to inspect\n\n${USAGE}`,
    );
  }
}

/** Refuses a project whose origin gives nothing to compare against. */
function assertCheckableOrigin(targetDir: string): void {
  const origin = classifyProjectOrigin(targetDir);
  switch (origin.kind) {
    case "interrupted-adopt":
      throw new CliUsageError(
        `${targetDir} holds an adopt run that did not finish -- re-run adopt mode (npx @monte3l/groundwork ${targetDir}) first`,
      );
    case "unknown":
      if ("absent" in readLock(targetDir)) {
        throw new CliUsageError(
          `${targetDir} does not look like a project groundwork bootstrapped or adopted (no ${LOCK_FILE}, no bootstrap or adopt markers) -- there is no release to compare against`,
        );
      }
      return;
    case "adopted":
    case "bootstrapped":
      return;
    default: {
      const exhaustive: never = origin;
      throw new Error(`unhandled project origin ${String(exhaustive)}`);
    }
  }
}

/** `<n> file(s) changed upstream, <a> added, <r> removed`. */
function countLine(diff: FileDiff): string {
  return `${String(diff.changed.length)} file(s) changed upstream, ${String(diff.added.length)} added, ${String(diff.removed.length)} removed`;
}

function hasChanges(diff: FileDiff): boolean {
  return diff.changed.length + diff.added.length + diff.removed.length > 0;
}

/**
 * The installed CLI's own `templates/core`, refusing one that cannot be
 * read: comparing against it would report every file removed upstream.
 */
function installedCoreDir(): string {
  const dir = resolveAsset({ repo: "templates/core", local: "templates/core" });
  try {
    readdirSync(dir);
  } catch (error) {
    throw new Error(
      `cannot check for an update: this CLI's templates (${dir}) cannot be read (${errnoCode(error) ?? "unknown error"}) -- this CLI install is damaged; reinstall @monte3l/groundwork`,
      { cause: error },
    );
  }
  return dir;
}

/** The lines `--check-update` prints, computed before any is printed. */
interface CheckUpdateReport {
  readonly lines: readonly string[];
  readonly changed: boolean;
}

/**
 * Runs `--check-update` against `options.targetDir` and returns the exit
 * code: 0 when up to date, 3 when an update is available. Everything is
 * computed before anything is printed. Prints, through `console.log`,
 * `base <X> (<flag|lock|inferred>), CLI <Y>`, then a count line for the
 * core templates and for each ledger pack that differs, any `note:` lines
 * (a tie in inference, the project inspection's notes, a ledger pack that
 * could not be compared, a pack whose files show it installed -- or could
 * not be classified -- without a ledger entry), and finally
 * `update available`, `up to date (N comparison(s) skipped -- see notes)`
 * when any comparison was skipped, or
 * `up to date (base X (<source>), CLI Y)`. A
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
  assertCheckableOrigin(targetDir);

  const loaded = deps.history ?? loadTemplateHistory();
  if ("note" in loaded) {
    throw new Error(
      `cannot check for an update: ${loaded.note} -- this CLI install is damaged; reinstall @monte3l/groundwork`,
    );
  }
  const report = buildReport(targetDir, loaded, {
    runningVersion: deps.runningVersion ?? resolveCliVersion(),
    coreDir: deps.coreDir ?? installedCoreDir(),
    baseVersion,
  });
  for (const line of report.lines) console.log(line);
  return report.changed ? UPDATE_AVAILABLE : UP_TO_DATE;
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
  if (hasChanges(diff.core)) {
    changed = true;
    lines.push(countLine(diff.core));
  }
  for (const pack of diff.packs) {
    if (!hasChanges(pack) && !pack.manifestChanged) continue;
    changed = true;
    const manifest = pack.manifestChanged ? ", manifest changed" : "";
    lines.push(`pack "${pack.name}": ${countLine(pack)}${manifest}`);
  }
  const notes = new Set([
    ...base.notes,
    ...inspection.undetermined,
    ...ledger.undetermined,
    ...diff.notes,
    ...unledgered,
  ]);
  for (const note of notes) lines.push(`note: ${escapeInline(note)}`);

  const skipped = diff.notes.length + unledgered.length;
  if (changed) lines.push("update available");
  else if (skipped > 0) {
    lines.push(
      `up to date (${String(skipped)} comparison(s) skipped -- see notes)`,
    );
  } else {
    lines.push(
      `up to date (base ${base.version} (${base.source}), CLI ${runningVersion})`,
    );
  }
  return { lines, changed };
}
