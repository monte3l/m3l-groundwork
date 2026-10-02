// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The one symlink refusal adopt mode's staging writers share
 * (`staging.ts`, used by `baseline-stage.ts` and `pack-stage.ts`; `main.ts`'s
 * `.groundwork/` cleanup): a staging directory that is a symlink would
 * redirect a recursive delete or a write outside the adopted project. Also
 * the one recogniser for the "re-run the CLI" advice that refusal (and every
 * other adopt-mode failure) ends with, so a wrapper never states it twice.
 */
import { lstatSync } from "node:fs";

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
export const FIX_AND_RERUN_ADVICE = `fix the cause and ${RERUN_TAIL}`;

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
 * Throws when `path` exists and is a symbolic link; a missing path passes.
 * Uses `lstat`, so the link itself is inspected, never its target. Call it
 * on every staging directory before the first `rm` or write under it.
 *
 * @param advice - What the message ends with after `--`; defaults to
 *   "remove it and re-run the CLI". A caller whose run needs a different
 *   retry (fresh mode's `--fresh --force`) passes its own, so the error
 *   never carries a second, contradicting instruction.
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
export function assertNotSymlink(
  path: string,
  advice = `remove it and ${RERUN_TAIL}`,
): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() === true) {
    throw new Error(
      `refusing to write through a symlink: ${path} -- ${advice}`,
    );
  }
}
