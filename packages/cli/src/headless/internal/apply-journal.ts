// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The private half of `headless/apply.ts`: the no-follow file primitives the
 * executor and its rollback share, and the apply journal
 * (`.groundwork/headless/txn/journal.json`) -- its shape, its strict parser
 * and the per-step undo both an in-process rollback and the next run's
 * recovery use.
 *
 * Undo is decided by hashes, not by remembering what landed: a step whose
 * target still holds the bytes it found is already fine (checked before its
 * backup is needed), one whose target holds the bytes it wrote is reverted,
 * and anything else (an edit made since, a deletion, a directory, a
 * symlink, a missing backup) is a leftover the operator must look at,
 * reported with a reason. That is what lets the next run recover a journal
 * whose run died part-way without knowing which steps had landed.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { assertDirectoryComponent } from "../../fs-guard.js";
import { isProjectRelativePath, sha256Hex } from "../../manifest.js";
import { isRecord } from "../../merge-json.js";
import { errnoCode } from "../../survey/internal/read-guard.js";
import { foldPath, isGitSegment, segmentProblem } from "../contract.js";

/** The three action kinds that write a project file. */
export type WriteKind = "install-staged" | "take-divergent" | "merge-keys";

/** What a replaced file held before the run: its hash, permission bits and backup name under `txn/backup/`. */
interface StepBefore {
  readonly sha256: string;
  readonly mode: number;
  readonly backup: string;
}

/**
 * One journaled write: `before` is `null` for an `install-staged` (nothing
 * was there) and set otherwise; `createdDirs` are the project-relative
 * directories the step creates for its file, outermost first.
 */
export interface JournalStep {
  readonly kind: WriteKind;
  readonly path: string;
  readonly sha256After: string;
  readonly before: StepBefore | null;
  readonly createdDirs: readonly string[];
}

const JOURNAL_SCHEMA = "groundwork.apply-journal";
const JOURNAL_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BACKUP_NAME_PATTERN = /^[0-9]+$/;
const WRITE_KINDS: Readonly<Record<WriteKind, true>> = {
  "install-staged": true,
  "take-divergent": true,
  "merge-keys": true,
};
/** A temp file's bits until it is synced: owner read-write, so it can be reopened for the fsync. */
const TEMP_MODE = 0o600;

/**
 * `O_NOFOLLOW` refuses a symlink as the last component (`ELOOP`) and
 * `O_NONBLOCK` keeps a FIFO planted at the path from hanging the open.
 * Windows defines neither; a bitwise OR with `undefined` contributes 0.
 */
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A regular file's bytes, mode bits and owner, read without following a symlink. */
export interface RegularFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly uid: number;
}

/** Thrown by {@link readRegularNoFollow} when the path opened is not a regular file. */
export class NotRegularFileError extends Error {
  override readonly name = "NotRegularFileError";
}

/**
 * Reads `path` as a regular file through one descriptor opened with
 * `O_NOFOLLOW`, so a symlink is refused and the bytes hashed are the bytes
 * of the very entry that was checked.
 *
 * @throws {@link NotRegularFileError} for a directory or another non-file;
 *   any open/read error unchanged (`ELOOP` for a symlink, `ENOENT`, ...).
 */
export function readRegularNoFollow(path: string): RegularFile {
  const fd = openSync(path, READ_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new NotRegularFileError(`${path} is not a regular file`);
    }
    return {
      bytes: readFileSync(fd),
      mode: stat.mode & 0o7777,
      uid: stat.uid,
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort: the read outcome above is what matters.
    }
  }
}

/**
 * A `.git` spelling the executor refuses on top of `contract.ts`'s
 * {@link isGitSegment} (`.git`, `git~1`): `.git~1`, kept from the
 * executor's earlier, stricter list. Compared after {@link foldPath}.
 */
const EXTRA_GIT_SEGMENT = ".git~1";

/**
 * Why the executor must never write `relPath`, or `undefined` when it may:
 * a segment the answers validator refuses (`contract.ts`'s
 * {@link segmentProblem}: a trailing dot or space, a colon, ...), a first
 * segment that folds (NFC, upper, lower case: {@link foldPath}) to
 * `.groundwork`, or a `.git` segment at any depth ({@link isGitSegment}, or
 * `.git~1`). The same rules gate a plan's write paths and a leftover
 * journal's step paths.
 *
 * @example
 * ```ts
 * import { writePathProblem } from "./headless/internal/apply-journal.js";
 *
 * writePathProblem(".git/config"); // "it has a .git segment ..."
 * writePathProblem("src/index.ts"); // undefined
 * ```
 */
export function writePathProblem(relPath: string): string | undefined {
  const segments = relPath.split("/");
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== undefined) return `its path ${problem}`;
  }
  if (foldPath(segments[0] ?? "") === ".groundwork") {
    return "it is under .groundwork/, which an apply never writes";
  }
  if (
    segments.some(
      (segment) =>
        isGitSegment(segment) || foldPath(segment) === EXTRA_GIT_SEGMENT,
    )
  ) {
    return "it has a .git segment (ignoring case, or an 8.3 short name), and an apply never writes inside a git directory";
  }
  return undefined;
}

/**
 * Flushes `path` to disk: a file through a read-write descriptor (Windows
 * flushes only a writable handle), a directory -- so the entries created or
 * renamed in it are durable -- through a read-only one. A directory fsync is
 * best effort: some platforms (Windows) and filesystems cannot open or sync a
 * directory, and nothing else can be done about that. A file fsync failure
 * is thrown.
 */
export function fsyncPath(path: string, kind: "file" | "dir"): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, kind === "file" ? "r+" : "r");
    fsyncSync(fd);
  } catch (error) {
    if (kind === "file") throw error;
    // A directory that cannot be opened or synced here is the documented
    // best-effort limit (see above), not a failure of the run.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort: the sync is what matters; a close failure leaks one
        // descriptor and changes nothing on disk.
      }
    }
  }
}

/**
 * Creates `path` with exclusive create (`wx`, so an existing entry --
 * a file, a symlink -- is never opened), calls `opened` as soon as the
 * descriptor exists (the file is this process's from then on, whatever it
 * holds), then writes every byte through that descriptor and fsyncs it.
 *
 * @throws any open, write or sync error unchanged; `opened` has run iff the
 *   open succeeded.
 */
export function createFile(
  path: string,
  bytes: Uint8Array,
  opened: () => void,
): void {
  const fd = openSync(path, "wx");
  try {
    opened();
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort: the bytes are written and synced above; a close
      // failure leaks one descriptor and changes nothing on disk.
    }
  }
}

/**
 * The permission bits of a mode. A journal records, and a replace applies,
 * only these: setuid, setgid and sticky are never restored or kept, and a
 * recorded mode carrying one is refused as tampered.
 */
export const PERMISSION_BITS = 0o777;

/** Group- and world-write bits: a leftover journal or backup carrying either is not trusted. */
const SHARED_WRITE_BITS = 0o022;

/**
 * Why a leftover `txn/` regular file (the journal or a backup), given its
 * owner and mode, is not trusted, or `undefined` when it is. Trusted means
 * what this executor writes: owned by this process's uid and neither group-
 * nor world-writable, so another local user could not have planted or
 * edited it to steer a recovery's writes. (That it is a regular file, not a
 * symlink, is the caller's check.) Windows has neither POSIX ownership nor
 * these bits, so the check is skipped there.
 */
export function untrustedReason(stat: {
  readonly uid: number;
  readonly mode: number;
}): string | undefined {
  if (process.platform === "win32") return undefined;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    return `it is owned by uid ${String(stat.uid)}, not by this process's uid ${String(uid)}`;
  }
  if ((stat.mode & SHARED_WRITE_BITS) !== 0) {
    return `it is group- or world-writable (mode ${(stat.mode & PERMISSION_BITS).toString(8)})`;
  }
  return undefined;
}

/**
 * Replaces `path` with `bytes` through a temp file in the same directory
 * and a rename, so the target holds either its old or its new bytes, never
 * a mix, and a symlink swapped in at `path` is replaced rather than
 * followed. The temp file's bytes are fsynced before the rename (it is
 * created owner read-write so it can be reopened for the sync, then given
 * `mode` explicitly, since a create is subject to the umask -- permission
 * bits only: a setuid, setgid or sticky bit is never carried over); the rename
 * itself is durable once the caller fsyncs the directory. The temp file is
 * removed if anything fails.
 */
export function replaceFile(
  path: string,
  bytes: Uint8Array | string,
  mode: number,
): void {
  const temp = join(
    dirname(path),
    `.${basename(path)}.groundwork-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: TEMP_MODE });
    fsyncPath(temp, "file");
    chmodSync(temp, mode & PERMISSION_BITS);
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best-effort: the write failure being re-thrown is what matters.
    }
    throw error;
  }
}

/**
 * The project-relative directories above `relPath` that do not exist yet,
 * outermost first. Every existing one must be a real directory: a symlink
 * or a file on the way is refused (`fs-guard.ts`'s `Error`, naming it).
 */
export function missingAncestors(root: string, relPath: string): string[] {
  const segments = relPath.split("/").slice(0, -1);
  const missing: string[] = [];
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const rel = segments.slice(0, depth).join("/");
    if (missing.length > 0) {
      missing.push(rel);
      continue;
    }
    const abs = join(root, rel);
    assertDirectoryComponent(abs, "remove it and re-run the CLI");
    if (lstatSync(abs, { throwIfNoEntry: false }) === undefined) {
      missing.push(rel);
    }
  }
  return missing;
}

/** Whether every existing directory above `relPath` is still a real directory. */
function ancestorsAreReal(root: string, relPath: string): boolean {
  try {
    missingAncestors(root, relPath);
    return true;
  } catch {
    // A refusal here only means "do not touch this path": the caller
    // reports it as a leftover, naming the path.
    return false;
  }
}

/** The journal document for `steps`, as written to `txn/journal.json`. */
export function serializeJournal(steps: readonly JournalStep[]): string {
  return `${JSON.stringify(
    { schema: JOURNAL_SCHEMA, schemaVersion: JOURNAL_SCHEMA_VERSION, steps },
    null,
    2,
  )}\n`;
}

function parseBefore(value: unknown): StepBefore | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { sha256, mode, backup } = value;
  return typeof sha256 === "string" &&
    SHA256_PATTERN.test(sha256) &&
    typeof mode === "number" &&
    Number.isInteger(mode) &&
    mode >= 0 &&
    mode <= PERMISSION_BITS &&
    typeof backup === "string" &&
    BACKUP_NAME_PATTERN.test(backup)
    ? { sha256, mode, backup }
    : undefined;
}

function parseStep(value: unknown): JournalStep | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, path, sha256After, createdDirs } = value;
  const before = parseBefore(value["before"]);
  if (
    typeof kind !== "string" ||
    !Object.hasOwn(WRITE_KINDS, kind) ||
    typeof path !== "string" ||
    !isProjectRelativePath(path) ||
    writePathProblem(path) !== undefined ||
    typeof sha256After !== "string" ||
    !SHA256_PATTERN.test(sha256After) ||
    before === undefined ||
    (kind === "install-staged") !== (before === null) ||
    !Array.isArray(createdDirs)
  ) {
    return undefined;
  }
  const dirs: string[] = [];
  for (const dir of createdDirs) {
    // Only directories strictly above the step's own file may be removed.
    if (typeof dir !== "string" || !path.startsWith(`${dir}/`)) {
      return undefined;
    }
    if (!isProjectRelativePath(dir)) return undefined;
    dirs.push(dir);
  }
  return {
    kind: kind as WriteKind,
    path,
    sha256After,
    before,
    createdDirs: dirs,
  };
}

/**
 * Parses a journal's text, or returns `undefined` for anything that is not
 * exactly the shape {@link serializeJournal} writes (not JSON, not an
 * object, another schema or version, a malformed step, a step path the
 * executor would refuse, or one step path listed twice). The caller refuses
 * an `undefined` rather than guessing what to roll back.
 */
export function parseJournal(text: string): readonly JournalStep[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unparsable is one of the shapes the caller refuses by name.
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed["schema"] !== JOURNAL_SCHEMA ||
    parsed["schemaVersion"] !== JOURNAL_SCHEMA_VERSION ||
    !Array.isArray(parsed["steps"])
  ) {
    return undefined;
  }
  const steps: JournalStep[] = [];
  const seen = new Set<string>();
  for (const raw of parsed["steps"] as unknown[]) {
    const step = parseStep(raw);
    if (step === undefined) return undefined;
    // The executor refuses a plan naming one path twice (folded the same
    // way), so a journal that does was not written by it.
    const key = foldPath(step.path);
    if (seen.has(key)) return undefined;
    seen.add(key);
    steps.push(step);
  }
  return steps;
}

/**
 * What undoing one step did: `restored` (it reverted a write), `unchanged`
 * (the target already held what it held before the step) or `leftover`
 * (`reason` says why, naming the path). `keptDirs` lists directories the
 * step created that were no longer empty, so they were kept.
 */
export type UndoResult =
  | {
      readonly status: "restored" | "unchanged";
      readonly keptDirs: readonly string[];
    }
  | { readonly status: "leftover"; readonly reason: string };

function leftover(path: string, reason: string): UndoResult {
  return { status: "leftover", reason: `${path}: ${reason}` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes the directories an `install-staged` created, innermost first.
 * One that is no longer empty is someone else's content too: it and every
 * directory above it are kept and returned. Returns a reason string when a
 * directory cannot be removed for any other cause.
 */
function removeCreatedDirs(
  root: string,
  dirs: readonly string[],
): { readonly kept: readonly string[] } | string {
  const inner = [...dirs].reverse();
  for (const [index, dir] of inner.entries()) {
    const abs = join(root, dir);
    // A non-directory here was already refused by `ancestorsAreReal`; one
    // swapped in since makes rmdir fail with ENOTDIR, reported below.
    if (lstatSync(abs, { throwIfNoEntry: false }) === undefined) continue;
    try {
      rmdirSync(abs);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return { kept: inner.slice(index) };
      }
      return `could not remove the directory ${dir} it created (${messageOf(error)})`;
    }
  }
  return { kept: [] };
}

/**
 * How an undo may treat an `install-staged` step's file: `hash` (remove it
 * only while it holds the step's bytes: a recovery, and an in-process
 * rollback of a write that completed, since the user may have edited the
 * file since), `created` (this process opened it with exclusive create but
 * did not finish writing it: remove it whatever it holds) or `dirs-only`
 * (the file was never created by this run, e.g. its open failed: leave
 * whatever is there, remove only the directories). A replacing step always
 * decides by hashes.
 */
export type InstallOwnership = "hash" | "created" | "dirs-only";

function undoInstall(
  root: string,
  step: JournalStep,
  ownership: InstallOwnership,
): UndoResult {
  const abs = join(root, step.path);
  const stat =
    ownership === "dirs-only"
      ? undefined
      : lstatSync(abs, { throwIfNoEntry: false });
  if (stat !== undefined) {
    if (!stat.isFile()) {
      return leftover(step.path, "it is no longer a regular file");
    }
    if (
      ownership === "hash" &&
      sha256Hex(readRegularNoFollow(abs).bytes) !== step.sha256After
    ) {
      return leftover(
        step.path,
        "it changed since this apply created it (its hash differs from the bytes written), so it was kept",
      );
    }
    unlinkSync(abs);
  }
  const dirs = removeCreatedDirs(root, step.createdDirs);
  if (typeof dirs === "string") return leftover(step.path, dirs);
  return {
    status: stat === undefined ? "unchanged" : "restored",
    keptDirs: dirs.kept,
  };
}

/**
 * Reverts a replaced file. The target is checked first: one that already
 * holds the original needs no backup at all, and one that is gone was
 * deleted by someone since (a replace never removes its target), so it is
 * a leftover and is not recreated from the backup. Only then is the backup
 * read and verified, and a target holding neither the original nor the
 * step's bytes is left alone.
 */
function undoReplace(
  root: string,
  backupDir: string,
  step: JournalStep,
  before: StepBefore,
): UndoResult {
  const abs = join(root, step.path);
  const backupPath = join(backupDir, before.backup);
  const stat = lstatSync(abs, { throwIfNoEntry: false });
  if (stat === undefined) {
    return leftover(
      step.path,
      `it was deleted since this apply replaced it, so it was not recreated (its original is kept in ${backupPath})`,
    );
  }
  if (!stat.isFile()) {
    return leftover(step.path, "it is no longer a regular file");
  }
  const current = sha256Hex(readRegularNoFollow(abs).bytes);
  if (current === before.sha256) return { status: "unchanged", keptDirs: [] };
  let backup: Buffer;
  try {
    backup = readRegularNoFollow(backupPath).bytes;
  } catch (error) {
    return leftover(
      step.path,
      `its backup ${backupPath} is missing or unreadable (${messageOf(error)})`,
    );
  }
  if (sha256Hex(backup) !== before.sha256) {
    return leftover(
      step.path,
      `its backup ${backupPath} no longer matches the hash the journal recorded`,
    );
  }
  if (current !== step.sha256After) {
    return leftover(
      step.path,
      "it changed since this apply wrote it (its hash differs from both the original and the bytes written)",
    );
  }
  replaceFile(abs, backup, before.mode);
  return { status: "restored", keptDirs: [] };
}

/**
 * Reverts one journaled step, deciding by hashes (see the module comment)
 * unless `ownership` says otherwise for an `install-staged`. A `leftover`
 * result names the path and why it was left: a target that is neither the
 * step's bytes nor the original, a replaced target deleted since, a
 * non-file, a symlinked ancestor, a backup that is missing or no longer
 * matches, or any filesystem failure on the way.
 */
export function undoStep(
  root: string,
  backupDir: string,
  step: JournalStep,
  ownership: InstallOwnership,
): UndoResult {
  try {
    if (!ancestorsAreReal(root, step.path)) {
      return leftover(
        step.path,
        "a directory above it is now a symlink, a file or uninspectable",
      );
    }
    return step.before === null
      ? undoInstall(root, step, ownership)
      : undoReplace(root, backupDir, step, step.before);
  } catch (error) {
    // Reported, not swallowed: the caller lists the path in `leftovers`
    // with this reason and keeps txn/ (journal and backups) for the operator.
    return leftover(step.path, `undo failed: ${messageOf(error)}`);
  }
}
