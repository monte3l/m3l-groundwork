// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Adopt mode's staging of the baseline files a project lacks entirely: the
 * template files a conflict plan marked "absent" are copied verbatim into
 * `.groundwork/baseline/`, so `/customize`'s Step 0 can install them from a
 * self-contained copy rather than from `templateRoot` -- an absolute path
 * that may not exist by the time it runs.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { restoreDotfilePath } from "./assets.js";
import type { FileConflict } from "./conflicts.js";
import { isPathContained } from "./emit.js";

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

/** Maps every file under `root` to its (dotfile-restored) relative path, in walk order. */
function collectTemplateFiles(
  root: string,
  currentDir: string,
  results: Map<string, string>,
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const sourcePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectTemplateFiles(root, sourcePath, results);
      continue;
    }
    results.set(restoreDotfilePath(relative(root, sourcePath)), sourcePath);
  }
}

/**
 * Copies every template file `conflicts` marks "absent" from `templateRoot`
 * into `<groundworkDir>/baseline/`, byte-for-byte -- no token substitution,
 * which is `/customize`'s job at install time. Any previous staging is removed
 * first, so a file that is no longer absent doesn't linger; when nothing is
 * absent, nothing is created. Returns the staged paths, relative to the
 * staging directory, in conflict-plan order.
 *
 * @example
 * ```ts
 * // conflicts: the plan `planConflicts` (conflicts.ts) computed for the target
 * const conflicts = planConflicts(templateRoot, targetDir, tokens);
 * const staged = stageBaselineAdditions(templateRoot, conflicts, ".groundwork");
 * // staged: ["eslint.config.js", ".gitignore", ...]
 * ```
 */
export function stageBaselineAdditions(
  templateRoot: string,
  conflicts: readonly FileConflict[],
  groundworkDir: string,
): string[] {
  const destDir = join(groundworkDir, STAGED_BASELINE_DIR);
  rmSync(destDir, { recursive: true, force: true });

  const absent = conflicts.filter((c) => c.status === "absent");
  if (absent.length === 0) {
    return [];
  }

  const templateFiles = new Map<string, string>();
  collectTemplateFiles(templateRoot, templateRoot, templateFiles);

  const staged: string[] = [];
  for (const { relPath } of absent) {
    const sourcePath = templateFiles.get(relPath);
    // An absent relPath with no raw template counterpart came from a
    // token-substituted path segment; there is no verbatim file to stage.
    if (sourcePath === undefined) {
      continue;
    }
    const destPath = join(destDir, relPath);
    // CWE-22 invariant (docs/assurance-case.md), same as emitTemplate: a
    // staged write must never land outside the staging directory.
    assert.ok(
      isPathContained(destPath, destDir),
      `stageBaselineAdditions: staged path ${resolve(destPath)} escapes ${resolve(destDir)}`,
    );
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(sourcePath, destPath);
    staged.push(relPath);
  }
  return staged;
}
