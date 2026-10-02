// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `package.json` read `survey-shape.ts` and `survey-toolchain.ts` share,
 * so the two collectors cannot disagree about what an unreadable or
 * malformed manifest means.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guardedRead } from "./read-guard.js";

/**
 * Reads `dir/package.json` as an object. Absent is `undefined` with nothing
 * recorded; unreadable (`EACCES`/`EPERM`) or unparseable is `undefined` with
 * an `undetermined` entry; any other read failure throws.
 *
 * @example
 * ```ts
 * const undetermined: string[] = [];
 * const manifest = readPackageJson("/path/to/project", undetermined);
 * ```
 */
export function readPackageJson(
  dir: string,
  undetermined: string[],
): Record<string, unknown> | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  const content = guardedRead(
    path,
    () => readFileSync(path, "utf8"),
    undetermined,
  );
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    undetermined.push(
      `could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
