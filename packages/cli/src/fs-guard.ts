// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one symlink refusal adopt mode's staging writers share
 * (`staging.ts`, used by `baseline-stage.ts` and `pack-stage.ts`; `main.ts`'s
 * `.groundwork/` cleanup): a staging directory that is a symlink would
 * redirect a recursive delete or a write outside the adopted project. Also
 * the one recogniser for the "re-run the CLI" advice that refusal (and every
 * other adopt-mode failure) ends with, so a wrapper never states it twice.
 * Fresh mode's writers (`emit.ts`, `plugin.ts`) share the same refusals with
 * fresh mode's own single retry instruction ({@link FRESH_RETRY}) instead.
 */
import { lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsentError, permissionCode } from "./survey/internal/read-guard.js";

/** The tail every adopt-mode re-run instruction ends with, {@link assertNotSymlink}'s default advice included. */
const RERUN_TAIL = "re-run the CLI";

/**
 * Adopt mode's generic re-run instruction, stated once so every adopt-mode
 * failure that appends it (`main.ts`'s post-point-of-no-return error, the
 * guarded `/customize` install) words it identically. Ends with the tail
 * {@link endsWithRerunAdvice} recognises.
 *
 * @example
 * ```ts
 * import { FIX_AND_RERUN_ADVICE, endsWithRerunAdvice } from "./fs-guard.js";
 *
 * const message = `could not write x: EACCES; ${FIX_AND_RERUN_ADVICE}`;
 * endsWithRerunAdvice(message); // true
 * ```
 */
export const FIX_AND_RERUN_ADVICE: string = `fix the cause and ${RERUN_TAIL}`;

/**
 * Whether `message` already ENDS with "re-run the CLI" advice, in any
 * wording that ends that way (e.g. {@link assertNotSymlink}'s "remove it and
 * re-run the CLI", or "fix the cause and re-run the CLI"), so a caller about
 * to append its own re-run advice can skip it rather than state it twice.
 * End-anchored: the phrase appearing earlier in the message -- e.g. inside
 * an embedded path -- does not count.
 *
 * @example
 * ```ts
 * import { endsWithRerunAdvice } from "./fs-guard.js";
 *
 * endsWithRerunAdvice("x is a symlink -- remove it and re-run the CLI"); // true
 * endsWithRerunAdvice("could not write /tmp/re-run the CLI/a: EACCES"); // false
 * ```
 */
export function endsWithRerunAdvice(message: string): boolean {
  return message.endsWith(RERUN_TAIL);
}

/**
 * Fresh mode's retry instruction. Its target is no longer empty after a
 * failed write, so a plain re-run would adopt it; only `--fresh --force`
 * repeats that run. Never contains adopt mode's bare "re-run the CLI".
 *
 * @example
 * ```ts
 * import { FRESH_RETRY } from "./fs-guard.js";
 *
 * const advice = `fix the cause, then ${FRESH_RETRY}`;
 * ```
 */
export const FRESH_RETRY = "retry the same command with --fresh --force added";

/**
 * The advice for a permission failure (`EACCES`/`EPERM`) inspecting a path:
 * "remove it" (the symlink refusal's remedy) would be wrong there, so the
 * caller's `advice` is replaced by a permissions fix that keeps the same
 * mode-specific retry -- fresh mode's {@link FRESH_RETRY}, or adopt mode's
 * "re-run the CLI" (so {@link endsWithRerunAdvice} still recognises it). A
 * caller advice ending with neither is kept whole after the permissions fix,
 * so its own retry is never dropped.
 */
function permissionAdvice(advice: string): string {
  if (advice.endsWith(FRESH_RETRY)) {
    return `fix its permissions, then ${FRESH_RETRY}`;
  }
  if (endsWithRerunAdvice(advice)) {
    return `fix its permissions and ${RERUN_TAIL}`;
  }
  return `fix its permissions; ${advice}`;
}

/**
 * `lstat` without its one blind spot: `throwIfNoEntry: false` only answers a
 * missing path with `undefined`, so any other failure (most realistically
 * `EACCES` on a search-permission-denied ancestor) would escape raw -- no
 * path in a readable message, no retry advice. An absent path (`ENOENT`, or
 * `ENOTDIR` below a regular file) answers `undefined`, leaving the write
 * that follows to raise its own error; anything else is wrapped here once,
 * naming `path`, with the original as `cause`. A permission failure ends
 * with {@link permissionAdvice}'s permissions fix; any other ends with
 * `advice` unchanged.
 */
function inspect(path: string, advice: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (cause) {
    if (isAbsentError(cause)) return undefined;
    const code = permissionCode(cause);
    if (code !== undefined) {
      throw new Error(
        `could not inspect ${path}: permission denied (${code}) -- ${permissionAdvice(advice)}`,
        { cause },
      );
    }
    throw new Error(`could not inspect ${path} -- ${advice}`, { cause });
  }
}

/**
 * Throws when `path` exists and is a symbolic link; a missing path passes.
 * Uses `lstat`, so the link itself is inspected, never its target. Call it
 * on every staging directory before the first `rm` or write under it.
 *
 * @param advice - What the message ends with after `--`; defaults to
 *   "remove it and re-run the CLI". A caller whose run needs a different
 *   retry (fresh mode's `--fresh --force`) passes its own, so the error
 *   never carries a second, contradicting instruction.
 * @throws `Error` naming `path` when it is a symlink, or when it cannot be
 *   inspected at all (any `lstat` failure but `ENOENT`/`ENOTDIR`, chained
 *   as `cause`).
 *
 * @example
 * ```ts
 * import { rmSync } from "node:fs";
 * import { assertNotSymlink } from "./fs-guard.js";
 *
 * assertNotSymlink("/work/app/.groundwork"); // throws if it's a symlink
 * rmSync("/work/app/.groundwork/inventory.json", { force: true });
 * ```
 */
export function assertNotSymlink(
  path: string,
  advice = `remove it and ${RERUN_TAIL}`,
): void {
  const stat = inspect(path, advice);
  if (stat?.isSymbolicLink() === true) {
    throw new Error(
      `refusing to write through a symlink: ${path} -- ${advice}`,
    );
  }
}

/**
 * Throws when `path` exists and is not a real directory -- a symlink
 * (dangling or not) or a file where a writer needs a directory. A missing
 * path passes. Uses `lstat`, so a symlinked directory is refused rather
 * than followed out of the tree being written.
 *
 * @param advice - What the message ends with after `--`, same convention as
 *   {@link assertNotSymlink}'s.
 * @throws `Error` naming `path` when it is a symlink or a non-directory, or
 *   when it cannot be inspected (the original chained as `cause`).
 *
 * @example
 * ```ts
 * import { assertDirectoryComponent, FRESH_SYMLINK_ADVICE } from "./fs-guard.js";
 *
 * assertDirectoryComponent("/work/app/.claude", FRESH_SYMLINK_ADVICE);
 * ```
 */
export function assertDirectoryComponent(path: string, advice: string): void {
  assertNotSymlink(path, advice);
  const stat = inspect(path, advice);
  if (stat !== undefined && !stat.isDirectory()) {
    throw new Error(
      `refusing to write under a non-directory: ${path} -- ${advice}`,
    );
  }
}

/**
 * Throws when `path` exists and cannot be written as a plain file -- a
 * symlink (dangling or not), which a write would follow, or a directory,
 * which a write would fail on only after earlier writes had landed. A
 * missing path or an existing regular file passes. Uses `lstat`, so the
 * entry itself is inspected, never a link's target.
 *
 * @param advice - What the message ends with after `--`, same convention as
 *   {@link assertNotSymlink}'s.
 * @throws `Error` naming `path` when it is a symlink or a directory, or
 *   when it cannot be inspected (the original chained as `cause`).
 *
 * @example
 * ```ts
 * import { assertFileDestination, FRESH_SYMLINK_ADVICE } from "./fs-guard.js";
 *
 * assertFileDestination("/work/app/tsconfig.json", FRESH_SYMLINK_ADVICE);
 * ```
 */
export function assertFileDestination(path: string, advice: string): void {
  assertNotSymlink(path, advice);
  assertNotDirectory(path, advice);
}

/**
 * Throws when `path` exists and is a real directory, which a file write
 * would fail on only after earlier writes had landed. A missing path, a
 * file, or a symlink passes -- for a destination whose writer replaces a
 * symlink rather than following it (fresh mode's `/customize` install),
 * this is the one shape left to refuse up front. Uses `lstat`.
 *
 * @param advice - What the message ends with after `--`, same convention as
 *   {@link assertNotSymlink}'s.
 * @throws `Error` naming `path` when it is a directory, or when it cannot be
 *   inspected (the original chained as `cause`).
 *
 * @example
 * ```ts
 * import { assertNotDirectory, FRESH_SYMLINK_ADVICE } from "./fs-guard.js";
 *
 * assertNotDirectory("/work/app/.claude/skills/customize/SKILL.md", FRESH_SYMLINK_ADVICE);
 * ```
 */
export function assertNotDirectory(path: string, advice: string): void {
  const stat = inspect(path, advice);
  if (stat?.isDirectory() === true) {
    throw new Error(
      `refusing to write a file over a directory: ${path} -- ${advice}`,
    );
  }
}

/**
 * Fresh mode's advice for a refused destination path (a symlink, or a
 * non-directory where a directory is needed), replacing
 * {@link assertNotSymlink}'s adopt-mode default. Carries {@link FRESH_RETRY}
 * exactly once.
 *
 * @example
 * ```ts
 * import { assertNotSymlink, FRESH_SYMLINK_ADVICE } from "./fs-guard.js";
 *
 * assertNotSymlink("/work/app/package.json", FRESH_SYMLINK_ADVICE);
 * ```
 */
export const FRESH_SYMLINK_ADVICE: string = `remove it, then ${FRESH_RETRY}`;
