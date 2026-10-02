// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one errno discrimination every adopt-mode survey read goes through.
 * A permission failure (`EACCES`/`EPERM`) is a property of the project file
 * itself -- a `chmod 000` left behind, a root-owned file -- so it is recorded
 * in the survey's `undetermined` list and the survey carries on; so is a
 * dangling symlink (`ENOENT`), a symlink loop (`ELOOP`) or a directory where
 * a file was expected (`EISDIR`) met on a read. Anything
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
 * (`ENOENT`) or an ancestor is a file (`ENOTDIR`). The one definition every
 * survey probe (`guardedExists`, `fs-walk.ts`'s `walkBounded`) and
 * `jsonc.ts`'s `readJsoncFile` share, so they cannot disagree on what
 * "absent" means. `ELOOP` is deliberately NOT here: a symlink loop is
 * something at the path this process cannot resolve, not an absence -- see
 * {@link UNRESOLVABLE_CODE}.
 */
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/**
 * The errno a symlink loop raises: an entry exists at the path, but it never
 * resolves. Recorded like a permission failure, never folded into "absent".
 */
const UNRESOLVABLE_CODE = "ELOOP";

/**
 * Whether `error` carries an errno that means "nothing is at this path"
 * (`ENOENT`/`ENOTDIR`).
 *
 * @example
 * ```ts
 * isAbsentError(Object.assign(new Error("x"), { code: "ENOENT" })); // true
 * isAbsentError(Object.assign(new Error("x"), { code: "ELOOP" })); // false
 * ```
 */
export function isAbsentError(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && ABSENT_CODES.has(code);
}

/**
 * The errno to record when `error` says the path holds something this
 * process cannot read or resolve -- a permission code (`EACCES`/`EPERM`) or
 * a symlink loop (`ELOOP`) -- or `undefined` for anything else.
 *
 * @example
 * ```ts
 * unresolvableCode(Object.assign(new Error("x"), { code: "ELOOP" })); // "ELOOP"
 * unresolvableCode(Object.assign(new Error("x"), { code: "EIO" })); // undefined
 * ```
 */
export function unresolvableCode(error: unknown): string | undefined {
  const permission = permissionCode(error);
  if (permission !== undefined) return permission;
  return errnoCode(error) === UNRESOLVABLE_CODE ? UNRESOLVABLE_CODE : undefined;
}

/**
 * What a `stat` on a path established: something is there, nothing is there,
 * or something is there (or may be) that this process cannot reach --
 * carrying the errno that says why.
 */
export type PathProbe =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unresolvable"; readonly code: string };

/**
 * Probes `path` with a real `stat`, never `existsSync` (which answers
 * `false` for ANY failure, so a file under a `chmod 000` directory reads as
 * absent). `ENOENT`/`ENOTDIR` is `absent`; `EACCES`/`EPERM`/`ELOOP` is
 * `unresolvable` with the errno -- never folded into `absent`. Any other
 * failure throws a {@link SurveyReadError} naming `path`, with the original
 * as `cause`.
 *
 * @example
 * ```ts
 * const probe = probePath(targetPath);
 * if (probe.kind === "unresolvable") undetermined.push(unreadableNote(targetPath, probe.code));
 * ```
 */
export function probePath(path: string): PathProbe {
  try {
    statSync(path);
    return { kind: "present" };
  } catch (error) {
    if (isAbsentError(error)) return { kind: "absent" };
    const code = unresolvableCode(error);
    if (code !== undefined) return { kind: "unresolvable", code };
    throw new SurveyReadError(`could not check whether ${path} exists`, {
      cause: error,
    });
  }
}

/**
 * The path an `undetermined` note names when a `stat` of `path` failed with
 * `code` (from {@link probePath}'s `unresolvable` result). A `stat` needs
 * search permission on the path's ancestors, never on the path itself, so a
 * permission failure names the enclosing directory -- one entry for every
 * probe under it once the caller de-duplicates. A symlink loop (`ELOOP`) is
 * a property of the path itself, so it names `path`.
 *
 * @example
 * ```ts
 * const probe = probePath(targetPath);
 * if (probe.kind === "unresolvable") {
 *   undetermined.push(unreadableNote(probeSubject(targetPath, probe.code), probe.code));
 * }
 * ```
 */
export function probeSubject(path: string, code: string): string {
  return code === UNRESOLVABLE_CODE ? path : dirname(path);
}

/**
 * Whether `path` exists, without `existsSync`'s blind spot: `existsSync`
 * answers `false` for ANY `stat` failure, so a path under a directory this
 * process may not enter (`chmod 000`) reads as silently absent. A `stat`
 * needs search permission on the path's ancestors, never on the path
 * itself, so a permission failure here is recorded in `undetermined` naming
 * the enclosing directory (one entry for every probe under it once the
 * aggregate de-duplicates) and answers `false`; the survey carries on. A
 * symlink loop (`ELOOP`) is a property of the path itself, so it is
 * recorded naming `path` and answers `false`. A genuinely absent path
 * (`ENOENT`/`ENOTDIR`) answers `false` with nothing recorded. Any other
 * failure throws a {@link SurveyReadError} naming `path`, with the original
 * as `cause`.
 *
 * @example
 * ```ts
 * if (!guardedExists(settingsPath, undetermined)) return undefined;
 * ```
 */
export function guardedExists(path: string, undetermined: string[]): boolean {
  const probe = probePath(path);
  if (probe.kind === "present") return true;
  if (probe.kind === "absent") return false;
  undetermined.push(unreadableNote(probeSubject(path, probe.code), probe.code));
  return false;
}

/**
 * The non-permission errnos a read of an already-discovered path records
 * rather than throws: the entry is a dangling symlink (`ENOENT`), a symlink
 * loop (`ELOOP`), or a directory where a file was expected (`EISDIR`). Each
 * is a property of the project's own tree, like a permission failure -- not
 * of the machine, like `EIO`/`EMFILE`.
 */
const RECORDED_READ_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  UNRESOLVABLE_CODE,
  "EISDIR",
]);

/**
 * The errno to record when a read of an already-discovered path failed for a
 * reason that is a property of the project's own tree -- `EACCES`/`EPERM`,
 * `ENOENT` (a dangling symlink), `ELOOP` or `EISDIR` -- or `undefined` for
 * anything else (`EIO`, `EMFILE`, ...), which the caller throws.
 *
 * @example
 * ```ts
 * recordedReadCode(Object.assign(new Error("x"), { code: "EISDIR" })); // "EISDIR"
 * recordedReadCode(Object.assign(new Error("x"), { code: "EIO" })); // undefined
 * ```
 */
export function recordedReadCode(error: unknown): string | undefined {
  const permission = permissionCode(error);
  if (permission !== undefined) return permission;
  const code = errnoCode(error);
  return code !== undefined && RECORDED_READ_CODES.has(code) ? code : undefined;
}

/**
 * Runs `read` against `path`. On a failure that is a property of the
 * project's own tree -- a permission failure (`EACCES`/`EPERM`), a dangling
 * symlink (`ENOENT`), a symlink loop (`ELOOP`), or a directory where a file
 * was expected (`EISDIR`) -- records the path and errno in `undetermined`
 * and returns `undefined`. On any other failure (`EIO`, `EMFILE`, ...),
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
    const code = recordedReadCode(error);
    if (code === undefined) throw readFailure(path, error);
    undetermined.push(unreadableNote(path, code));
    return undefined;
  }
}
