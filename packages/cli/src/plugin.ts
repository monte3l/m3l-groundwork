// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Installs the `/customize` skill into a bootstrapped or adopted project.
 * Claude Code's marketplace-based plugin installation is an interactive,
 * network-involving flow this offline CLI can't drive; instead this copies
 * the skill's SKILL.md plus its deterministic backing data directly into a
 * destination directory, so `/customize` works immediately with no further
 * setup step.
 */
import {
  existsSync,
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
  CUSTOMIZE_SKILL_WRITE_ORDER,
  GROUNDWORK_DEST_SEGMENTS,
} from "./customize-paths.js";
import { assertNotSymlink } from "./fs-guard.js";

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
  /** Paths relative to the project root, in write order (`SKILL.md` last). */
  filesWritten: string[];
}

/** The remediation every install failure ends with -- appended once, never twice. */
const REMEDIATION = "re-run the CLI";

/**
 * Builds the one error shape every install failure surfaces as, keeping the
 * underlying message and chaining the raw error as `cause`. A cause whose own
 * message already ends in a "re-run the CLI" remediation (e.g.
 * {@link assertNotSymlink}'s) is not given a second one.
 */
function installError(detail: string, cause: unknown): Error {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const remediation = causeMessage.includes(REMEDIATION)
    ? ""
    : ` -- fix the cause and ${REMEDIATION}`;
  return new Error(
    `could not install the /customize skill: ${detail}: ${causeMessage}${remediation}`,
    { cause },
  );
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
 * Reads every payload file from the plugin source, in
 * {@link CUSTOMIZE_SKILL_WRITE_ORDER} (`SKILL.md` last), before anything is
 * written. A missing source file is a broken install, not something to
 * degrade past silently: it throws.
 */
function readCustomizeSkillPayload(sourceDir: string): readonly PayloadFile[] {
  return CUSTOMIZE_SKILL_WRITE_ORDER.map((name) => {
    const from =
      name === CUSTOMIZE_SKILL_ENTRY_FILE
        ? join(sourceDir, "skills", "customize", name)
        : join(sourceDir, "src", name);
    if (!existsSync(from)) {
      throw installError(
        "could not read the plugin payload",
        new Error(`the /customize skill's source file is missing: ${from}`),
      );
    }
    return {
      name,
      bytes: wrapFs(`could not read ${from}`, () => readFileSync(from)),
    };
  });
}

/**
 * How a destination's existing entries are treated.
 *
 * - `"overwrite"`: fresh mode's `.claude/skills/customize/` (which `--force`
 *   may point at a non-empty directory) -- each payload file is removed, then
 *   recreated with `"wx"`.
 * - `"additive"`: adopt mode's `.claude/skills/customize/`, which belongs to
 *   the project -- nothing is ever removed; `"wx"` alone, so an entry that
 *   appears there mid-install makes the write fail `EEXIST`.
 * - `"cli-owned"`: `.groundwork/customize/`, the CLI's own staging -- a stale
 *   `SKILL.md` is removed first ({@link removeStaleSkillEntry}), then each
 *   payload file is removed and recreated with `"wx"`.
 */
type WritePolicy = "overwrite" | "additive" | "cli-owned";

/** Where an install writes (segments relative to the project root) and how it treats what is already there. */
interface SkillDestination {
  readonly segments: readonly string[];
  readonly policy: WritePolicy;
}

const FRESH_DESTINATION: SkillDestination = {
  segments: CLAUDE_DEST_SEGMENTS,
  policy: "overwrite",
};
const ADOPT_CLAUDE_DESTINATION: SkillDestination = {
  segments: CLAUDE_DEST_SEGMENTS,
  policy: "additive",
};
const CLI_OWNED_DESTINATION: SkillDestination = {
  segments: GROUNDWORK_DEST_SEGMENTS,
  policy: "cli-owned",
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
 * For the CLI-owned destination only: removes an existing non-directory
 * `SKILL.md` entry (a file or a symlink, unlinked, never followed) BEFORE any
 * data file is rewritten, so a later failure never leaves a stale `SKILL.md`
 * loadable beside missing or half-rewritten data. A directory named
 * `SKILL.md` is not a loadable entry; it is left to the `SKILL.md` write,
 * which fails on it. Returns the removed path, if any; throws (wrapped)
 * before anything is written when the removal fails.
 */
function removeStaleSkillEntry(destDir: string): string | undefined {
  const staleEntry = join(destDir, CUSTOMIZE_SKILL_ENTRY_FILE);
  return wrapFs(`could not remove the stale ${staleEntry}`, () => {
    const stat = lstatSync(staleEntry, { throwIfNoEntry: false });
    if (stat === undefined || stat.isDirectory()) {
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
 * call owns. Best effort: an `lstat` that itself fails counts as "not
 * created", so an entry of unknown origin is never removed.
 */
function createdByFailedWrite(dest: string, cause: unknown): boolean {
  if (
    errnoField(cause, "syscall") === "open" ||
    errnoField(cause, "code") === "EEXIST"
  ) {
    return false;
  }
  try {
    return lstatSync(dest, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** Writes one payload file under `policy`; on failure, returns the error and whether this call's own write created `dest` before failing. */
function writePayloadFile(
  dest: string,
  bytes: Buffer,
  policy: WritePolicy,
): { cause: unknown; created: boolean } | undefined {
  try {
    if (replacesExistingEntries(policy)) {
      // Remove, then "wx": a symlink at dest is replaced, never followed.
      rmSync(dest, { force: true });
    }
  } catch (cause) {
    return { cause, created: false };
  }
  try {
    writeFileSync(dest, bytes, { flag: "wx" });
    return undefined;
  } catch (cause) {
    return { cause, created: createdByFailedWrite(dest, cause) };
  }
}

/** Removes every path in `written` (best effort), returning how many were actually removed and which were not, each with its errno code. */
function rollBack(written: readonly string[]): {
  removed: number;
  leftBehind: string[];
} {
  const leftBehind: string[] = [];
  for (const path of written) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      // Best effort: the write failure is the error that matters; a path
      // this rollback could not remove is named in that error instead.
      leftBehind.push(`${path} (${errnoField(error, "code") ?? "unknown"})`);
    }
  }
  return { removed: written.length - leftBehind.length, leftBehind };
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
 * Writes follow {@link CUSTOMIZE_SKILL_WRITE_ORDER}, `SKILL.md` last; for
 * `"cli-owned"`, {@link removeStaleSkillEntry} establishes that order's
 * no-`SKILL.md`-yet precondition first. If any write fails, every file THIS
 * call created -- including one whose own write created it and then failed
 * part-way -- is removed (best effort), and the error names how many were,
 * any it could not remove (with its errno code), and the stale `SKILL.md`
 * if one was pre-removed; no entry this call did not create is ever
 * removed. Every failure -- a symlink refusal, a raw `lstat`/`mkdir` error
 * such as `ENOTDIR`, a write error -- is thrown as one "could not install
 * the /customize skill" `Error` carrying the underlying message and the raw
 * error as `cause`.
 */
function copyCustomizeSkillFiles(
  targetDir: string,
  destination: SkillDestination,
  payload: readonly PayloadFile[],
  alreadyCurrent: ReadonlySet<string> = new Set(),
): InstallPluginResult {
  const { segments, policy } = destination;
  const destDir = wrapFs(
    `could not prepare ${join(targetDir, ...segments)}`,
    () => {
      let dir = targetDir;
      for (const segment of segments) {
        dir = join(dir, segment);
        assertNotSymlink(dir);
      }
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  );

  const staleRemoved =
    policy === "cli-owned" ? removeStaleSkillEntry(destDir) : undefined;
  const staleClause =
    staleRemoved === undefined
      ? ""
      : `; the stale ${staleRemoved} was removed before any data file was rewritten`;

  const written: string[] = [];
  const filesWritten: string[] = [];
  for (const { name, bytes } of payload) {
    if (alreadyCurrent.has(name)) {
      continue;
    }
    const dest = join(destDir, name);
    const failure = writePayloadFile(dest, bytes, policy);
    if (failure !== undefined) {
      if (failure.created) {
        written.push(dest);
      }
      const { removed, leftBehind } = rollBack(written);
      const notRemoved =
        leftBehind.length > 0
          ? ` (could not remove: ${leftBehind.join(", ")})`
          : "";
      const occupied =
        errnoField(failure.cause, "code") === "EEXIST"
          ? `; an entry this run did not create sits there (a project entry appeared during the install, or the name was already taken) and was left untouched`
          : "";
      throw installError(
        `could not write ${dest}${occupied}; removed the ${removed} file(s) already written by this run${notRemoved}${staleClause}`,
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
 * point it at a non-empty one, so each payload file is removed, then
 * recreated). A symlinked `.claude`, `.claude/skills` or
 * `.claude/skills/customize` is refused, not routed around.
 *
 * @throws `Error` ("could not install the /customize skill ...", raw error
 * as `cause`) on a missing source file (before anything is written), a
 * symlinked or non-directory directory component, any fs failure, or a
 * failed write -- after removing every file this call created.
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
  sourceDir: string = pluginDir(),
): InstallPluginResult {
  return copyCustomizeSkillFiles(
    targetDir,
    FRESH_DESTINATION,
    readCustomizeSkillPayload(sourceDir),
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
 */
function classifyExistingSkill(
  existingDir: string,
  payload: readonly PayloadFile[],
): ExistingSkill {
  const alreadyCurrent = new Set<string>();
  let entryLoadable = false;
  for (const { name, bytes } of payload) {
    const installedPath = join(existingDir, name);
    const stat = lstatSync(installedPath, { throwIfNoEntry: false });
    if (stat === undefined) {
      continue;
    }
    if (!stat.isFile() || !readFileSync(installedPath).equals(bytes)) {
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

/**
 * Adopt-mode install: purely additive, never overwrites or removes a project
 * entry under `.claude/skills/customize/`.
 *
 * - If `.claude`, `.claude/skills` or `.claude/skills/customize` is a
 *   symlink or not a directory, the skill is written to
 *   `.groundwork/customize/` instead and `fallbackReason` names that path --
 *   the entry (and any link target) is left untouched.
 * - Otherwise, if every payload file already there is a regular file
 *   matching what this CLI ships byte-for-byte: with all five present the
 *   result is `"already-present"` (nothing written); with no `SKILL.md` file
 *   (none at all, or an install interrupted before writing it) the missing
 *   files are written into `.claude/skills/customize/`, `SKILL.md` last,
 *   never rewriting or removing the correct ones.
 * - Anything else under a payload name (a differing file, a symlink --
 *   dangling or not -- a directory, a `SKILL.md` without its data; detected
 *   by `lstat`) is kept as the project's own: the skill is written to
 *   `.groundwork/customize/` instead and `fallbackReason` names that entry.
 *   Claude Code does not load a skill from there; the caller must say so.
 *
 * Writes into `.claude/skills/customize/` use `"wx"` only, so an entry that
 * appears there mid-install fails the run (rolled back) rather than being
 * replaced. Writes into the CLI-owned `.groundwork/customize/` replace that
 * directory's payload files (remove, then `"wx"`); a symlinked `.groundwork`
 * or `.groundwork/customize` is refused, never routed around.
 *
 * @throws `Error` ("could not install the /customize skill ...", raw error
 * as `cause`) on a missing source file (before anything is written), any fs
 * failure while probing or writing, or a symlinked
 * `.groundwork`/`.groundwork/customize` -- after removing every file this
 * call created.
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
  sourceDir: string = pluginDir(),
): GuardedInstallResult {
  const payload = readCustomizeSkillPayload(sourceDir);
  const existingDir = join(targetDir, ...CLAUDE_DEST_SEGMENTS);
  const installToGroundwork = (reason: string): GuardedInstallResult => ({
    filesWritten: copyCustomizeSkillFiles(
      targetDir,
      CLI_OWNED_DESTINATION,
      payload,
    ).filesWritten,
    location: "groundwork",
    fallbackReason: `${reason}, so the /customize skill was installed into .groundwork/customize/ instead`,
  });

  const unusable = wrapFs(`could not inspect ${existingDir}`, () =>
    firstUnusableComponent(targetDir, CLAUDE_DEST_SEGMENTS),
  );
  if (unusable !== undefined) {
    return installToGroundwork(unusable);
  }

  const existing = wrapFs(`could not compare ${existingDir}`, () =>
    classifyExistingSkill(existingDir, payload),
  );
  switch (existing.kind) {
    case "current":
      return { filesWritten: [], location: "already-present" };
    case "foreign":
      return installToGroundwork(existing.reason);
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
