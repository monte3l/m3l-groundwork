// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one symlink refusal adopt mode's staging writers share
 * (`baseline-stage.ts`, `packs.ts`'s `stagePackFiles`, `main.ts`'s
 * `.groundwork/` cleanup): a staging directory that is a symlink would
 * redirect a recursive delete or a write outside the adopted project.
 */
import { lstatSync } from "node:fs";

/**
 * Throws when `path` exists and is a symbolic link; a missing path passes.
 * Uses `lstat`, so the link itself is inspected, never its target. Call it
 * on every staging directory before the first `rm` or write under it.
 *
 * @throws `Error` naming `path` when it is a symlink.
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
export function assertNotSymlink(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() === true) {
    throw new Error(
      `refusing to write through a symlink: ${path} -- remove it and re-run the CLI`,
    );
  }
}
