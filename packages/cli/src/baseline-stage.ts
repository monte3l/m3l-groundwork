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
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { restoreDotfilePath } from "./assets.js";
import type { FileConflict } from "./conflicts.js";
import { isPathContained } from "./emit.js";
import { assertNotSymlink } from "./fs-guard.js";
import { applyTokens } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

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
 * The suffix every staged file carries, so no extension-based glob
 * (`**\/*.ts`, `**\/*.md`, `vitest.config.*`) ever matches a staged copy.
 *
 * @example
 * ```ts
 * const staged = `eslint.config.js${STAGED_SUFFIX}`; // "eslint.config.js.staged"
 * ```
 */
export const STAGED_SUFFIX = ".staged";

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
 * The staged name for a project-relative `path`: `path` + {@link STAGED_SUFFIX}.
 * The single derivation both the stager and adopt mode's write-scope check use.
 *
 * @example
 * ```ts
 * stagedNameFor("src/index.ts"); // "src/index.ts.staged"
 * ```
 */
export function stagedNameFor(path: string): string {
  return `${path}${STAGED_SUFFIX}`;
}

/** Maps every file under `root` to its install path (tokens applied, dotfile name restored) -- the same derivation `planConflicts` uses. */
function collectTemplateFiles(
  root: string,
  currentDir: string,
  tokens: TokenTable,
  results: Map<string, string>,
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const sourcePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectTemplateFiles(root, sourcePath, tokens, results);
      continue;
    }
    results.set(
      restoreDotfilePath(applyTokens(relative(root, sourcePath), tokens)),
      sourcePath,
    );
  }
}

/** Pairs every absent conflict with its template source; an absent path with no template counterpart is a caller bug, never skipped. */
function planStaging(
  templateRoot: string,
  absent: readonly FileConflict[],
  tokens: TokenTable,
): { path: string; sourcePath: string }[] {
  const templateFiles = new Map<string, string>();
  collectTemplateFiles(templateRoot, templateRoot, tokens, templateFiles);
  return absent.map(({ relPath }) => {
    const sourcePath = templateFiles.get(relPath);
    if (sourcePath === undefined) {
      throw new Error(
        `absent baseline file ${relPath} has no counterpart under ${templateRoot}`,
      );
    }
    return { path: relPath, sourcePath };
  });
}

/** Moves `newDir` into place at `destDir`, parking any previous `destDir` at `parkedDir` and restoring it if the final rename fails. */
function swapInto(newDir: string, destDir: string, parkedDir: string): void {
  const hadPrevious = existsSync(destDir);
  if (hadPrevious) {
    renameSync(destDir, parkedDir);
  }
  try {
    renameSync(newDir, destDir);
  } catch (error) {
    if (hadPrevious) {
      try {
        renameSync(parkedDir, destDir);
      } catch {
        // Best effort: the rename failure below is the error worth reporting.
      }
    }
    throw error;
  }
}

/**
 * Copies every template file `conflicts` marks "absent" from `templateRoot`
 * into `<groundworkDir>/baseline/` as `<path>.staged`, byte-for-byte -- no
 * token substitution into content, which is `/customize`'s job at install
 * time. `tokens` is used only to match a tokenized template path
 * (`__PROJECT_NAME__.txt`) to the substituted `relPath` the conflict plan
 * reports; every absent conflict must match a template file, or the call
 * throws.
 *
 * Staging is atomic: files are written into a temporary sibling directory
 * inside `groundworkDir` and swapped into place only after every copy
 * succeeded, so a failure leaves any previous `baseline/` intact. A previous
 * staging is replaced wholesale (no stale file lingers); when nothing is
 * absent, any previous staging is removed and nothing is created.
 *
 * @throws `Error` before any delete or write when `groundworkDir` or
 * `<groundworkDir>/baseline` is a symlink; otherwise an `Error` (with
 * `cause`) saying `.groundwork/` is incomplete and the CLI should be re-run.
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
  const destDir = join(groundworkDir, STAGED_BASELINE_DIR);
  assertNotSymlink(groundworkDir);
  assertNotSymlink(destDir);

  const absent = conflicts.filter((c) => c.status === "absent");
  if (absent.length === 0) {
    rmSync(destDir, { recursive: true, force: true });
    return [];
  }

  let workDir: string | undefined;
  try {
    const plan = planStaging(templateRoot, absent, tokens);
    mkdirSync(groundworkDir, { recursive: true });
    workDir = mkdtempSync(join(groundworkDir, `.${STAGED_BASELINE_DIR}-`));
    const newDir = join(workDir, STAGED_BASELINE_DIR);

    const staged = plan.map(({ path, sourcePath }): StagedBaselineFile => {
      const stagedName = stagedNameFor(path);
      const destPath = join(newDir, stagedName);
      // CWE-22 invariant (docs/assurance-case.md), same as emitTemplate: a
      // staged write must never land outside the staging directory.
      assert.ok(
        isPathContained(destPath, newDir),
        `stageBaselineAdditions: staged path ${resolve(destPath)} escapes ${resolve(newDir)}`,
      );
      const bytes = readFileSync(sourcePath);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, bytes, { flag: "wx" });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { path, staged: stagedName, sha256 };
    });

    swapInto(newDir, destDir, join(workDir, "previous"));
    return staged;
  } catch (cause) {
    throw new Error(
      `staging the baseline into ${destDir} failed, so .groundwork/ is incomplete -- fix the cause and re-run the CLI`,
      { cause },
    );
  } finally {
    if (workDir !== undefined) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover temp dir must not shadow the staging outcome.
      }
    }
  }
}
