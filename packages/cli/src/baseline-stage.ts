// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Adopt mode's staging of the baseline files a project lacks entirely: the
 * template files a conflict plan marked "absent" are copied verbatim into
 * `.groundwork/baseline/`, each under an inert `<path>.staged` name, so
 * `/customize`'s Step 0 can install them from a self-contained copy rather
 * than from `templateRoot` -- an absolute path that may not exist by the time
 * it runs -- and no toolchain globbing the project ever picks one up.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FileConflict } from "./conflicts.js";
import { isPathContained } from "./emit.js";
import {
  STAGED_SUFFIX,
  clearStaging,
  collectTemplateFiles,
  findStagedPathCollision,
  prepareStaging,
  stageAtomically,
  stagedNameFor,
  toPosixPath,
  writeStagedBytes,
} from "./staging.js";
import type { StagingTarget } from "./staging.js";
import type { TokenTable } from "./tokens.js";

// Re-exported so existing consumers of this module keep one import site;
// staging.ts owns the definitions.
export { STAGED_SUFFIX, stagedNameFor, toPosixPath };

/**
 * The directory name, under `.groundwork/`, that absent baseline files are
 * staged into.
 *
 * @example
 * ```ts
 * import { join } from "node:path";
 * const stagedDir = join(".groundwork", STAGED_BASELINE_DIR); // ".groundwork/baseline"
 * ```
 */
export const STAGED_BASELINE_DIR = "baseline";

/**
 * One staged baseline file: its install path, its staged name, and the
 * sha256 of the staged bytes, so `/customize` can verify the copy it installs.
 *
 * @example
 * ```ts
 * const file: StagedBaselineFile = {
 *   path: "eslint.config.js",
 *   staged: "eslint.config.js.staged",
 *   sha256: "e3b0c442...", // hex digest of the staged bytes
 * };
 * ```
 */
export interface StagedBaselineFile {
  /** The project-relative path the file installs to. */
  path: string;
  /** The staged file's name, relative to the staging directory: `path` + {@link STAGED_SUFFIX}. */
  staged: string;
  /** Lowercase hex sha256 of the staged bytes. */
  sha256: string;
}

/** One validated staging entry: the install path and its template source. */
interface PlannedBaselineFile {
  readonly path: string;
  readonly sourcePath: string;
}

/**
 * Pairs every absent conflict with its template source. Four defects are
 * refused, each with its own `Error` (no `cause`) and never skipped: a
 * template with two files mapping to one install path, a `relPath` whose
 * staged name would land outside `destDir` (CWE-22, docs/assurance-case.md),
 * an absent path with no template counterpart, and two staged names that
 * would land on the same file ({@link findStagedPathCollision}: equal once
 * case-folded, or one a directory prefix of the other).
 */
function planStaging(
  templateRoot: string,
  absent: readonly FileConflict[],
  tokens: TokenTable,
  destDir: string,
): PlannedBaselineFile[] {
  const templateFiles = collectTemplateFiles(templateRoot, tokens);
  const plan = absent.map(({ relPath }): PlannedBaselineFile => {
    const destPath = join(destDir, stagedNameFor(relPath));
    if (!isPathContained(destPath, destDir)) {
      throw new Error(
        `stageBaselineAdditions: staged path ${resolve(destPath)} for ${relPath} escapes ${resolve(destDir)}`,
      );
    }
    const sourcePath = templateFiles.get(relPath);
    if (sourcePath === undefined) {
      throw new Error(
        `absent baseline file ${relPath} has no counterpart under ${templateRoot}`,
      );
    }
    return { path: relPath, sourcePath };
  });
  const collision = findStagedPathCollision(
    plan.map(({ path }) => toPosixPath(stagedNameFor(path))),
  );
  if (collision !== undefined) {
    throw new Error(
      `stageBaselineAdditions: two staged baseline files under ${destDir} collide: ${collision}; rename one of the template files under ${templateRoot}`,
    );
  }
  return plan;
}

/** The absent conflicts in `conflicts` -- the files a baseline staging copies. */
function absentConflicts(conflicts: readonly FileConflict[]): FileConflict[] {
  return conflicts.filter((c) => c.status === "absent");
}

/**
 * Every path {@link stageBaselineAdditions} would write for `conflicts`,
 * under `<groundworkDir>/baseline/` -- one `<path>.staged` per absent
 * conflict -- validated by the same plan, so adopt mode can scope-check them
 * before anything under `.groundwork/` is deleted or written. Reads the
 * template tree; writes nothing. Returns `[]` when nothing is absent.
 *
 * @throws The same plan `Error`s as {@link stageBaselineAdditions}: a
 * template with two files installing to one path, an absent conflict with no
 * template counterpart or whose staged name would escape the staging
 * directory, or two colliding staged names.
 *
 * @example
 * ```ts
 * import { assertAdoptWriteScope } from "./main.js";
 * const paths = plannedBaselineStagingPaths(templateRoot, conflicts, groundworkDir, tokens);
 * assertAdoptWriteScope(targetDir, paths);
 * ```
 */
export function plannedBaselineStagingPaths(
  templateRoot: string,
  conflicts: readonly FileConflict[],
  groundworkDir: string,
  tokens: TokenTable,
): string[] {
  const absent = absentConflicts(conflicts);
  if (absent.length === 0) {
    return [];
  }
  const destDir = join(groundworkDir, STAGED_BASELINE_DIR);
  return planStaging(templateRoot, absent, tokens, destDir).map(({ path }) =>
    join(destDir, stagedNameFor(path)),
  );
}

/**
 * Copies every template file `conflicts` marks "absent" from `templateRoot`
 * into `<groundworkDir>/baseline/` as `<path>.staged`, byte-for-byte -- no
 * token substitution into content, which is `/customize`'s job at install
 * time. `tokens` is used only to match a tokenized template path
 * (`__PROJECT_NAME__.txt`) to the substituted `relPath` the conflict plan
 * reports. Recorded `path`/`staged` values use forward slashes
 * ({@link toPosixPath}).
 *
 * What is guaranteed:
 * - The plan is validated first, before anything is deleted or written: a
 *   template with two files installing to the same path (a dotfile-escaped
 *   name beside its literal twin), an absent conflict with no template
 *   counterpart or whose staged name would escape the staging directory, or
 *   two staged names that would land on the same file (equal once
 *   case-folded, or one a directory prefix of the other) throws its own
 *   `Error`, leaving `.groundwork/` exactly as it was.
 * - Then, still before anything is deleted or written, `groundworkDir` and
 *   `<groundworkDir>/baseline` are checked not to be symlinks, and every
 *   `.baseline-*` entry of the CLI-owned `groundworkDir` -- work directories
 *   a crashed earlier run left -- is removed (best effort; a failure to
 *   remove one only warns, a failure to list `groundworkDir` throws).
 * - When nothing is absent, any previous staging is removed and nothing is
 *   created.
 * - Files are then written into a temporary `.baseline-*` sibling directory
 *   and swapped in by rename only after every copy succeeded, so
 *   `baseline/` is never half-written and a copy failure leaves any previous
 *   `baseline/` intact. A previous staging is replaced wholesale (no stale
 *   file lingers).
 * - With a previous `baseline/`, the swap is two renames: the previous one
 *   is parked inside the temporary directory, then the new one moved into
 *   place. A process killed between the two leaves `baseline/` absent and
 *   the previous copy at `.baseline-XXXXXX/previous`; the next run's sweep
 *   removes it and regenerates the staging.
 * - If the final swap rename fails, the previous `baseline/` is renamed back
 *   into place. Only if that restore also fails is `baseline/` left absent:
 *   the previous staging then survives, parked inside the temporary
 *   directory, which is deliberately not removed (a later run's stale-dir
 *   sweep does remove it, regenerating the staging from scratch).
 * - The temporary directory is otherwise always removed; a failure to remove
 *   it only warns, naming its path.
 *
 * @throws `Error` (no `cause`, no re-run advice) for an invalid plan, as
 * above; `Error` before any delete or write when `groundworkDir` or
 * `<groundworkDir>/baseline` is a symlink; `AggregateError` of the swap and
 * restore failures, naming where the previous baseline is parked, when both
 * renames fail; the `AssertionError` itself, unwrapped, if the staged-path
 * containment invariant ever fails while writing; otherwise an `Error` with
 * `cause`, including the cause's message, saying `.groundwork/` is
 * incomplete and the CLI should be re-run.
 *
 * @example
 * ```ts
 * // conflicts: the plan `planConflicts` (conflicts.ts) computed for the target
 * const conflicts = planConflicts(templateRoot, targetDir, tokens);
 * const staged = stageBaselineAdditions(templateRoot, conflicts, ".groundwork", tokens);
 * // staged: [{ path: "eslint.config.js", staged: "eslint.config.js.staged", sha256: "…" }, …]
 * ```
 */
export function stageBaselineAdditions(
  templateRoot: string,
  conflicts: readonly FileConflict[],
  groundworkDir: string,
  tokens: TokenTable,
): StagedBaselineFile[] {
  const target: StagingTarget = {
    groundworkDir,
    dirName: STAGED_BASELINE_DIR,
    noun: "baseline",
    plural: false,
  };
  const destDir = join(groundworkDir, STAGED_BASELINE_DIR);

  // Validated before the symlink check and stale-dir sweep, so an invalid
  // plan -- a template defect, with its own message rather than the
  // "incomplete, re-run" staging failure -- deletes and writes nothing.
  const absent = absentConflicts(conflicts);
  const plan =
    absent.length === 0
      ? []
      : planStaging(templateRoot, absent, tokens, destDir);

  prepareStaging(target);
  if (plan.length === 0) {
    clearStaging(target);
    return [];
  }

  return stageAtomically(target, (newDir) =>
    plan.map(({ path, sourcePath }): StagedBaselineFile => {
      const stagedName = stagedNameFor(path);
      // writeStagedBytes re-asserts the CWE-22 containment planStaging
      // already checked, against the directory actually written to.
      const sha256 = writeStagedBytes(
        "stageBaselineAdditions",
        readFileSync(sourcePath),
        newDir,
        stagedName,
      );
      return {
        path: toPosixPath(path),
        staged: toPosixPath(stagedName),
        sha256,
      };
    }),
  );
}
