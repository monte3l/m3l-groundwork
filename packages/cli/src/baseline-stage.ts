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

/**
 * Pairs every absent conflict with its template source. Three defects are
 * refused, each with its own error and never skipped: a template with two
 * files mapping to one install path, a `relPath` whose staged name would
 * land outside `destDir` (CWE-22, docs/assurance-case.md), and an absent
 * path with no template counterpart.
 */
function planStaging(
  templateRoot: string,
  absent: readonly FileConflict[],
  tokens: TokenTable,
  destDir: string,
): { path: string; sourcePath: string }[] {
  const templateFiles = collectTemplateFiles(templateRoot, tokens);
  return absent.map(({ relPath }) => {
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
 * - Before anything is deleted or written, `groundworkDir` and
 *   `<groundworkDir>/baseline` are checked not to be symlinks.
 * - Any `.baseline-*` work directory a crashed earlier run left in
 *   `groundworkDir` is removed (best effort; a failure only warns).
 * - When nothing is absent, any previous staging is removed and nothing is
 *   created.
 * - The plan is validated before any staging work: a template with two files
 *   installing to the same path (a dotfile-escaped name beside its literal
 *   twin), or an absent conflict with no template counterpart or whose
 *   staged name would escape the staging directory, throws its own `Error`
 *   with the previous `baseline/` untouched and no temporary directory
 *   created.
 * - Files are then written into a temporary `.baseline-*` sibling directory
 *   and swapped into place only after every copy succeeded, so a copy
 *   failure leaves any previous `baseline/` intact. A previous staging is
 *   replaced wholesale (no stale file lingers).
 * - If the final swap rename fails, the previous `baseline/` is renamed back
 *   into place. Only if that restore also fails is `baseline/` left absent:
 *   the previous staging then survives, parked inside the temporary
 *   directory, which is deliberately not removed (a later run's stale-dir
 *   sweep does remove it, regenerating the staging from scratch).
 * - The temporary directory is otherwise always removed; a failure to remove
 *   it only warns, naming its path.
 *
 * @throws `Error` before any delete or write when `groundworkDir` or
 * `<groundworkDir>/baseline` is a symlink; `Error` (no `cause`) for an
 * invalid plan, as above; `AggregateError` of the swap and restore failures,
 * naming where the previous baseline is parked, when both renames fail; the
 * `AssertionError` itself, unwrapped, if the staged-path containment
 * invariant ever fails while writing; otherwise an `Error` with `cause`, including the cause's message, saying
 * `.groundwork/` is incomplete and the CLI should be re-run.
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
  };
  const destDir = prepareStaging(target);

  const absent = conflicts.filter((c) => c.status === "absent");
  if (absent.length === 0) {
    clearStaging(target);
    return [];
  }

  // Before the staging work: a plan error is a caller bug with its own
  // message, not an "incomplete, re-run" staging failure, and nothing exists
  // to clean up.
  const plan = planStaging(templateRoot, absent, tokens, destDir);

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
