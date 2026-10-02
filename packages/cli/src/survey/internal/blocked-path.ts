// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Tells a genuinely absent path apart from one `probePath` merely folded into
 * "absent". `probePath` answers `absent` for `ENOENT`/`ENOTDIR` -- correct for
 * the survey's own exists-probes -- but that also covers a dangling symlink at
 * the path or at one of its ancestors (`ENOENT`) and a regular file where an
 * ancestor directory should be (`ENOTDIR`). A plan (`conflicts.ts`) or a
 * wiring observation (`packs.ts`) must never read either as "nothing there":
 * both are something in the project's tree a write would have to go through.
 * Shared so the two modules record the same note for the same path.
 */
import { lstatSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { errnoCode, readFailure, unreadableNote } from "./read-guard.js";

// "its target does not exist" reads loosely for a link at the path itself
// whose target resolves through a regular file (`ENOTDIR`) -- that target
// does not exist as a reachable path either. Wording kept as-is: tests
// match on "dangling symlink".
function danglingNote(path: string): string {
  return `${path} is a dangling symlink -- its target does not exist, so its contents are not in this survey`;
}

/**
 * The nearest ancestor of `path`, walking up no further than `root`, that
 * exists and is not a directory -- the component that made a `stat` of
 * `path` fail with `ENOTDIR` -- or `undefined` if none can be established
 * (the tree changed underneath, or the ancestor cannot itself be stat'd).
 */
function blockedAncestor(path: string, root: string): string | undefined {
  let current = dirname(path);
  for (;;) {
    try {
      if (!statSync(current).isDirectory()) return current;
    } catch {
      // This component is itself absent or unreachable: it is not the file
      // blocking the path, so keep walking up. Best effort -- the caller
      // still records the entry with `ENOTDIR` on the path itself.
    }
    const parent = dirname(current);
    if (current === root || parent === current) return undefined;
    current = parent;
  }
}

/**
 * The nearest strict ancestor of `path`, below `root`, that is a symlink
 * whose target does not exist -- the component that made an `lstat` of
 * `path` fail with `ENOENT` -- or `undefined` when every ancestor that
 * exists resolves (the path is genuinely absent).
 */
function danglingAncestor(path: string, root: string): string | undefined {
  for (
    let current = dirname(path);
    current !== root && dirname(current) !== current;
    current = dirname(current)
  ) {
    if (isDanglingSymlink(current)) return current;
  }
  return undefined;
}

/**
 * Whether `path` itself is a symlink whose target does not exist (`lstat`
 * finds a link, `stat` through it fails `ENOENT`). Best effort: the caller
 * only walks here after an `lstat` of a descendant already traversed every
 * existing ancestor, so an ancestor this cannot classify is not the dangling
 * one and answers `false`.
 */
function isDanglingSymlink(path: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
  } catch {
    // Absent or unclassifiable at the link itself: not a dangling symlink.
    return false;
  }
  try {
    statSync(path);
    return false;
  } catch (error) {
    return errnoCode(error) === "ENOENT";
  }
}

/**
 * Why a path `probePath` reported `absent` is not really absent, or
 * `undefined` when nothing is there at all. A symlink at the path itself is
 * named as dangling whenever `stat` through it failed -- its target missing
 * (`ENOENT`) or resolving through a regular file (`ENOTDIR`) alike, since
 * `lstat` finding a link is all this checks. A dangling symlink at an
 * ancestor below `root` is named the same way, but only for a missing target
 * (`ENOENT`); an ancestor link resolving through a regular file surfaces as
 * `ENOTDIR` instead, named by the nearest non-directory ancestor that can be
 * established, else the path itself. A regular file blocking an
 * ancestor is named with `ENOTDIR`; an `lstat` that succeeds on a
 * non-symlink right after `stat` said absent means the tree changed during
 * the survey, and the path is recorded unreadable (`ENOENT`). Any other
 * `lstat` errno throws a `SurveyReadError` naming the path, with the
 * original as `cause`.
 *
 * @example
 * ```ts
 * const probe = probePath(targetPath);
 * if (probe.kind === "absent") {
 *   const note = blockedAbsentNote(targetPath, targetDir);
 *   if (note !== undefined) undetermined.push(note);
 * }
 * ```
 */
export function blockedAbsentNote(
  path: string,
  root: string,
): string | undefined {
  let isSymlink: boolean;
  try {
    isSymlink = lstatSync(path).isSymbolicLink();
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOTDIR") {
      return unreadableNote(blockedAncestor(path, root) ?? path, "ENOTDIR");
    }
    if (code !== "ENOENT") throw readFailure(path, error);
    const ancestor = danglingAncestor(path, root);
    return ancestor === undefined ? undefined : danglingNote(ancestor);
  }
  // `lstat` succeeded after `stat` said absent. A symlink means `stat` could
  // not resolve through it (`ENOENT` or `ENOTDIR`): dangling. A non-symlink
  // means the tree changed during the survey: present, contents unknown.
  return isSymlink ? danglingNote(path) : unreadableNote(path, "ENOENT");
}
