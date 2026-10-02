// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one errno discrimination every adopt-mode survey read goes through.
 * A permission failure (`EACCES`/`EPERM`) is a property of the project file
 * itself -- a `chmod 000` left behind, a root-owned file -- so it is recorded
 * in the survey's `undetermined` list and the survey carries on. Anything
 * else (`EIO`, `EMFILE`, ...) says something about the machine, not the
 * project, and is thrown with the path named and the original chained as
 * `cause`, never folded silently in beside a genuine permission problem.
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";

/** The errno codes that mean "this entry exists but this process may not read it". */
const PERMISSION_CODES = new Set(["EACCES", "EPERM"]);

/**
 * A survey read that failed for a reason other than permission. Carries the
 * original failure as `cause`.
 *
 * @example
 * ```ts
 * throw new SurveyReadError("could not read /p/README.md", { cause });
 * ```
 */
export class SurveyReadError extends Error {
  override name = "SurveyReadError";
}

/**
 * The `code` of a Node system error, or `undefined` for anything without a
 * string `code`.
 *
 * @example
 * ```ts
 * errnoCode(Object.assign(new Error("x"), { code: "ENOENT" })); // "ENOENT"
 * ```
 */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  // One read into a local, so the value checked is the value returned.
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * The permission errno carried by `error` (`EACCES`/`EPERM`), or `undefined`
 * when `error` is anything else.
 *
 * @example
 * ```ts
 * permissionCode(Object.assign(new Error("x"), { code: "EACCES" })); // "EACCES"
 * permissionCode(Object.assign(new Error("x"), { code: "EIO" })); // undefined
 * ```
 */
export function permissionCode(error: unknown): string | undefined {
  const code = errnoCode(error);
  return code !== undefined && PERMISSION_CODES.has(code) ? code : undefined;
}

/**
 * The `undetermined` entry recorded for an unreadable path. Identical text
 * for a file and a directory, so two collectors that hit the same
 * unreadable path produce one entry once the aggregate de-duplicates.
 *
 * @example
 * ```ts
 * unreadableNote("/p/CLAUDE.md", "EACCES");
 * // "/p/CLAUDE.md is unreadable (EACCES) -- its contents are not in this survey"
 * ```
 */
export function unreadableNote(path: string, code: string): string {
  return `${path} is unreadable (${code}) -- its contents are not in this survey`;
}

/**
 * Wraps a non-permission read failure on `path` in a {@link SurveyReadError}
 * naming the path, with `cause` as the original failure (which carries the
 * errno code itself).
 *
 * @example
 * ```ts
 * try {
 *   readFileSync(path, "utf8");
 * } catch (cause) {
 *   throw readFailure(path, cause);
 * }
 * ```
 */
export function readFailure(path: string, cause: unknown): SurveyReadError {
  return new SurveyReadError(`could not read ${path}`, { cause });
}

/**
 * The errno codes that mean "nothing is at this path": nothing there
 * (`ENOENT`), an ancestor is a file (`ENOTDIR`), or a symlink that never
 * resolves (`ELOOP`) -- each of which `existsSync` already answered `false`.
 */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/**
 * Whether `path` exists, without `existsSync`'s blind spot: `existsSync`
 * answers `false` for ANY `stat` failure, so a path under a directory this
 * process may not enter (`chmod 000`) reads as silently absent. A `stat`
 * needs search permission on the path's ancestors, never on the path
 * itself, so a permission failure here is recorded in `undetermined` naming
 * the enclosing directory (one entry for every probe under it once the
 * aggregate de-duplicates) and answers `false`; the survey carries on. A
 * genuinely absent path answers `false` with nothing recorded. Any other
 * failure throws a {@link SurveyReadError} naming `path`, with the original
 * as `cause`.
 *
 * @example
 * ```ts
 * if (!guardedExists(settingsPath, undetermined)) return undefined;
 * ```
 */
export function guardedExists(path: string, undetermined: string[]): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    const code = permissionCode(error);
    if (code !== undefined) {
      undetermined.push(unreadableNote(dirname(path), code));
      return false;
    }
    const other = errnoCode(error);
    if (other !== undefined && ABSENT_CODES.has(other)) return false;
    throw new SurveyReadError(`could not check whether ${path} exists`, {
      cause: error,
    });
  }
}

/**
 * Runs `read` against `path`. On a permission failure, records the path and
 * errno in `undetermined` and returns `undefined`; on any other failure,
 * throws a {@link SurveyReadError} chaining the original as `cause`.
 *
 * @example
 * ```ts
 * const content = guardedRead(path, () => readFileSync(path, "utf8"), undetermined);
 * const headings = content === undefined ? [] : extractHeadings(content);
 * ```
 */
export function guardedRead<T>(
  path: string,
  read: () => T,
  undetermined: string[],
): T | undefined {
  try {
    return read();
  } catch (error) {
    const code = permissionCode(error);
    if (code === undefined) throw readFailure(path, error);
    undetermined.push(unreadableNote(path, code));
    return undefined;
  }
}
