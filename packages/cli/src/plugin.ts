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
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 *   Both replace existing entries: an existing `SKILL.md` is removed first
 *   ({@link removeStaleSkillEntry}), then each payload file is removed and
 *   recreated with `"wx"`. A pre-existing entry removed this way is gone
 *   even if the run later fails -- rollback removes what this run wrote, it
 *   never restores what was replaced; the error names every such entry.
 *   `"overwrite"` first classifies the destination and, when every payload
 *   file is already byte-identical, removes and writes nothing.
 * - `"additive"`: adopt mode's `.claude/skills/customize/`, which belongs to
 *   the project -- nothing is ever removed; `"wx"` alone, so an entry that
 *   appears there mid-install makes the write fail `EEXIST`.
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

/** Whether a policy removes an existing entry at a payload name before its `"wx"` write. */
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
 * naming it, if any is a directory -- before anything is removed or written,
 * so a destination a non-recursive remove-then-`"wx"` could never complete
 * is refused with every existing entry untouched. A name whose own `lstat`
 * fails cannot be judged here: under a policy that replaces existing
 * entries that refuses the install too ("could not inspect <path>; nothing
 * was removed or written", the raw error as `cause`), since the run would
 * otherwise remove an entry it never judged; under `"additive"` (which never
 * removes anything) it is left to its own `"wx"` write, which surfaces the
 * real error (rolled back as usual). A directory that appears after this
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
    try {
      isDirectory =
        lstatSync(dest, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch (cause) {
      if (replacesExistingEntries(policy)) {
        throw installError(untouched("could not inspect", dest), cause);
      }
      // Additive: unjudgeable, not refused -- the "wx" write reports the
      // real error, and nothing is ever removed on this path.
      continue;
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

/**
 * For every policy that replaces existing entries: removes an existing
 * `SKILL.md` entry (a file or a symlink, unlinked, never followed) BEFORE any
 * data or step file is rewritten, so a later failure never leaves a stale
 * `SKILL.md` loadable beside missing or half-rewritten data or step files.
 * Runs after {@link assertNoDirectoryAtPayloadNames}, so a directory there
 * has already been refused (one raced in since makes `rmSync` throw). Returns
 * the removed path, if any; throws (wrapped) before anything is written when
 * the removal fails. `label` is how the entry is described: `"existing"` for
 * a project's own `.claude/` copy, `"stale"` for the CLI-owned staging.
 */
function removeStaleSkillEntry(
  destDir: string,
  label: "existing" | "stale",
): string | undefined {
  const staleEntry = join(destDir, CUSTOMIZE_SKILL_ENTRY_FILE);
  return wrapFs(`could not remove the ${label} ${staleEntry}`, () => {
    if (lstatSync(staleEntry, { throwIfNoEntry: false }) === undefined) {
      return undefined;
    }
    rmSync(staleEntry, { force: true });
    return staleEntry;
  });
}

/**
 * Whether a failed `"wx"` write had already created `dest` itself. An `open`
 * failure (`EEXIST` included) creates nothing, so only a failure after the
 * exclusive open succeeded -- e.g. `ENOSPC` mid-write -- leaves a file this
 * call owns. `"unknown"` when the `lstat` probing `dest` itself fails: the
 * entry is then neither removed (its origin is unknown) nor silently
 * treated as absent -- the caller names it in the error.
 */
function createdByFailedWrite(
  dest: string,
  cause: unknown,
): boolean | "unknown" {
  if (
    errnoField(cause, "syscall") === "open" ||
    errnoField(cause, "code") === "EEXIST"
  ) {
    return false;
  }
  try {
    return lstatSync(dest, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return "unknown";
  }
}

/** How one payload write went: whether it removed a pre-existing entry first, and, on failure, the error and whether its own write created `dest`. */
interface PayloadWriteOutcome {
  readonly replaced: boolean;
  readonly failure:
    | { readonly cause: unknown; readonly created: boolean | "unknown" }
    | undefined;
}

/**
 * Writes one payload file under `policy`. A replacing policy `lstat`s `dest`
 * before removing it, so the caller learns whether a pre-existing entry was
 * removed (and so is gone even if the run later fails).
 */
function writePayloadFile(
  dest: string,
  bytes: Buffer,
  policy: WritePolicy,
): PayloadWriteOutcome {
  let replaced = false;
  try {
    if (replacesExistingEntries(policy)) {
      const existed = lstatSync(dest, { throwIfNoEntry: false }) !== undefined;
      // Remove, then "wx": a symlink at dest is replaced, never followed.
      rmSync(dest, { force: true });
      replaced = existed;
    }
  } catch (cause) {
    return { replaced: false, failure: { cause, created: false } };
  }
  try {
    writeFileSync(dest, bytes, { flag: "wx" });
    return { replaced, failure: undefined };
  } catch (cause) {
    return {
      replaced,
      failure: { cause, created: createdByFailedWrite(dest, cause) },
    };
  }
}

/** A path rollback could not remove, with the errno code of that failure. */
interface LeftBehind {
  readonly path: string;
  readonly code: string;
}

/** Removes every path in `written` (best effort), returning how many were actually removed and which were not, each with its errno code. */
function rollBack(written: readonly string[]): {
  removed: number;
  leftBehind: LeftBehind[];
} {
  const leftBehind: LeftBehind[] = [];
  for (const path of written) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      // Best effort: the write failure is the error that matters; a path
      // this rollback could not remove is named in that error instead.
      leftBehind.push({ path, code: errnoField(error, "code") ?? "unknown" });
    }
  }
  return { removed: written.length - leftBehind.length, leftBehind };
}

/**
 * The clauses a failed write's error adds after its rollback count: paths
 * rollback could not remove, a write whose own creation is unknown, a
 * left-behind `SKILL.md`, and the pre-existing entries this run removed and
 * cannot restore. Each is `""` when it does not apply.
 */
function failureClauses(args: {
  readonly dest: string;
  readonly destDir: string;
  readonly policy: WritePolicy;
  readonly leftBehind: readonly LeftBehind[];
  readonly createdUnknown: boolean;
  readonly skillRemoved: string | undefined;
  readonly replaced: readonly string[];
}): string {
  const { dest, destDir, policy, leftBehind, createdUnknown } = args;
  const notRemoved =
    leftBehind.length > 0
      ? ` (could not remove: ${leftBehind.map((l) => `${l.path} (${l.code})`).join(", ")})`
      : "";
  const skillPath = join(destDir, CUSTOMIZE_SKILL_ENTRY_FILE);
  const skillLeftBehind = leftBehind.some((l) => l.path === skillPath);
  const unknownIsSkill = createdUnknown && dest === skillPath;
  // Either way a possibly-truncated SKILL.md sits at the destination, and
  // its own clause says what to do -- the generic "not loadable" clause
  // would contradict it.
  const skillMaybeLeft = skillLeftBehind || unknownIsSkill;
  const unknown = createdUnknown
    ? `; ${dest} was left in place; whether this run created it is unknown${
        unknownIsSkill
          ? " -- it may be a truncated copy; delete it by hand"
          : ""
      }`
    : "";
  const skillLeft = skillLeftBehind
    ? `; ${skillPath} was left behind -- delete it by hand; ${
        policy === "cli-owned"
          ? "it is a truncated copy"
          : "Claude Code will load a truncated skill"
      }`
    : "";
  return `${notRemoved}${unknown}${skillLeft}${replacedClause(policy, args.skillRemoved, args.replaced, skillMaybeLeft)}`;
}

/** The "removed and not restored" clause for a replacing policy's pre-existing entries; `""` when none were removed. */
function replacedClause(
  policy: WritePolicy,
  skillRemoved: string | undefined,
  replaced: readonly string[],
  skillMaybeLeft: boolean,
): string {
  const others =
    replaced.length > 0
      ? `the previous ${replaced.join(", ")} ${replaced.length === 1 ? "was" : "were"} removed and NOT restored`
      : "";
  switch (policy) {
    case "overwrite": {
      if (skillRemoved === undefined && others === "") {
        return "";
      }
      // One sentence for SKILL.md and the other payload files alike: every
      // one of them was removed and none is restored.
      const removedPaths = [
        ...(skillRemoved === undefined
          ? []
          : [
              `the existing SKILL.md (${skillRemoved}, removed before any data file was rewritten)`,
            ]),
        ...(replaced.length > 0 ? [`the previous ${replaced.join(", ")}`] : []),
      ];
      const count = (skillRemoved === undefined ? 0 : 1) + replaced.length;
      const notLoadable = skillMaybeLeft
        ? ""
        : " -- the skill is not loadable until a successful re-run";
      return `; ${removedPaths.join(" and ")} ${count === 1 ? "was" : "were"} removed and NOT restored${notLoadable}`;
    }
    case "cli-owned": {
      const stale =
        skillRemoved === undefined
          ? ""
          : `; the stale ${skillRemoved} was removed before any data file was rewritten`;
      return `${stale}${others === "" ? "" : `; ${others}`}`;
    }
    case "additive":
      return "";
    default: {
      const exhaustive: never = policy;
      throw new Error(`unhandled write policy: ${String(exhaustive)}`);
    }
  }
}

/**
 * Writes `payload` into `<targetDir>/<destination.segments>`, skipping any
 * name in `alreadyCurrent` (files an interrupted install already wrote
 * byte-identically), and returns the written paths relative to `targetDir`.
 *
 * Before any `mkdir`/`rm`/write, every directory component from `targetDir`
 * down to the destination is `lstat`-checked ({@link assertNotSymlink}), so
 * a symlinked `.claude`/`.groundwork` (or any level below it) is refused
 * rather than followed out of the project. Every payload file is created
 * with `"wx"`, so a symlink at the file itself is never written through:
 * under `"overwrite"`/`"cli-owned"` it is removed first and replaced; under
 * `"additive"` nothing is removed and the write fails `EEXIST`. A directory
 * component swapped for a symlink between the check and the write (a TOCTOU
 * race) is not covered.
 *
 * Under `"overwrite"`, the destination is classified first
 * ({@link classifyExistingSkill}); when every payload file there is already
 * a byte-identical regular file, nothing is removed or written and
 * `filesWritten` is empty. A failing `lstat` probe there throws before
 * anything is touched; a regular file that cannot be read counts as not
 * current, so it is removed and rewritten like any other stale copy.
 *
 * Before anything is removed or written, a directory at any payload name
 * this run writes is refused ({@link assertNoDirectoryAtPayloadNames}), as
 * is -- under a replacing policy -- a payload name whose `lstat` fails,
 * leaving every existing entry untouched. Writes then follow
 * {@link CUSTOMIZE_SKILL_WRITE_ORDER}, `SKILL.md` last; for the policies
 * that replace existing entries, {@link removeStaleSkillEntry} establishes
 * that order's no-`SKILL.md`-yet precondition first. Names in
 * `alreadyCurrent` are not rechecked before the `SKILL.md` write: one
 * changed after the caller classified it (an accepted race window) is not
 * detected.
 *
 * If any write fails, every file THIS call wrote -- including one whose own
 * write created it and then failed part-way -- is removed (best effort), and
 * the error names how many were, any it could not remove (with its errno
 * code; a left-behind `SKILL.md` additionally says to delete it by hand),
 * any whose creation could not be determined (in its own "left in place;
 * whether this run created it is unknown" clause -- for `SKILL.md`, also
 * saying it may be a truncated copy to delete by hand), and the pre-removed
 * `SKILL.md` if there was one. Rollback never removes an entry this call did
 * not write, but under `"overwrite"`/`"cli-owned"` the pre-existing entries
 * this call replaced before the failure (the `SKILL.md`, and each payload
 * file removed ahead of its own write) are not restored -- the error names
 * each of them as "removed and NOT restored". Under `"overwrite"` it adds
 * that the skill is not loadable until a successful re-run, unless a
 * possibly-truncated `SKILL.md` may still sit at the destination, whose own
 * clause already says what to do. Every failure -- a symlink refusal, a
 * directory at a payload name, a raw `lstat`/`mkdir` error such as
 * `ENOTDIR`, a write error -- is thrown as one "could not install the
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
  const skillRemoved = replacesExistingEntries(policy)
    ? removeStaleSkillEntry(
        destDir,
        policy === "overwrite" ? "existing" : "stale",
      )
    : undefined;

  const written: string[] = [];
  const replaced: string[] = [];
  const filesWritten: string[] = [];
  for (const { name, bytes } of payload) {
    if (alreadyCurrent.has(name)) {
      continue;
    }
    const dest = join(destDir, name);
    const outcome = writePayloadFile(dest, bytes, policy);
    if (outcome.replaced) {
      replaced.push(dest);
    }
    const { failure } = outcome;
    if (failure !== undefined) {
      if (failure.created === true) {
        written.push(dest);
      }
      const { removed, leftBehind } = rollBack(written);
      const occupied =
        errnoField(failure.cause, "code") === "EEXIST"
          ? `; an entry this run did not create sits there (a project entry appeared during the install, or the name was already taken) and was left untouched`
          : "";
      const clauses = failureClauses({
        dest,
        destDir,
        policy,
        leftBehind,
        createdUnknown: failure.created === "unknown",
        skillRemoved,
        replaced,
      });
      throw installError(
        `could not write ${dest}${occupied}; removed the ${removed} file(s) written by this run${clauses}`,
        failure.cause,
      );
    }
    written.push(dest);
    filesWritten.push(join(...segments, name));
  }

  return { filesWritten };
}

/**
 * Installs the skill into `<targetDir>/.claude/skills/customize/`. Used by
 * fresh-bootstrap mode, where the directory is normally new (`--force` may
 * point it at a non-empty one or an earlier install). An earlier install
 * that is already byte-identical to this payload is left untouched
 * (`filesWritten` is empty); otherwise any existing `SKILL.md` is removed
 * first, then each payload file is removed and recreated. A symlinked
 * `.claude`, `.claude/skills` or `.claude/skills/customize` is refused, not
 * routed around.
 *
 * @throws `Error` ("could not install the /customize skill ...", raw error
 * as `cause`) on a missing or unreadable source file, a directory at any
 * payload name, a payload name or existing file that cannot be `lstat`ed,
 * or an existing regular file whose read fails with anything other than
 * `EACCES`/`EPERM` (all before anything is removed or written), a symlinked
 * or non-directory directory component, any fs failure, or a failed write
 * -- after removing every file this call wrote. An existing regular file
 * whose read fails with `EACCES` or `EPERM` is not a failure: it is replaced
 * like any stale copy. Entries it replaced before the failure are not
 * restored; the error names them. A failure to locate the default
 * `sourceDir` is thrown the same way. The message ends, once, by saying to
 * fix the cause (for a symlink: remove it), then retry
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
  | { readonly kind: "foreign"; readonly reason: string };

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
    const verdict: FileComparison = stat.isFile()
      ? regularFileMatches(installedPath, bytes)
      : { kind: "mismatch" };
    if (verdict.kind === "unreadable") {
      // No ", so" clause here: installGuarded appends its own.
      return {
        kind: "foreign",
        reason: `${installedPath} already exists and could not be read (${verdict.code}); it cannot be confirmed as this CLI's current copy`,
      };
    }
    if (verdict.kind === "mismatch") {
      return {
        kind: "foreign",
        reason: `${installedPath} already exists and is not this CLI's current copy`,
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
    };
  }
  return { kind: "installable", alreadyCurrent };
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
 * Writes into `.claude/skills/customize/` use `"wx"` only, so an entry that
 * appears there mid-install fails the run (rolled back) rather than being
 * replaced. Writes into the CLI-owned `.groundwork/customize/` replace that
 * directory's payload files (any `SKILL.md` removed first, then each file
 * removed and recreated with `"wx"`); a symlinked `.groundwork` or
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
 * payload name there -- after removing every file this call wrote. A failed
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
