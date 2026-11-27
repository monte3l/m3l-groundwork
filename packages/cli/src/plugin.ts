// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Installs the `/customize` skill into a bootstrapped or adopted project.
 * Claude Code's marketplace-based plugin installation is an interactive,
 * network-involving flow this offline CLI can't drive; instead this copies
 * the skill's SKILL.md, its step files and its deterministic backing data
 * into a destination directory, so `/customize` works immediately with no
 * further setup step.
 */
import {
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveAsset } from "./assets.js";
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_ENTRY_FILE,
  CUSTOMIZE_SKILL_STEP_FILE_NAMES,
  CUSTOMIZE_SKILL_WRITE_ORDER,
  GROUNDWORK_DEST_SEGMENTS,
} from "./customize-paths.js";
import {
  assertNotSymlink,
  endsWithRerunAdvice,
  FIX_AND_RERUN_ADVICE,
  FRESH_RETRY,
  FRESH_SYMLINK_ADVICE,
} from "./fs-guard.js";

/** Resolves the plugin payload for a source checkout (`packages/plugin`) or a published tarball (`plugin/`). */
function pluginDir(): string {
  return resolveAsset({ repo: "packages/plugin", local: "plugin" });
}

/**
 * What an install wrote.
 *
 * @example
 * ```ts
 * import { installCustomizeSkill } from "./plugin.js";
 *
 * const { filesWritten } = installCustomizeSkill("/work/app");
 * filesWritten.at(-1); // ".claude/skills/customize/SKILL.md"
 * ```
 */
export interface InstallPluginResult {
  /** Paths relative to the project root, in write order (`SKILL.md` last); empty when the destination already held this exact payload. */
  filesWritten: string[];
}

/*
 * Fresh mode's retry instruction is `fs-guard.ts`'s FRESH_RETRY, shared with
 * `emit.ts`'s destination guard. Reached through `main.ts`'s fresh mode, an
 * install failure's chain carries two compatible instructions: the outer
 * error's "re-run with --fresh --force (plus your original
 * --name/--pack/--skip-install)" restates this one with the flag list
 * spelled out. Neither line is dropped -- the cause also stands alone for a
 * direct caller -- and they never contradict, since neither gives adopt
 * mode's bare "re-run the CLI".
 */

/** How a public entry point's failures end: the advice to append, and whether a message already ENDS with equivalent advice. */
interface Remediation {
  readonly advice: string;
  readonly isAdvised: (message: string) => boolean;
}

/**
 * The remediation an install failure ends with, chosen by the public entry
 * point that owns the run ({@link withRemediation}) -- appended once, never
 * twice.
 */
const FRESH_REMEDIATION: Remediation = {
  advice: `fix the cause, then ${FRESH_RETRY}`,
  isAdvised: (message) => message.endsWith(FRESH_RETRY),
};
const ADOPT_REMEDIATION: Remediation = {
  advice: FIX_AND_RERUN_ADVICE,
  isAdvised: endsWithRerunAdvice,
};

/** The prefix every install failure's message starts with -- stated once, never twice. */
const INSTALL_ERROR_PREFIX = "could not install the /customize skill: ";

/**
 * An already-built install failure. Private: it exists only so
 * {@link installError} can recognise one it is asked to re-wrap and fold it
 * in rather than nest a second prefix around it.
 */
class CustomizeInstallError extends Error {
  /** The message without {@link INSTALL_ERROR_PREFIX}. */
  readonly body: string;

  constructor(body: string, cause: unknown) {
    super(`${INSTALL_ERROR_PREFIX}${body}`, { cause });
    this.body = body;
  }
}

/**
 * Builds the one error shape every install failure surfaces as, keeping the
 * underlying message and chaining the raw error as `cause`. It adds no
 * remediation: {@link withRemediation} appends the caller's once, at the
 * public boundary. A cause that is itself an install failure is folded in:
 * its body follows `detail` under a single prefix, and its own raw `cause`
 * (not the wrapper) is chained.
 */
function installError(detail: string, cause: unknown): Error {
  if (cause instanceof CustomizeInstallError) {
    return new CustomizeInstallError(`${detail}: ${cause.body}`, cause.cause);
  }
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return new CustomizeInstallError(`${detail}: ${causeMessage}`, cause);
}

/**
 * Runs one public install entry point, appending `remediation.advice` to any
 * install failure it throws -- unless the message already ENDS with this
 * mode's advice (e.g. adopt mode's symlink refusal, "remove it and re-run
 * the CLI"), so the advice appears once. The check is end-anchored and
 * mode-specific: a phrase elsewhere in the message (inside a path) or the
 * other mode's advice never suppresses it. Anything else is rethrown
 * unchanged.
 */
function withRemediation<T>(remediation: Remediation, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (
      error instanceof CustomizeInstallError &&
      !remediation.isAdvised(error.body)
    ) {
      throw new CustomizeInstallError(
        `${error.body} -- ${remediation.advice}`,
        error.cause,
      );
    }
    throw error;
  }
}

/** The plugin payload's location, resolved inside a public entry point's run so a failure is wrapped like any other. */
function resolveSourceDir(sourceDir: string | undefined): string {
  return (
    sourceDir ??
    wrapFs("could not locate the /customize skill's source", pluginDir)
  );
}

/** Wording for a pre-write probe failure: nothing has been touched yet. */
function untouched(action: string, path: string): string {
  return `${action} ${path}; nothing was removed or written`;
}

/** Runs one fallible fs probe/setup step, rethrowing any failure as an {@link installError}. */
function wrapFs<T>(detail: string, step: () => T): T {
  try {
    return step();
  } catch (cause) {
    throw installError(detail, cause);
  }
}

/** A string-valued errno field (`code`, `syscall`) of a thrown value, if it has one. */
function errnoField(
  error: unknown,
  field: "code" | "syscall",
): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(error, field);
  return typeof value === "string" ? value : undefined;
}

/** One payload file: its name inside an installed copy and its exact bytes. */
interface PayloadFile {
  readonly name: string;
  readonly bytes: Buffer;
}

/**
 * The payload files sourced from the plugin's `skills/customize/` (the
 * entry file and its step files); every other one comes from its `src/`.
 */
const SKILL_DIR_FILE_NAMES: ReadonlySet<string> = new Set<string>([
  CUSTOMIZE_SKILL_ENTRY_FILE,
  ...CUSTOMIZE_SKILL_STEP_FILE_NAMES,
]);

/**
 * Reads every payload file from the plugin source, in
 * {@link CUSTOMIZE_SKILL_WRITE_ORDER} (`SKILL.md` last), before anything is
 * written. A missing or unreadable source file is a broken install, not
 * something to degrade past silently: it throws, with the raw read error
 * (its errno intact) as `cause`, and a message saying "is missing" only for
 * `ENOENT`.
 */
function readCustomizeSkillPayload(sourceDir: string): readonly PayloadFile[] {
  return CUSTOMIZE_SKILL_WRITE_ORDER.map((name) => {
    const from = SKILL_DIR_FILE_NAMES.has(name)
      ? join(sourceDir, "skills", "customize", name)
      : join(sourceDir, "src", name);
    try {
      return { name, bytes: readFileSync(from) };
    } catch (cause) {
      const detail =
        errnoField(cause, "code") === "ENOENT"
          ? `the /customize skill's source file is missing: ${from}`
          : `could not read ${from}`;
      throw installError(detail, cause);
    }
  });
}

/**
 * How a destination's existing entries are treated.
 *
 * - `"overwrite"`: fresh mode's `.claude/skills/customize/` (which `--force`
 *   may point at a non-empty directory, or a previous install).
 * - `"cli-owned"`: `.groundwork/customize/`, the CLI's own staging.
 *
 *   Both replace existing entries, each by an atomic rename of a staged
 *   same-directory copy ({@link replacePayloadFiles}): an entry is never
 *   missing or partly written, and a failure puts every replaced entry back
 *   byte-for-byte. `"overwrite"` first classifies the destination and, when
 *   every payload file is already byte-identical, writes nothing.
 * - `"additive"`: adopt mode's `.claude/skills/customize/`, which belongs to
 *   the project -- nothing is ever replaced or removed; each missing file is
 *   created exclusively and atomically ({@link createPayloadFiles}), so an
 *   entry that appears there mid-install makes the write fail `EEXIST`.
 */
type WritePolicy = "overwrite" | "additive" | "cli-owned";

/**
 * Where an install writes (segments relative to the project root), how it
 * treats what is already there, and the advice a symlinked directory
 * component's refusal ends with ({@link assertNotSymlink}'s default when
 * `undefined`).
 */
interface SkillDestination {
  readonly segments: readonly string[];
  readonly policy: WritePolicy;
  readonly symlinkAdvice: string | undefined;
}

const FRESH_DESTINATION: SkillDestination = {
  segments: CLAUDE_DEST_SEGMENTS,
  policy: "overwrite",
  symlinkAdvice: FRESH_SYMLINK_ADVICE,
};
const ADOPT_CLAUDE_DESTINATION: SkillDestination = {
  segments: CLAUDE_DEST_SEGMENTS,
  policy: "additive",
  symlinkAdvice: undefined,
};
const CLI_OWNED_DESTINATION: SkillDestination = {
  segments: GROUNDWORK_DEST_SEGMENTS,
  policy: "cli-owned",
  symlinkAdvice: undefined,
};

/** Whether a policy replaces an existing entry at a payload name (by rename) rather than only creating missing ones. */
function replacesExistingEntries(policy: WritePolicy): boolean {
  switch (policy) {
    case "overwrite":
    case "cli-owned":
      return true;
    case "additive":
      return false;
    default: {
      const exhaustive: never = policy;
      throw new Error(`unhandled write policy: ${String(exhaustive)}`);
    }
  }
}

/**
 * Pre-flight for every policy: `lstat`s each payload name in `destDir` that
 * this run will write (names in `alreadyCurrent` are skipped) and throws,
 * naming it, if any is a directory -- before anything is written, so a
 * destination no rename or link could ever replace is refused with every
 * existing entry untouched. A replacing policy also refuses an entry that is
 * neither a file nor a symlink (which it could not put back). A name whose own `lstat`
 * fails cannot be judged here: under a policy that replaces existing
 * entries that refuses the install too ("could not inspect <path>; nothing
 * was removed or written", the raw error as `cause`), since the run would
 * otherwise remove an entry it never judged; under `"additive"` (which never
 * replaces anything) it is left to its own exclusive create, which surfaces
 * the real error (rolled back as usual). A directory that appears after this
 * check (a race) is likewise left to the write.
 */
function assertNoDirectoryAtPayloadNames(
  destDir: string,
  payload: readonly PayloadFile[],
  alreadyCurrent: ReadonlySet<string>,
  policy: WritePolicy,
): void {
  for (const { name } of payload) {
    if (alreadyCurrent.has(name)) {
      continue;
    }
    const dest = join(destDir, name);
    let isDirectory: boolean;
    let isUnreplaceable: boolean;
    try {
      const stat = lstatSync(dest, { throwIfNoEntry: false });
      isDirectory = stat?.isDirectory() === true;
      // A replacing policy puts the previous entry back on failure, which it
      // can do for a file or a symlink and for nothing else (a FIFO, a socket).
      isUnreplaceable =
        replacesExistingEntries(policy) &&
        stat !== undefined &&
        !stat.isFile() &&
        !stat.isSymbolicLink() &&
        !isDirectory;
    } catch (cause) {
      if (replacesExistingEntries(policy)) {
        throw installError(untouched("could not inspect", dest), cause);
      }
      // Additive: unjudgeable, not refused -- the "wx" write reports the
      // real error, and nothing is ever removed on this path.
      continue;
    }
    if (isUnreplaceable) {
      throw installError(
        `could not write ${dest}`,
        new Error(
          `${dest} is neither a file nor a symlink, which this install could not put back if it failed; nothing was removed or written`,
        ),
      );
    }
    if (isDirectory) {
      throw installError(
        `could not write ${dest}`,
        new Error(
          `${dest} is a directory, not a file this install can replace; nothing was removed or written`,
        ),
      );
    }
  }
}

/** A path rollback could not remove, with the errno code of that failure. */
interface LeftBehind {
  readonly path: string;
  readonly code: string;
}

/** Removes every path in `paths` (best effort; an absent one counts as removed), returning how many were removed and which were not, each with its errno code. */
function rollBack(paths: readonly string[]): {
  removed: number;
  leftBehind: LeftBehind[];
} {
  const leftBehind: LeftBehind[] = [];
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      // Best effort: the write failure is the error that matters; a path
      // this rollback could not remove is named in that error instead.
      leftBehind.push({ path, code: errnoField(error, "code") ?? "unknown" });
    }
  }
  return { removed: paths.length - leftBehind.length, leftBehind };
}

/** `<path> (<code>), ...` */
function listLeftBehind(leftBehind: readonly LeftBehind[]): string {
  return leftBehind.map((l) => `${l.path} (${l.code})`).join(", ");
}

/** The ` (could not remove: <path> (<code>), ...)` clause, or `""` when everything was removed. */
function notRemovedClause(leftBehind: readonly LeftBehind[]): string {
  return leftBehind.length > 0
    ? ` (could not remove: ${listLeftBehind(leftBehind)})`
    : "";
}

/** After a SUCCESSFUL install a temporary file that could not be removed is only a warning: the install's own result stands. */
function warnLeftover(leftBehind: readonly LeftBehind[]): void {
  if (leftBehind.length > 0) {
    console.warn(
      `warning: could not remove ${listLeftBehind(leftBehind)} -- delete by hand`,
    );
  }
}

/*
 * How a skill file is replaced without a window in which a reader finds it
 * missing or truncated (the design is in the pull request that introduced
 * it, and the guarantees in `docs/assurance-case.md`):
 *
 * - Content is never written to its destination. It is written to a
 *   temporary file in the SAME directory (so the rename below never crosses
 *   a filesystem), flushed with `fsync`, and only then renamed over the
 *   destination. `rename(2)` replaces an existing destination atomically:
 *   "there is no point at which another process attempting to access newpath
 *   will find it missing" (https://man7.org/linux/man-pages/man2/rename.2.html).
 *   A reader of a destination therefore sees the complete old file or the
 *   complete new one.
 * - Before the first rename every temporary file exists, new ones and, for
 *   each entry about to be replaced, a copy of what it holds now. A failure
 *   while staging (a full disk, a permission error) removes the temporary
 *   files and has replaced nothing. After that point the install is only
 *   renames, so rolling back is renames too and needs no free space.
 * - A failure on a rename puts the previous entries back by renaming their
 *   copies over the destinations (byte-for-byte, mode included) and removes
 *   the files this run created.
 * - Replacing policies hold an exclusive lock file for the whole run, so two
 *   runs never roll each other back, and so a temporary file found while
 *   holding it is a dead run's leftover.
 *
 * Node has no atomic exchange of two directories (no `renameat2`
 * `RENAME_EXCHANGE`), so the ten files cannot change in one step: see the
 * residual risk this leaves in `docs/assurance-case.md`.
 */

/** The lock a replacing install holds inside its destination directory. */
const INSTALL_LOCK_NAME = ".install.lock";

/** Marks the temporary files an install creates, so a later run can recognise a dead one's leftovers. */
const TEMP_NAME = /^\..+\.(?:new|old)-\d+-[0-9a-f]{8}\.tmp$/u;

/** A unique same-directory temporary name for `name`; `role` says whether it carries the new content or a copy of the old. */
function tempPath(destDir: string, name: string, role: "new" | "old"): string {
  return join(
    destDir,
    `.${name}.${role}-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
}

/**
 * Creates `path` exclusively (`"wx"`: never through a symlink) holding
 * `bytes`, and flushes it to disk before returning, so a crash after the
 * rename that follows can never leave a zero-length file in place of the
 * content. `mode` (a copied file's) is applied after the write.
 */
function writeDurably(path: string, bytes: Buffer, mode?: number): void {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, bytes);
    if (mode !== undefined) {
      fchmodSync(fd, mode);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Takes the install lock: an exclusive `"wx"` create of
 * {@link INSTALL_LOCK_NAME} holding this process's pid. It is never taken
 * over: a lock left by a killed run is named in the error for the user to
 * delete, because deciding automatically that its owner is gone is a race
 * between two runs doing so.
 */
function acquireInstallLock(destDir: string): string {
  const lock = join(destDir, INSTALL_LOCK_NAME);
  try {
    const fd = openSync(lock, "wx");
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    if (errnoField(cause, "code") === "EEXIST") {
      throw installError(
        `${lock} exists: another install is running, or an earlier one was killed -- if none is running, delete ${lock}; nothing was removed or written`,
        cause,
      );
    }
    throw installError(
      `could not take the install lock ${lock}; nothing was removed or written`,
      cause,
    );
  }
  return lock;
}

/** Releases the lock; a failure only warns, since the install's own result stands. */
function releaseInstallLock(lock: string): void {
  try {
    rmSync(lock, { force: true });
  } catch (error) {
    console.warn(
      `warning: could not remove the install lock ${lock} -- delete it by hand (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Removes a dead run's temporary files from `destDir`; the caller holds the lock, so none can be a live run's. */
function sweepDeadTempFiles(destDir: string): void {
  const names = wrapFs(`could not list ${destDir}`, () => readdirSync(destDir));
  for (const name of names.filter((n) => TEMP_NAME.test(n))) {
    const leftover = join(destDir, name);
    wrapFs(
      `could not remove an earlier run's temporary file ${leftover}; nothing was replaced`,
      () => {
        rmSync(leftover, { force: true });
      },
    );
  }
}

/** What one payload file is replacing, and the staged copies that make the swap and its undo plain renames. */
interface StagedFile {
  readonly dest: string;
  /** The complete new content, next to `dest`. */
  readonly fresh: string;
  /** A copy of what `dest` holds now (a file's bytes and mode, or a symlink), if anything; `undefined` when `dest` is absent. */
  readonly previous: string | undefined;
}

/**
 * Stages one file: the new content, and a saved copy of the entry it will
 * replace (a hard link to it, else a byte copy). A regular file that can be
 * neither linked nor read cannot be saved, so it refuses the install here,
 * before anything has changed, rather than promising a rollback it could not
 * keep.
 */
function stageFile(
  destDir: string,
  name: string,
  bytes: Buffer,
  temps: string[],
): StagedFile {
  const dest = join(destDir, name);
  const fresh = tempPath(destDir, name, "new");
  temps.push(fresh);
  writeDurably(fresh, bytes);
  const stat = lstatSync(dest, { throwIfNoEntry: false });
  if (stat === undefined) {
    return { dest, fresh, previous: undefined };
  }
  const previous = tempPath(destDir, name, "old");
  temps.push(previous);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(dest), previous);
    return { dest, fresh, previous };
  }
  // A hard link keeps the old inode itself: the undo is then a rename of
  // the very same bytes and mode, copies nothing, needs no free space and
  // works for a file this process may not read. A filesystem without hard
  // links (or one that refuses to link a file we do not own) falls back to
  // a copy, which needs the file to be readable.
  try {
    linkSync(dest, previous);
    return { dest, fresh, previous };
  } catch {
    // Fall through to the copy.
  }
  let old: Buffer;
  try {
    old = readFileSync(dest);
  } catch (cause) {
    throw installError(untouched("could not read", dest), cause);
  }
  writeDurably(previous, old, stat.mode & 0o7777);
  return { dest, fresh, previous };
}

/**
 * Replaces the payload files of a directory this CLI owns (`"overwrite"`,
 * `"cli-owned"`): stage everything, rename the new files into place in
 * write order (`SKILL.md` last), and on a rename failure put every earlier
 * one back. Returns the names written.
 */
function replacePayloadFiles(
  destDir: string,
  payload: readonly PayloadFile[],
): string[] {
  const lock = acquireInstallLock(destDir);
  try {
    sweepDeadTempFiles(destDir);
    const temps: string[] = [];
    const staged: StagedFile[] = [];
    try {
      for (const { name, bytes } of payload) {
        staged.push(stageFile(destDir, name, bytes, temps));
      }
    } catch (cause) {
      const { leftBehind } = rollBack(temps);
      throw installError(
        `could not stage the new copy in ${destDir}; nothing was replaced${notRemovedClause(leftBehind)}`,
        cause,
      );
    }

    const swapped: StagedFile[] = [];
    for (const file of staged) {
      try {
        renameSync(file.fresh, file.dest);
      } catch (cause) {
        throw swapFailure(file, swapped, temps, cause);
      }
      swapped.push(file);
    }
    warnLeftover(
      rollBack(
        staged.flatMap((f) => (f.previous === undefined ? [] : [f.previous])),
      ).leftBehind,
    );
    return payload.map(({ name }) => name);
  } finally {
    releaseInstallLock(lock);
  }
}

/**
 * Undoes a failed swap: renames each earlier file's saved copy back over it
 * (or removes a file this run created), newest first, then removes every
 * temporary file. Returns the error to throw, saying what was put back and
 * naming anything that could not be, which is left as the new, complete
 * file.
 */
function swapFailure(
  failed: StagedFile,
  swapped: readonly StagedFile[],
  temps: readonly string[],
  cause: unknown,
): Error {
  const notUndone: LeftBehind[] = [];
  let restored = 0;
  let removedNew = 0;
  for (const file of [...swapped].reverse()) {
    try {
      if (file.previous === undefined) {
        rmSync(file.dest, { force: true });
        removedNew++;
      } else {
        renameSync(file.previous, file.dest);
        restored++;
      }
    } catch (error) {
      notUndone.push({
        path: file.dest,
        code: errnoField(error, "code") ?? "unknown",
      });
    }
  }
  const { leftBehind } = rollBack(temps);
  const undone =
    swapped.length === 0
      ? "nothing was replaced"
      : `put back the previous version of ${restored} file(s) and removed ${removedNew} file(s) this run created`;
  const stuck =
    notUndone.length > 0
      ? `; could not undo: ${listLeftBehind(notUndone)} -- each still holds the new, complete copy, and a re-run finishes the install`
      : "";
  return installError(
    `could not replace ${failed.dest}; ${undone}${stuck}${notRemovedClause(leftBehind)}`,
    cause,
  );
}

/** Errno codes that mean the filesystem cannot make the hard link an exclusive, atomic create needs. */
const NO_HARD_LINK_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
]);

/**
 * Adopt mode's `.claude/skills/customize/`: creates each missing file
 * exclusively and atomically. The content goes to a same-directory temporary
 * file (flushed), which is hard-linked to the destination: `link(2)` fails
 * `EEXIST` rather than replacing an entry that appeared meanwhile, and the
 * destination appears holding all of its content or not at all. Returns the
 * names written; on failure removes the files this call created (and only
 * those).
 */
function createPayloadFiles(
  destDir: string,
  payload: readonly PayloadFile[],
  alreadyCurrent: ReadonlySet<string>,
): string[] {
  const created: string[] = [];
  const names: string[] = [];
  for (const { name, bytes } of payload) {
    if (alreadyCurrent.has(name)) {
      continue;
    }
    const dest = join(destDir, name);
    const temp = tempPath(destDir, name, "new");
    try {
      writeDurably(temp, bytes);
      linkSync(temp, dest);
    } catch (cause) {
      const { leftBehind: tempLeft } = rollBack([temp]);
      const { removed, leftBehind } = rollBack(created);
      const code = errnoField(cause, "code");
      const occupied =
        code === "EEXIST"
          ? `; an entry this run did not create sits there (a project entry appeared during the install, or the name was already taken) and was left untouched`
          : "";
      const noLink =
        code !== undefined && NO_HARD_LINK_CODES.has(code)
          ? `; the filesystem may not support hard links, which this install needs to create a file without a window in which it is truncated`
          : "";
      throw installError(
        `could not write ${dest}${occupied}${noLink}; removed the ${removed} file(s) written by this run${notRemovedClause([...tempLeft, ...leftBehind])}`,
        cause,
      );
    }
    created.push(dest);
    names.push(name);
    warnLeftover(rollBack([temp]).leftBehind);
  }
  return names;
}

/**
 * Writes `payload` into `<targetDir>/<destination.segments>`, skipping any
 * name in `alreadyCurrent` (files an interrupted install already wrote
 * byte-identically), and returns the written paths relative to `targetDir`.
 *
 * Before any `mkdir`/write, every directory component from `targetDir`
 * down to the destination is `lstat`-checked ({@link assertNotSymlink}), so
 * a symlinked `.claude`/`.groundwork` (or any level below it) is refused
 * rather than followed out of the project. A directory component swapped
 * for a symlink between the check and the write (a TOCTOU race) is not
 * covered.
 *
 * Under `"overwrite"`, the destination is classified first
 * ({@link classifyExistingSkill}); when every payload file there is already
 * a byte-identical regular file, nothing is written and `filesWritten` is
 * empty. A failing `lstat` probe there throws before anything is touched; a
 * regular file that cannot be read counts as not current.
 *
 * Before anything is written, a directory (or any entry that is neither a
 * file nor a symlink) at a payload name this run writes is refused
 * ({@link assertNoDirectoryAtPayloadNames}), as is -- under a replacing
 * policy -- a payload name whose `lstat` fails.
 *
 * The two replacing policies then {@link replacePayloadFiles} and `"additive"`
 * {@link createPayloadFiles}; both are described there and in the design
 * note above them. In short: no destination is ever missing or partly
 * written, a failure puts every previous entry back byte-for-byte (replacing
 * policies) or removes only what this call created (additive), and the error
 * says which. Every failure is thrown as one "could not install the
 * /customize skill" `Error` carrying the underlying message and the raw
 * error as `cause`; the public entry point appends its own remediation
 * ({@link withRemediation}).
 */
function copyCustomizeSkillFiles(
  targetDir: string,
  destination: SkillDestination,
  payload: readonly PayloadFile[],
  alreadyCurrent: ReadonlySet<string> = new Set(),
): InstallPluginResult {
  const { segments, policy, symlinkAdvice } = destination;
  const destDir = wrapFs(
    `could not prepare ${join(targetDir, ...segments)}`,
    () => {
      let dir = targetDir;
      for (const segment of segments) {
        dir = join(dir, segment);
        assertNotSymlink(dir, symlinkAdvice);
      }
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  );

  // Fresh mode's re-run over its own, still-current output touches nothing.
  if (
    policy === "overwrite" &&
    classifyExistingSkill(destDir, payload).kind === "current"
  ) {
    return { filesWritten: [] };
  }

  assertNoDirectoryAtPayloadNames(destDir, payload, alreadyCurrent, policy);
  const names = replacesExistingEntries(policy)
    ? replacePayloadFiles(destDir, payload)
    : createPayloadFiles(destDir, payload, alreadyCurrent);
  return { filesWritten: names.map((name) => join(...segments, name)) };
}

/**
 * Installs the skill into `<targetDir>/.claude/skills/customize/`. Used by
 * fresh-bootstrap mode, where the directory is normally new (`--force` may
 * point it at a non-empty one or an earlier install). An earlier install
 * that is already byte-identical to this payload is left untouched
 * (`filesWritten` is empty); otherwise each payload file is replaced by an
 * atomic rename of a staged copy, `SKILL.md` last, so the destination is
 * never missing or partly written. A symlinked
 * `.claude`, `.claude/skills` or `.claude/skills/customize` is refused, not
 * routed around.
 *
 * @throws `Error` ("could not install the /customize skill ...", raw error
 * as `cause`) on a missing or unreadable source file, a directory (or other
 * non-file, non-symlink) at any payload name, a payload name or existing file
 * that cannot be `lstat`ed, an existing regular file that cannot be read (it
 * could not be put back on a failure; all before anything is replaced), a
 * symlinked or non-directory directory component, a held install lock, any
 * fs failure, or a failed write or rename. A failure while staging has
 * replaced nothing; one on a rename puts every replaced entry back
 * byte-for-byte, and the error says so (and names any that could not be
 * put back, which still hold a complete new copy). A failure to locate the
 * default `sourceDir` is thrown the same way. The message ends, once, by
 * saying to fix the cause (for a symlink: remove it), then retry
 * the same command with `--fresh --force` added -- a plain re-run would
 * adopt the now-non-empty target -- and nowhere in the error chain gives
 * adopt mode's bare "re-run the CLI" advice.
 *
 * @example
 * ```ts
 * import { installCustomizeSkill } from "./plugin.js";
 *
 * installCustomizeSkill("/work/app").filesWritten.length; // 5
 * ```
 */
export function installCustomizeSkill(
  targetDir: string,
  sourceDir?: string,
): InstallPluginResult {
  return withRemediation(FRESH_REMEDIATION, () =>
    copyCustomizeSkillFiles(
      targetDir,
      FRESH_DESTINATION,
      readCustomizeSkillPayload(resolveSourceDir(sourceDir)),
    ),
  );
}

type InstallLocation = "claude" | "groundwork" | "already-present";

/**
 * What the adopt-mode install did, and where.
 *
 * @example
 * ```ts
 * import { installCustomizeSkillGuarded } from "./plugin.js";
 *
 * const result = installCustomizeSkillGuarded("/work/app");
 * if (result.fallbackReason !== undefined) console.log(result.fallbackReason);
 * ```
 */
export interface GuardedInstallResult {
  /** Paths relative to the project root, in write order (`SKILL.md` last); empty for `"already-present"`. */
  filesWritten: string[];
  location: InstallLocation;
  /**
   * Set on every `"groundwork"` result, and only then: why
   * `.claude/skills/customize/` could not be used, naming the path
   * responsible -- a symlinked or non-directory component, or the existing
   * project entry under one of the skill's payload names.
   */
  fallbackReason?: string;
  /**
   * Set exactly when `fallbackReason` is: `"component"` when a
   * `.claude`/`.claude/skills`/`.claude/skills/customize` component is a
   * symlink or not a directory (no project-local copy of the skill exists),
   * `"entry"` when a project-owned entry sits under one of the skill's
   * payload names (a project copy exists, and is what a user would replace).
   */
  fallbackCause?: "entry" | "component";
}

/** Why `<targetDir>/<segments>` cannot be written into: its first component that is a symlink or not a directory, if any. */
function firstUnusableComponent(
  targetDir: string,
  segments: readonly string[],
): string | undefined {
  let dir = targetDir;
  for (const segment of segments) {
    dir = join(dir, segment);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat === undefined) {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      return `${dir} is a symlink`;
    }
    if (!stat.isDirectory()) {
      return `${dir} is not a directory`;
    }
  }
  return undefined;
}

/** The read-failure codes that mean "this entry is not ours to read" -- a permission refusal, not a fault. */
const UNREADABLE_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

/** The outcome of comparing one existing regular file against the payload; `"unreadable"` carries the permission refusal's errno code. */
type FileComparison =
  | { readonly kind: "match" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "unreadable"; readonly code: string };

/**
 * Whether the regular file at `path` holds exactly `bytes`: `"match"`,
 * `"mismatch"`, or `"unreadable"` (with the errno code) when the read is
 * refused with `EACCES` or `EPERM`. Every caller treats such an entry as not
 * this CLI's current copy, and decides from there what to do with it.
 *
 * @throws `Error` ({@link installError}: "could not read <path>; nothing was
 * removed or written", raw error as `cause`) on any other read failure
 * (`EIO`, `EMFILE`, an `ENOENT`/`ELOOP` race after `lstat`, or a code-less
 * error): a fault is not evidence about the entry, so it is never guessed
 * to be foreign or stale.
 */
function regularFileMatches(path: string, bytes: Buffer): FileComparison {
  let existing: Buffer;
  try {
    existing = readFileSync(path);
  } catch (error) {
    const code = errnoField(error, "code");
    // Only a permission refusal is a verdict about the entry: fresh mode
    // replaces it like any stale copy, adopt mode leaves it alone and falls
    // back, the code kept so the fallback reason can say why.
    if (code !== undefined && UNREADABLE_CODES.has(code)) {
      return { kind: "unreadable", code };
    }
    throw installError(untouched("could not read", path), error);
  }
  return existing.equals(bytes) ? { kind: "match" } : { kind: "mismatch" };
}

/** What is already at `.claude/skills/customize/`, judged against the payload. */
type ExistingSkill =
  | { readonly kind: "current" }
  | {
      readonly kind: "installable";
      readonly alreadyCurrent: ReadonlySet<string>;
    }
  | {
      readonly kind: "foreign";
      readonly reason: string;
      /** The offending entry is not a regular file, or could not be read: it cannot even be compared. */
      readonly uncomparable: boolean;
    };

/**
 * Classifies the existing `.claude/skills/customize/` by `lstat` (a symlink,
 * FIFO or directory where a payload file is expected is never read):
 *
 * - `"current"`: every payload file is a regular file matching the payload
 *   byte-for-byte.
 * - `"installable"`: no entry at all at `SKILL.md` and every other entry
 *   present is a regular file matching the payload byte-for-byte -- nothing
 *   there at all, or an install interrupted before its `SKILL.md`.
 *   `alreadyCurrent` names the files not to rewrite.
 * - `"foreign"`: anything else -- including any non-regular entry (a
 *   directory, symlink or FIFO) under any payload name, `SKILL.md` included;
 *   `reason` names the first offending entry.
 *
 * Runs before anything is removed or written, and stops at the first foreign
 * entry: a failing `lstat` on any entry reached before that point throws
 * (wrapped, raw error as `cause`) naming the path and saying so -- an entry
 * whose very nature is unknown is never classified -- while an entry after
 * the first foreign one is never `lstat`ed at all. A regular file `lstat`
 * already confirmed but whose read is refused with `EACCES`/`EPERM` is
 * `"foreign"`, its `reason` saying it could not be read and naming the errno
 * code: this never guesses that an entry it cannot compare is current.
 * Fresh mode's overwrite then replaces it like any stale copy; adopt mode
 * leaves it untouched and falls back. Any other read failure throws the
 * same way a failing `lstat` does ({@link regularFileMatches}).
 */
function classifyExistingSkill(
  existingDir: string,
  payload: readonly PayloadFile[],
): ExistingSkill {
  const alreadyCurrent = new Set<string>();
  let entryLoadable = false;
  for (const { name, bytes } of payload) {
    const installedPath = join(existingDir, name);
    const stat = wrapFs(untouched("could not inspect", installedPath), () =>
      lstatSync(installedPath, { throwIfNoEntry: false }),
    );
    if (stat === undefined) {
      continue;
    }
    const isFile = stat.isFile();
    const verdict: FileComparison = isFile
      ? regularFileMatches(installedPath, bytes)
      : { kind: "mismatch" };
    if (verdict.kind === "unreadable") {
      // No ", so" clause here: installGuarded appends its own.
      return {
        kind: "foreign",
        reason: `${installedPath} already exists and could not be read (${verdict.code}); it cannot be confirmed as this CLI's current copy`,
        uncomparable: true,
      };
    }
    if (verdict.kind === "mismatch") {
      return {
        kind: "foreign",
        reason: `${installedPath} already exists and is not this CLI's current copy`,
        uncomparable: !isFile,
      };
    }
    alreadyCurrent.add(name);
    entryLoadable ||= name === CUSTOMIZE_SKILL_ENTRY_FILE;
  }
  if (alreadyCurrent.size === payload.length) {
    return { kind: "current" };
  }
  if (entryLoadable) {
    return {
      kind: "foreign",
      reason: `${join(existingDir, CUSTOMIZE_SKILL_ENTRY_FILE)} already exists without the rest of this CLI's current payload`,
      uncomparable: false,
    };
  }
  return { kind: "installable", alreadyCurrent };
}

/** Errno codes that mean a project entry itself cannot be inspected by this process. */
const UNINSPECTABLE_ENTRY_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
  "ELOOP",
  "ENOTDIR",
  "ENAMETOOLONG",
]);

/**
 * True when `error`, or the raw error an `installError` wrapper carries as
 * `cause`, has one of {@link UNINSPECTABLE_ENTRY_CODES}.
 */
function isUninspectableEntryError(error: unknown): boolean {
  let current: unknown = error;
  // Bounded: installError wraps at most once over the raw fs error.
  for (let depth = 0; depth < 3 && current !== undefined; depth++) {
    const code = errnoField(current, "code");
    if (code !== undefined) {
      return UNINSPECTABLE_ENTRY_CODES.has(code);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * A read-only verdict on the project's `.claude/skills/customize/` against
 * this CLI's own `/customize` payload, for `--add-pack`'s closing `next:`
 * line: `"current"` when every payload file there is a regular file
 * byte-identical to the payload; `"absent"` when there is no payload file
 * there at all (no `.claude`, no `skills/customize/`, or an empty one);
 * `"stale"` when there are regular files that differ, or only some of the
 * payload; `"unusable"` when `.claude`, `.claude/skills` or
 * `.claude/skills/customize` is a symlink or not a directory, a payload name
 * holds a symlink, directory or other non-regular entry, or an entry cannot
 * be inspected or read because of the project entry itself (`EACCES`,
 * `EPERM`, `ELOOP`, `ENOTDIR`, `ENAMETOOLONG`). Decided by `lstat`, never
 * following a symlink; it never writes, removes or repairs anything.
 *
 * @throws The "could not install the /customize skill" `Error` (raw error as
 * `cause`) when this CLI's own payload cannot be located or read -- a broken
 * install, never a fact about the project. Any other failure while
 * inspecting the project's copy (a machine fault such as `EIO`/`EMFILE`, or
 * a bug) is rethrown as a "could not inspect the /customize skill copy at
 * <path>" `Error` with the original as `cause`.
 *
 * @example
 * ```ts
 * import { inspectCustomizeSkill } from "./plugin.js";
 * if (inspectCustomizeSkill("/work/app") !== "current") console.log("update the plugin first");
 * ```
 */
export function inspectCustomizeSkill(
  targetDir: string,
): "current" | "absent" | "stale" | "unusable" {
  // Outside the try: a failure to read this CLI's own payload is a broken
  // install and must throw, never become a verdict about the project.
  const payload = readCustomizeSkillPayload(resolveSourceDir(undefined));
  const existingDir = join(targetDir, ...CLAUDE_DEST_SEGMENTS);
  let existing: ExistingSkill;
  try {
    if (firstUnusableComponent(targetDir, CLAUDE_DEST_SEGMENTS) !== undefined) {
      return "unusable";
    }
    existing = classifyExistingSkill(existingDir, payload);
  } catch (error) {
    // A project entry this process cannot inspect (permissions, a symlink
    // loop, a component that is not a directory, an over-long name) cannot
    // be confirmed current, and the verdict only chooses a hint line, so
    // "unusable" -- the update-the-plugin advice -- is the truthful answer.
    // Anything else (a machine fault or a bug) is not a fact about the
    // project and is rethrown, worded for this read-only path.
    if (isUninspectableEntryError(error)) {
      return "unusable";
    }
    throw new Error(
      `could not inspect the /customize skill copy at ${existingDir}`,
      { cause: error },
    );
  }
  switch (existing.kind) {
    case "current":
      return "current";
    case "installable":
      return existing.alreadyCurrent.size === 0 ? "absent" : "stale";
    case "foreign":
      return existing.uncomparable ? "unusable" : "stale";
    default: {
      const exhaustive: never = existing;
      throw new Error(`unhandled skill state: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The body of {@link installCustomizeSkillGuarded}, before its adopt-mode remediation is appended. */
function installGuarded(
  targetDir: string,
  sourceDir: string,
): GuardedInstallResult {
  const payload = readCustomizeSkillPayload(sourceDir);
  const existingDir = join(targetDir, ...CLAUDE_DEST_SEGMENTS);
  const installToGroundwork = (
    reason: string,
    fallbackCause: "entry" | "component",
  ): GuardedInstallResult => {
    let filesWritten: string[];
    try {
      ({ filesWritten } = copyCustomizeSkillFiles(
        targetDir,
        CLI_OWNED_DESTINATION,
        payload,
      ));
    } catch (cause) {
      // Already an installError; this adds only why the fallback
      // destination was being written at all.
      throw installError(
        `${reason}, so it fell back to .groundwork/customize/, and that install failed too`,
        cause,
      );
    }
    return {
      filesWritten,
      location: "groundwork",
      fallbackReason: `${reason}, so the /customize skill was installed into .groundwork/customize/ instead`,
      fallbackCause,
    };
  };

  const unusable = wrapFs(`could not inspect ${existingDir}`, () =>
    firstUnusableComponent(targetDir, CLAUDE_DEST_SEGMENTS),
  );
  if (unusable !== undefined) {
    return installToGroundwork(unusable, "component");
  }

  // Throws its own wrapped error naming a path it could not lstat or read;
  // a regular file whose read is refused (EACCES/EPERM) comes back
  // "foreign" instead.
  const existing = classifyExistingSkill(existingDir, payload);
  switch (existing.kind) {
    case "current":
      return { filesWritten: [], location: "already-present" };
    case "foreign":
      return installToGroundwork(existing.reason, "entry");
    case "installable": {
      const { filesWritten } = copyCustomizeSkillFiles(
        targetDir,
        ADOPT_CLAUDE_DESTINATION,
        payload,
        existing.alreadyCurrent,
      );
      return { filesWritten, location: "claude" };
    }
    default: {
      const exhaustive: never = existing;
      throw new Error(`unhandled skill state: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Adopt-mode install: purely additive, never overwrites or removes a project
 * entry under `.claude/skills/customize/`.
 *
 * - If `.claude`, `.claude/skills` or `.claude/skills/customize` is a
 *   symlink or not a directory, the skill is written to
 *   `.groundwork/customize/` instead, `fallbackReason` names that path and
 *   `fallbackCause` is `"component"` -- the entry (and any link target) is
 *   left untouched.
 * - Otherwise, if every payload file already there is a regular file
 *   matching what this CLI ships byte-for-byte: with every payload file
 *   present the result is `"already-present"` (nothing written); with no
 *   `SKILL.md` file (none at all, or an install interrupted before writing
 *   it) the missing files are written into `.claude/skills/customize/`,
 *   `SKILL.md` last, never rewriting or removing the correct ones.
 * - Anything else under a payload name (a differing file, a regular file
 *   that cannot be read, a symlink -- dangling or not -- a directory, a
 *   `SKILL.md` without its data or step files; detected by `lstat`) is kept
 *   as the project's own: the skill is written to `.groundwork/customize/`
 *   instead, `fallbackReason` names that entry (saying so when it could not
 *   be read) and `fallbackCause` is `"entry"`. Adopt mode never guesses at a
 *   project entry it cannot compare, and the fallback does not guess either:
 *   it leaves that entry exactly as it was. Claude Code does not load a
 *   skill from there; the caller must say so.
 *
 * Writes into `.claude/skills/customize/` create files exclusively, so an
 * entry that appears there mid-install fails the run (rolled back) rather
 * than being replaced. Writes into the CLI-owned `.groundwork/customize/`
 * replace that directory's payload files, each by an atomic rename (so a
 * failure puts the previous files back); a symlinked `.groundwork` or
 * `.groundwork/customize`, or a directory at any payload name there, is
 * refused, never routed around.
 *
 * @throws `Error` ("could not install the /customize skill ...", raw error
 * as `cause`) on a missing or unreadable source file (before anything is
 * written), a payload name under `.claude/skills/customize/` that cannot be
 * `lstat`ed or read (a regular file there whose read is refused with
 * `EACCES`/`EPERM` falls back instead; any other read failure throws before
 * anything is written), any other fs failure while probing or writing, a
 * symlinked `.groundwork`/`.groundwork/customize`, or a directory at a
 * payload name there -- after undoing everything this call did. A failed
 * `.groundwork/customize/` install also names why the fallback was taken.
 * A failure to locate the default `sourceDir` is thrown the same way. The
 * message ends by
 * saying to fix the cause (for a symlink: remove it) and re-run the CLI,
 * once.
 *
 * @example
 * ```ts
 * import { installCustomizeSkillGuarded } from "./plugin.js";
 *
 * const { location } = installCustomizeSkillGuarded("/work/app");
 * // "claude" | "groundwork" | "already-present"
 * ```
 */
export function installCustomizeSkillGuarded(
  targetDir: string,
  sourceDir?: string,
): GuardedInstallResult {
  return withRemediation(ADOPT_REMEDIATION, () =>
    installGuarded(targetDir, resolveSourceDir(sourceDir)),
  );
}
