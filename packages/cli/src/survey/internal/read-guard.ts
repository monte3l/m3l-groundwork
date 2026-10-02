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
