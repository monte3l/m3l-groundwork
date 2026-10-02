// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Whether `chmodSync` cannot produce an enforceable permission change in
 * this environment: a root process ignores file/directory permission bits
 * entirely, and Windows has no POSIX chmod semantics. `true` means a test
 * that induces an `EACCES`/`EPERM` via `chmodSync` must skip itself rather
 * than assert a false positive -- shared by every suite that needs this
 * (previously duplicated verbatim in `plugin-existing-unreadable.test.ts`
 * and `plugin-payload-read.test.ts`).
 */
export const chmodIneffective: boolean =
  process.getuid?.() === 0 || process.platform === "win32";
