// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The project reads the upgrade plan (`plan.ts`) and stamp (`stamp.ts`) steps
 * share: the `lstat`-first walk that reads one project file without following
 * a symlink, and the token-table comparison. One owner, so the two steps
 * refuse the same trees with the same wording.
 */
import { lstatSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { isProjectRelativePath } from "../manifest.js";
import { isAbsentError } from "../survey/internal/read-guard.js";

/** `lstat` without following a link; `undefined` when nothing is there. */
function inspect(abs: string, relPath: string): Stats | undefined {
  try {
    return lstatSync(abs, { throwIfNoEntry: false });
  } catch (cause) {
    if (isAbsentError(cause)) return undefined;
    throw new Error(`could not inspect ${relPath} in the project`, { cause });
  }
}

/**
 * The bytes of the project file at `relPath`, or `undefined` when it (or an
 * ancestor directory) is missing. Each component is `lstat`ed and never
 * followed: a symlink anywhere on the way, a non-directory ancestor or a
 * non-regular file is refused, naming the path. `verb` names the step in a
 * refusal (`refusing to <verb> ...`). `checkedDirs` caches the ancestors
 * already checked across calls. The walk is check-then-read: a component
 * swapped for a link between the `lstat` and the read is followed.
 *
 * @throws `Error` naming the path: for a path that is not relative and
 *   inside the project, a symlink or non-directory ancestor, or a symlink,
 *   directory or other non-regular file; with `cause` when an `lstat` fails
 *   other than "absent" or the read fails.
 *
 * @example
 * ```ts
 * import { readProjectFile } from "./upgrade/project-read.js";
 *
 * const bytes = readProjectFile("/work/app", "package.json", new Set(), "stamp");
 * ```
 */
export function readProjectFile(
  targetDir: string,
  relPath: string,
  checkedDirs: Set<string>,
  verb: string,
): Buffer | undefined {
  if (!isProjectRelativePath(relPath)) {
    throw new Error(
      `refusing to ${verb} ${JSON.stringify(relPath)}: not a relative, /-separated path inside the project`,
    );
  }
  const segments = relPath.split("/");
  for (let depth = 1; depth < segments.length; depth++) {
    const dirRel = segments.slice(0, depth).join("/");
    if (checkedDirs.has(dirRel)) continue;
    const stat = inspect(join(targetDir, dirRel), dirRel);
    if (stat === undefined) return undefined;
    // `lstat` never reports a symlink as a directory, so this refuses both.
    if (!stat.isDirectory()) {
      throw new Error(
        `refusing to ${verb} ${relPath}: ${dirRel} is a symlink or not a directory -- replace it with a real directory`,
      );
    }
    checkedDirs.add(dirRel);
  }
  const abs = join(targetDir, relPath);
  const stat = inspect(abs, relPath);
  if (stat === undefined) return undefined;
  if (!stat.isFile()) {
    throw new Error(
      `refusing to ${verb} ${relPath}: it is a symlink, a directory or another non-regular file -- replace it with a regular file`,
    );
  }
  try {
    return readFileSync(abs);
  } catch (cause) {
    throw new Error(`could not read ${relPath} in the project`, { cause });
  }
}

/**
 * Whether two token tables hold the same keys with the same values, reading
 * own properties only.
 *
 * @example
 * ```ts
 * import { sameTokens } from "./upgrade/project-read.js";
 *
 * sameTokens({ YEAR: "2026" }, { YEAR: "2026" }); // true
 * ```
 */
export function sameTokens(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const own = (
    record: Readonly<Record<string, string>>,
    key: string,
  ): string | undefined =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key, i) => key === bKeys[i] && own(a, key) === own(b, key))
  );
}
