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
 * Removes every entry of `groundworkDir` whose name starts with `prefix` --
 * work directories a crashed earlier run left behind -- best effort (a
 * failure only warns). Nothing else there is touched; a missing
 * `groundworkDir` is a no-op.
 */
function removeStaleWorkDirs(groundworkDir: string, prefix: string): void {
  if (!existsSync(groundworkDir)) {
    return;
  }
  for (const name of readdirSync(groundworkDir)) {
    if (name.startsWith(prefix)) {
      removeBestEffort(join(groundworkDir, name));
    }
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
 * Moves `newDir` into place at `destDir`, parking any previous `destDir` at
 * `parkedDir` first. If the final rename fails the parked copy is renamed
 * back and the rename failure rethrown; if that restore fails too, throws a
 * {@link ParkedStagingError} carrying both errors, naming `parkedDir`, and
 * telling the user to re-run the CLI -- the staging is derived data, so the
 * next run's stale-dir sweep removes the parked copy and regenerates
 * `destDir`.
 */
function swapInto(
  noun: string,
  newDir: string,
  destDir: string,
  parkedDir: string,
): void {
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
        `moving the new ${noun} into ${destDir} failed and restoring the previous one failed too; the previous ${noun} was parked at ${parkedDir} -- fix the cause and re-run the CLI: the staging is derived data, regenerated from the template, and the next run removes the parked copy`,
      );
    }
    throw error;
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
}

/**
 * The first step of every staging run: refuses a symlinked `groundworkDir`
 * or `<groundworkDir>/<dirName>` (before anything is deleted or written),
 * then sweeps the `.<dirName>-*` work directories a crashed earlier run
 * left (best effort). Returns the staging directory's path.
 *
 * @throws `Error` naming the path when either directory is a symlink.
 *
 * @example
 * ```ts
 * const destDir = prepareStaging({ groundworkDir, dirName: "packs", noun: "packs" });
 * ```
 */
export function prepareStaging(target: StagingTarget): string {
  const destDir = join(target.groundworkDir, target.dirName);
  assertNotSymlink(target.groundworkDir);
  assertNotSymlink(destDir);
  removeStaleWorkDirs(target.groundworkDir, `.${target.dirName}-`);
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
    swapInto(target.noun, newDir, destDir, join(workDir, "previous"));
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
