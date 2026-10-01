// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The staging machinery adopt mode's two stagers share --
 * `baseline-stage.ts` (`.groundwork/baseline/`) and `pack-stage.ts`
 * (`.groundwork/packs/`): the inert `.staged` naming convention, the
 * template-tree walk that maps a source file to its install path, the
 * stale-work-dir sweep, and the atomic write-then-swap lifecycle. Each
 * stager owns its own plan validation and its own result shape; everything
 * here is parameterized by the staging directory's name and a noun for
 * messages, so both stagers' failures read the same way.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { restoreDotfilePath } from "./assets.js";
import { isPathContained } from "./emit.js";
import { assertNotSymlink } from "./fs-guard.js";
import { applyTokens } from "./tokens.js";
import type { TokenTable } from "./tokens.js";

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
 * The staged name for a project-relative `path`: `path` + {@link STAGED_SUFFIX}.
 * The single derivation every stager and adopt mode's write-scope check use.
 *
 * @example
 * ```ts
 * stagedNameFor("src/index.ts"); // "src/index.ts.staged"
 * ```
 */
export function stagedNameFor(path: string): string {
  return `${path}${STAGED_SUFFIX}`;
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

/**
 * Finds the first pair of staged paths that would land on the same file on
 * some supported file system: two paths equal once folded -- NFC-normalized
 * (macOS's APFS treats a precomposed `é` and `e` + U+0301 as one name) and
 * case-folded (macOS and Windows default to case-insensitive) -- or one path
 * a proper directory prefix of another once folded (`x.staged` as both a
 * file and the directory holding `x.staged/y.staged`). Either collision
 * makes the second exclusive (`wx`) write fail mid-staging; a plan checks
 * for it first so the defect surfaces as its own error instead. Folding is
 * `toLowerCase()` after `normalize("NFC")`, not a full Unicode case fold, so
 * it is a best-effort approximation of each file system's own rules. Paths
 * are otherwise compared as given -- pass them `/`-separated
 * ({@link toPosixPath}).
 *
 * @returns A description naming both colliding paths, or `undefined` when
 * none collide.
 *
 * @example
 * ```ts
 * findStagedPathCollision(["README.md.staged", "readme.md.staged"]); // "README.md.staged and readme.md.staged …"
 * findStagedPathCollision(["a.staged", "b.staged"]); // undefined
 * ```
 */
export function findStagedPathCollision(
  stagedPaths: readonly string[],
): string | undefined {
  const fold = (p: string): string => p.normalize("NFC").toLowerCase();
  const byFolded = new Map<string, string>();
  for (const path of stagedPaths) {
    const folded = fold(path);
    const previous = byFolded.get(folded);
    if (previous !== undefined) {
      return previous.toLowerCase() === path.toLowerCase()
        ? `${previous} and ${path} differ only by letter case, so they are the same file on a case-insensitive file system`
        : `${previous} and ${path} differ only by Unicode normalization (and possibly letter case), so they are the same file on a normalization-insensitive file system`;
    }
    byFolded.set(folded, path);
  }
  for (const path of stagedPaths) {
    const segments = fold(path).split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = byFolded.get(segments.slice(0, i).join("/"));
      if (ancestor !== undefined) {
        return `${ancestor} would be both a file and the directory holding ${path}`;
      }
    }
  }
  return undefined;
}

function collectInto(
  root: string,
  currentDir: string,
  tokens: TokenTable,
  results: Map<string, string>,
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const sourcePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectInto(root, sourcePath, tokens, results);
      continue;
    }
    const installPath = restoreDotfilePath(
      applyTokens(relative(root, sourcePath), tokens),
    );
    const previous = results.get(installPath);
    if (previous !== undefined) {
      throw new Error(
        `template files ${previous} and ${sourcePath} both install to ${installPath} under ${root}; remove one of them`,
      );
    }
    results.set(installPath, sourcePath);
  }
}

/**
 * Maps every file under `root` to its install path (tokens applied, dotfile
 * name restored) -- the same derivation `planConflicts` uses -- keyed by
 * install path, valued by absolute source path.
 *
 * @throws `Error` (no `cause`) naming the install path and both sources when
 * two files map to the same install path (`_gitignore` beside `.gitignore`),
 * rather than silently letting the later one win.
 *
 * @example
 * ```ts
 * const files = collectTemplateFiles("/repo/templates/core", { PROJECT_NAME: "acme" });
 * files.get(".gitignore"); // "/repo/templates/core/_gitignore"
 * ```
 */
export function collectTemplateFiles(
  root: string,
  tokens: TokenTable,
): Map<string, string> {
  const results = new Map<string, string>();
  collectInto(root, root, tokens, results);
  return results;
}

/**
 * `rmSync` options for a staging directory: recursive, tolerant of absence,
 * and retried on a transient EBUSY/EPERM.
 */
const RM_DIR_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
} as const satisfies Parameters<typeof rmSync>[1];

/**
 * Removes `path` recursively; a failure only warns, naming the path, so it
 * can never shadow the outcome it is cleaning up after.
 */
function removeBestEffort(path: string): void {
  try {
    rmSync(path, RM_DIR_OPTIONS);
  } catch (error) {
    console.warn(
      `warning: could not remove the temporary staging directory ${path} -- delete it by hand (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * The swap's final rename and the restore of the parked previous staging
 * both failed: the parked copy is the only one left. Its `errors` are
 * `[swapError, restoreError]`.
 */
class ParkedStagingError extends AggregateError {}

/**
 * The standard staging failure: `.groundwork/` is incomplete and the CLI
 * should be re-run. The message embeds the cause's own message so it stands
 * alone; `formatErrorChain` skips the then-redundant `caused by:` line.
 */
function incompleteStagingError(
  noun: string,
  destDir: string,
  cause: unknown,
): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `staging the ${noun} into ${destDir} failed (${reason}), so .groundwork/ is incomplete -- fix the cause and re-run the CLI`,
    { cause },
  );
}

/**
 * Removes every entry of `groundworkDir` whose name starts with
 * `.<dirName>-` -- work directories a crashed earlier run left behind --
 * best effort (a removal failure only warns). Any matching entry is removed,
 * whatever made it: `.groundwork/` is CLI-owned. Nothing else there is
 * touched; a missing `groundworkDir` is a no-op. Failing to list
 * `groundworkDir` at all throws {@link incompleteStagingError}.
 */
function removeStaleWorkDirs(target: StagingTarget): void {
  const { groundworkDir, dirName, noun } = target;
  if (!existsSync(groundworkDir)) {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(groundworkDir);
  } catch (cause) {
    throw incompleteStagingError(noun, join(groundworkDir, dirName), cause);
  }
  const prefix = `.${dirName}-`;
  for (const name of names) {
    if (name.startsWith(prefix)) {
      removeBestEffort(join(groundworkDir, name));
    }
  }
}

/**
 * Moves `newDir` into place at `destDir`, parking any previous `destDir` at
 * `parkedDir` first. If the final rename fails the parked copy is renamed
 * back and the rename failure rethrown; if that restore fails too, throws a
 * {@link ParkedStagingError} carrying both errors, naming `parkedDir`, and
 * telling the user to re-run the CLI -- the staging is derived data, so the
 * next run's stale-dir sweep removes the parked copy and regenerates
 * `destDir`.
 */
function swapInto(
  target: StagingTarget,
  newDir: string,
  destDir: string,
  parkedDir: string,
): void {
  const { noun } = target;
  const was = target.plural ? "were" : "was";
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
      throw new ParkedStagingError(
        [error, restoreError],
        `moving the new ${noun} into ${destDir} failed and restoring the previous one failed too; the previous ${noun} ${was} parked at ${parkedDir} -- fix the cause and re-run the CLI: the staging is derived data, regenerated from the template, and the next run removes the parked copy`,
      );
    }
    throw error;
  }
}

/**
 * Refuses a staging plan computed for a different `.groundwork/` than the
 * one a stager was handed: the plan's scope-checked paths would otherwise
 * not be the paths written. Directories are compared after `path.resolve`,
 * so two spellings of one directory match. A caller defect, so a plain
 * `Error` (never an `AssertionError`), thrown before anything is written.
 *
 * @throws `Error` naming both directories when they differ.
 *
 * @example
 * ```ts
 * assertPlanBuiltFor("stagePacks", plan.groundworkDir, groundworkDir);
 * ```
 */
export function assertPlanBuiltFor(
  caller: string,
  planGroundworkDir: string,
  groundworkDir: string,
): void {
  const planned = resolve(planGroundworkDir);
  const actual = resolve(groundworkDir);
  if (planned !== actual) {
    throw new Error(
      `${caller}: the plan was built for ${planned}, not ${actual} -- compute the plan for the same .groundwork/ directory it is staged into`,
    );
  }
}

/**
 * One staging area under `.groundwork/`: the directory `dirName` that
 * {@link stageAtomically} writes, and the `noun` its messages use.
 *
 * @example
 * ```ts
 * const target: StagingTarget = {
 *   groundworkDir: "/work/app/.groundwork",
 *   dirName: "packs",
 *   noun: "packs",
 *   plural: true,
 * };
 * ```
 */
export interface StagingTarget {
  /** The `.groundwork/` directory the staging area lives in. */
  readonly groundworkDir: string;
  /** The staging directory's name under `groundworkDir`; its work directories are named `.<dirName>-XXXXXX`. */
  readonly dirName: string;
  /** What is being staged, for messages: `"baseline"`, `"packs"`. */
  readonly noun: string;
  /** Whether `noun` takes a plural verb in messages ("the previous packs were", not "was"). */
  readonly plural: boolean;
}

/**
 * The first step of every staging run: refuses a symlinked `groundworkDir`
 * or `<groundworkDir>/<dirName>` (before anything is deleted or written),
 * then sweeps the `.<dirName>-*` work directories a crashed earlier run
 * left. The sweep removes **every** entry of the CLI-owned `.groundwork/`
 * whose name matches `.<dirName>-*`, whatever created it; a failure to
 * remove one only warns. Returns the staging directory's path.
 *
 * @throws `Error` naming the path when either directory is a symlink; the
 * standard `.groundwork/ is incomplete -- re-run` `Error`, with `cause`, when
 * `groundworkDir` cannot be listed for the sweep.
 *
 * @example
 * ```ts
 * const destDir = prepareStaging({ groundworkDir, dirName: "packs", noun: "packs", plural: true });
 * ```
 */
export function prepareStaging(target: StagingTarget): string {
  const destDir = join(target.groundworkDir, target.dirName);
  assertNotSymlink(target.groundworkDir);
  assertNotSymlink(destDir);
  removeStaleWorkDirs(target);
  return destDir;
}

/**
 * Removes the staging directory outright -- what a run with nothing to
 * stage does, so no previous staging outlives it.
 *
 * @throws {@link incompleteStagingError}, with the removal failure as `cause`.
 *
 * @example
 * ```ts
 * clearStaging({ groundworkDir, dirName: "packs", noun: "packs" });
 * ```
 */
export function clearStaging(target: StagingTarget): void {
  const destDir = join(target.groundworkDir, target.dirName);
  try {
    rmSync(destDir, RM_DIR_OPTIONS);
  } catch (cause) {
    throw incompleteStagingError(target.noun, destDir, cause);
  }
}

/**
 * Writes `bytes` to `<rootDir>/<stagedName>` with the exclusive `wx` flag
 * (creating parent directories) and returns their lowercase hex sha256.
 * Re-asserts the CWE-22 containment invariant (docs/assurance-case.md)
 * against the directory actually written to; the caller's plan must already
 * have refused an escaping name.
 *
 * @throws `AssertionError` (message prefixed by `caller`) when the staged
 * path escapes `rootDir`; any write error unchanged.
 *
 * @example
 * ```ts
 * const sha256 = writeStagedBytes("stagePacks", bytes, newDir, "pack.json.staged");
 * ```
 */
export function writeStagedBytes(
  caller: string,
  bytes: Uint8Array,
  rootDir: string,
  stagedName: string,
): string {
  const destPath = join(rootDir, stagedName);
  assert.ok(
    isPathContained(destPath, rootDir),
    `${caller}: staged path ${resolve(destPath)} escapes ${resolve(rootDir)}`,
  );
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, bytes, { flag: "wx" });
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Runs `write` against a fresh `<groundworkDir>/.<dirName>-XXXXXX/<dirName>`
 * directory and, only once it returns, swaps that directory over
 * `<groundworkDir>/<dirName>` by rename -- so a failure part-way through
 * leaves any previous staging intact, and a previous staging is replaced
 * wholesale. Call {@link prepareStaging} first.
 *
 * - If the swap's final rename fails, the previous staging is renamed back.
 *   Only if that restore also fails is the staging directory left absent:
 *   the previous staging then survives, parked inside the work directory,
 *   which is deliberately not removed (a later run's stale-dir sweep does).
 * - The work directory is otherwise always removed; a failure to remove it
 *   only warns, naming its path.
 *
 * @throws {@link ParkedStagingError} when both renames fail; an
 * `AssertionError` unwrapped (a broken invariant is a bug, not something a
 * re-run fixes); otherwise {@link incompleteStagingError} with `cause`.
 *
 * @example
 * ```ts
 * const files = stageAtomically(target, (newDir) =>
 *   [writeStagedBytes("stagePacks", bytes, newDir, "a.txt.staged")],
 * );
 * ```
 */
export function stageAtomically<T>(
  target: StagingTarget,
  write: (newDir: string) => T,
): T {
  const destDir = join(target.groundworkDir, target.dirName);
  let workDir: string | undefined;
  // Set only when the previous staging is parked inside workDir and could
  // not be restored: workDir then holds its only copy and must survive.
  let keepWorkDir = false;
  try {
    mkdirSync(target.groundworkDir, { recursive: true });
    workDir = mkdtempSync(join(target.groundworkDir, `.${target.dirName}-`));
    const newDir = join(workDir, target.dirName);
    mkdirSync(newDir);
    const result = write(newDir);
    swapInto(target, newDir, destDir, join(workDir, "previous"));
    return result;
  } catch (cause) {
    if (cause instanceof ParkedStagingError) {
      keepWorkDir = true;
      throw cause;
    }
    if (cause instanceof assert.AssertionError) {
      // A broken CWE-22 invariant is a bug in the stager, not a transient
      // failure a re-run could fix: surface it as itself.
      throw cause;
    }
    throw incompleteStagingError(target.noun, destDir, cause);
  } finally {
    if (workDir !== undefined && !keepWorkDir) {
      removeBestEffort(workDir);
    }
  }
}
