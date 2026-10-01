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

/**
 * Normalizes a native relative path to forward slashes, so a path recorded
 * in `inventory.json` reads the same whichever OS ran the CLI.
 *
 * @example
 * ```ts
 * toPosixPath("src\\index.ts"); // "src/index.ts"
 * ```
 */
export function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

/** `rmSync` options for a staging directory: recursive, tolerant of absence, and retried on a transient EBUSY/EPERM. */
const RM_DIR_OPTIONS = { recursive: true, force: true, maxRetries: 3 } as const;

/** Prefix of every temporary staging work directory under `groundworkDir`. */
const WORK_DIR_PREFIX = `.${STAGED_BASELINE_DIR}-`;

/** Removes `path` recursively; a failure only warns, naming the path, so it can never shadow the outcome it is cleaning up after. */
function removeBestEffort(path: string): void {
  try {
    rmSync(path, RM_DIR_OPTIONS);
  } catch (error) {
    console.warn(
      `warning: could not remove the temporary staging directory ${path} -- delete it by hand (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Removes every `.baseline-*` work directory a crashed earlier run left under `groundworkDir`; nothing else there is touched. */
function removeStaleWorkDirs(groundworkDir: string): void {
  if (!existsSync(groundworkDir)) {
    return;
  }
  for (const name of readdirSync(groundworkDir)) {
    if (name.startsWith(WORK_DIR_PREFIX)) {
      removeBestEffort(join(groundworkDir, name));
    }
  }
}

/**
 * Pairs every absent conflict with its template source. Two caller bugs are
 * refused, each with its own error and never skipped: a `relPath` whose
 * staged name would land outside `destDir` (CWE-22, docs/assurance-case.md),
 * and an absent path with no template counterpart.
 */
function planStaging(
  templateRoot: string,
  absent: readonly FileConflict[],
  tokens: TokenTable,
  destDir: string,
): { path: string; sourcePath: string }[] {
  const templateFiles = new Map<string, string>();
  collectTemplateFiles(templateRoot, templateRoot, tokens, templateFiles);
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

/** The swap's final rename and the restore of the parked previous baseline both failed: the parked copy is the only one left. */
class ParkedBaselineError extends AggregateError {}

/**
 * Moves `newDir` into place at `destDir`, parking any previous `destDir` at
 * `parkedDir` first. If the final rename fails the parked copy is renamed
 * back; if that restore fails too, throws a {@link ParkedBaselineError}
 * carrying both errors and naming `parkedDir`.
 */
function swapInto(newDir: string, destDir: string, parkedDir: string): void {
  const hadPrevious = existsSync(destDir);
  if (hadPrevious) {
    renameSync(destDir, parkedDir);
  }
  try {
    renameSync(newDir, destDir);
  } catch (error) {
    if (!hadPrevious) {
      throw error;
    }
    try {
      renameSync(parkedDir, destDir);
    } catch (restoreError) {
      throw new ParkedBaselineError(
        [error, restoreError],
        `moving the new baseline into ${destDir} failed and restoring the previous one failed too; the previous baseline was parked at ${parkedDir} -- move it back by hand if you need it, or re-run the CLI to regenerate it`,
      );
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
 * - The plan is validated before any staging work: an absent conflict with
 *   no template counterpart, or whose staged name would escape the staging
 *   directory, throws its own `Error` with the previous `baseline/`
 *   untouched and no temporary directory created.
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
 * naming where the previous baseline is parked, when both renames fail;
 * otherwise an `Error` with `cause`, including the cause's message, saying
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
  const destDir = join(groundworkDir, STAGED_BASELINE_DIR);
  assertNotSymlink(groundworkDir);
  assertNotSymlink(destDir);
  removeStaleWorkDirs(groundworkDir);

  const absent = conflicts.filter((c) => c.status === "absent");
  if (absent.length === 0) {
    rmSync(destDir, RM_DIR_OPTIONS);
    return [];
  }

  // Outside the try: a plan error is a caller bug with its own message, not
  // an "incomplete, re-run" staging failure, and nothing exists to clean up.
  const plan = planStaging(templateRoot, absent, tokens, destDir);

  let workDir: string | undefined;
  // Set only when the previous baseline is parked inside workDir and could
  // not be restored: workDir then holds its only copy and must survive.
  let keepWorkDir = false;
  try {
    mkdirSync(groundworkDir, { recursive: true });
    workDir = mkdtempSync(join(groundworkDir, WORK_DIR_PREFIX));
    const newDir = join(workDir, STAGED_BASELINE_DIR);

    const staged = plan.map(({ path, sourcePath }): StagedBaselineFile => {
      const stagedName = stagedNameFor(path);
      const destPath = join(newDir, stagedName);
      // CWE-22 invariant (docs/assurance-case.md), same as emitTemplate:
      // planStaging already refused an escaping path; this re-asserts it
      // against the directory actually written to.
      assert.ok(
        isPathContained(destPath, newDir),
        `stageBaselineAdditions: staged path ${resolve(destPath)} escapes ${resolve(newDir)}`,
      );
      const bytes = readFileSync(sourcePath);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, bytes, { flag: "wx" });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return {
        path: toPosixPath(path),
        staged: toPosixPath(stagedName),
        sha256,
      };
    });

    swapInto(newDir, destDir, join(workDir, "previous"));
    return staged;
  } catch (cause) {
    if (cause instanceof ParkedBaselineError) {
      keepWorkDir = true;
      throw cause;
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `staging the baseline into ${destDir} failed (${reason}), so .groundwork/ is incomplete -- fix the cause and re-run the CLI`,
      { cause },
    );
  } finally {
    if (workDir !== undefined && !keepWorkDir) {
      removeBestEffort(workDir);
    }
  }
}
