// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The apply lock (`.claude/rules/headless-mode.md`, "Apply is a journal"):
 * `.groundwork/headless/lock`, created with exclusive create so two parallel
 * fleet runs against one project can never both apply. A held lock is
 * refused, never stolen, waited on or deleted: only the run that created it
 * removes it, and only while it still holds that run's nonce -- an operator
 * may clear a "stale" lock and another run take it in the meantime.
 */
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { assertDirectoryComponent } from "../fs-guard.js";
import { errnoCode } from "../survey/internal/read-guard.js";
import { ApplyError } from "./errors.js";
import {
  NotRegularFileError,
  readRegularNoFollow,
} from "./internal/apply-journal.js";

/** The advice a refused or unreleased lock ends with. */
const STALE_LOCK_ADVICE =
  "if no other groundwork run is using this project, remove it and re-run the CLI";

/**
 * Refuses a symlinked or non-directory `.groundwork` or `.groundwork/headless`,
 * so neither the lock nor anything written beside it can land outside the
 * project. `fs-guard.ts`'s plain `Error` is re-thrown as an {@link ApplyError}.
 */
function assertLockDirectories(root: string): void {
  const groundwork = join(root, ".groundwork");
  try {
    assertDirectoryComponent(groundwork, "remove it and re-run the CLI");
    assertDirectoryComponent(
      join(groundwork, "headless"),
      "remove it and re-run the CLI",
    );
  } catch (cause) {
    throw new ApplyError(
      `refusing to hold the apply lock under ${groundwork}: a symlink, a non-directory or an uninspectable path is in the way -- remove it and re-run the CLI`,
      { cause },
    );
  }
}

/**
 * This run's nonce: the pid plus 16 random hex digits, so two runs of one
 * process at the same instant still differ.
 */
function newNonce(): string {
  return `${String(process.pid)}-${randomBytes(8).toString("hex")}`;
}

/**
 * Creates the lock file exclusively, refusing one that already exists, and
 * writes `pid <pid> <ISO time> <nonce>` into it.
 */
function acquire(root: string, lockPath: string, nonce: string): void {
  assertLockDirectories(root);
  try {
    mkdirSync(join(root, ".groundwork", "headless"), { recursive: true });
  } catch (cause) {
    throw new ApplyError(
      `could not create ${join(root, ".groundwork", "headless")} for the apply lock`,
      { cause },
    );
  }
  // Again after mkdir: a directory swapped for a symlink in between must not
  // receive the lock.
  assertLockDirectories(root);
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (cause) {
    // No cleanup here: a failed exclusive create never made a file, so
    // whatever is at the path (another run's lock) is not this run's.
    throw new ApplyError(
      errnoCode(cause) === "EEXIST"
        ? `another run holds the apply lock ${lockPath} -- ${STALE_LOCK_ADVICE}`
        : `could not create the apply lock ${lockPath}`,
      { cause },
    );
  }
  try {
    writeSync(
      fd,
      `pid ${String(process.pid)} ${new Date().toISOString()} ${nonce}\n`,
    );
  } catch (cause) {
    // The exclusive create succeeded, so the file is this run's own, even
    // though it does not hold the nonce yet.
    try {
      closeSync(fd);
    } catch {
      // Best-effort: the removal below does not need the descriptor.
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best-effort: the write failure below is what the caller needs; a
      // lock left behind is refused, with removal advice, by the next run.
    }
    throw new ApplyError(`could not write the apply lock ${lockPath}`, {
      cause,
    });
  }
  try {
    closeSync(fd);
  } catch {
    // Best-effort: the lock's contents are written; a close failure leaks
    // one descriptor and changes nothing on disk.
  }
}

/**
 * Removes the lock if it still holds `nonce`. A lock that is gone, is no
 * longer a regular file, or holds another nonce is not this run's any more
 * (an operator cleared it and maybe another run took it): it is left
 * alone, and that is not a failure. The check and the removal are two
 * calls, so a lock replaced in between them is still removed; the window is
 * one syscall wide.
 *
 * @throws a read failure other than "gone or not a file", or the removal's
 *   own failure, unchanged.
 */
function release(lockPath: string, nonce: string): void {
  let content: string;
  try {
    content = readRegularNoFollow(lockPath).bytes.toString("utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (
      code === "ENOENT" ||
      code === "ELOOP" ||
      error instanceof NotRegularFileError
    ) {
      return;
    }
    throw error;
  }
  if (!content.includes(nonce)) return;
  rmSync(lockPath, { force: true });
}

/**
 * `fn`'s failure, kept primary although the lock could not be removed after
 * it: an object error is re-thrown itself, with the release failure attached
 * as a non-enumerable `releaseError`; anything else (a thrown primitive, or
 * an error that refuses the property) is wrapped in an {@link ApplyError}
 * naming the lock, with `fn`'s value as its `cause`.
 */
function lockLeftBehind(
  lockPath: string,
  error: unknown,
  releaseError: unknown,
): unknown {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, "releaseError", {
        value: releaseError,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      return error;
    } catch {
      // A frozen or non-extensible error: fall through to the wrapper.
    }
  }
  return new ApplyError(
    `the run failed (${error instanceof Error ? error.message : String(error)}) and the apply lock ${lockPath} could not be removed either -- ${STALE_LOCK_ADVICE}`,
    { cause: error, releaseError },
  );
}

/**
 * Runs `fn` while holding `<root>/.groundwork/headless/lock` and resolves to
 * its value. The lock is created with exclusive create (`wx`) and holds this
 * process's pid, an ISO time and a per-run nonce (the pid plus a random
 * part); it is released once `fn` settles, whether it resolved or threw, and
 * `fn`'s own error is re-thrown as the primary error. Release removes the
 * lock only while it still holds this run's nonce: a lock that was removed
 * or replaced meanwhile (another run's) is left alone, silently, and does
 * not fail the run. When the lock cannot be removed after `fn` threw, that
 * same error carries the removal failure as a non-enumerable `releaseError`
 * (a thrown primitive is instead wrapped in an {@link ApplyError} naming the
 * lock, with `releaseError` set). A missing `.groundwork/headless` directory
 * is created; a symlinked one, or a symlinked `.groundwork`, is refused.
 *
 * @throws {@link ApplyError} when the lock already exists (naming it, with
 *   advice to remove a stale one; the existing lock is left alone and `fn`
 *   never runs), when a lock directory is a symlink or not a directory, when
 *   the lock cannot be created (a failed exclusive create removes nothing),
 *   or when this run's lock cannot be read back or removed after `fn`
 *   succeeded.
 *
 * @example
 * ```ts
 * import { withApplyLock } from "./headless/lock.js";
 *
 * const written = await withApplyLock("/work/app", async () => {
 *   // ...apply the plan...
 *   return 3;
 * });
 * ```
 */
export async function withApplyLock<T>(
  root: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const lockPath = join(root, ".groundwork", "headless", "lock");
  const nonce = newNonce();
  acquire(root, lockPath, nonce);
  let value: T;
  try {
    value = await fn();
  } catch (error) {
    try {
      release(lockPath, nonce);
    } catch (releaseError) {
      throw lockLeftBehind(lockPath, error, releaseError);
    }
    throw error;
  }
  try {
    release(lockPath, nonce);
  } catch (cause) {
    throw new ApplyError(
      `could not remove the apply lock ${lockPath} after a successful run -- remove it before the next run`,
      { cause },
    );
  }
  return value;
}
