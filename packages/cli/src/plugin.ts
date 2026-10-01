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
  CUSTOMIZE_SKILL_FILE_NAMES,
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

/** Builds the one error shape every install failure surfaces as, keeping the underlying message and chaining the raw error as `cause`. */
function installError(detail: string, cause: unknown): Error {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `could not install the /customize skill: ${detail}: ${causeMessage} -- fix the cause and re-run the CLI`,
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

/**
 * Each payload file's name inside an installed copy, paired with its path in
 * the plugin source, in {@link CUSTOMIZE_SKILL_WRITE_ORDER} (`SKILL.md` last).
 */
function customizeSkillPayload(
  sourceDir: string,
): readonly (readonly [string, string])[] {
  return CUSTOMIZE_SKILL_WRITE_ORDER.map((name) => [
    name,
    name === CUSTOMIZE_SKILL_ENTRY_FILE
      ? join(sourceDir, "skills", "customize", name)
      : join(sourceDir, "src", name),
  ]);
}

/** Removes every path in `written` (best effort), returning how many were actually removed and which were not. */
function rollBack(written: readonly string[]): {
  removed: number;
  leftBehind: string[];
} {
  const leftBehind: string[] = [];
  for (const path of written) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best effort: the write failure is the error that matters; a path
      // this rollback could not remove is named in that error instead.
      leftBehind.push(path);
    }
  }
  return { removed: written.length - leftBehind.length, leftBehind };
}

/**
 * Copies `skills/customize/SKILL.md` and its backing data
 * (`src/kind-facet-map.ts`, `src/domain-map.ts`, `src/pack-map.ts`,
 * `src/plugin-map.ts`) from `sourceDir` into `<targetDir>/<destSegments>`,
 * returning the written paths relative to `targetDir`. A missing source
 * file is a broken install, not something to degrade past silently -- it
 * throws before anything is written.
 *
 * Before any `mkdir`/`rm`/write, every directory component from `targetDir`
 * down to the destination is `lstat`-checked ({@link assertNotSymlink}), so
 * a symlinked `.claude`/`.groundwork` (or any level below it) is refused
 * rather than followed out of the project. Each payload file is then
 * removed and recreated with `"wx"`, so a symlink planted at the file itself
 * is replaced, never written through. A directory component swapped for a
 * symlink between the check and the write (a TOCTOU race) is not covered.
 *
 * Writes follow {@link CUSTOMIZE_SKILL_WRITE_ORDER}, `SKILL.md` last. If any
 * write fails, every file THIS call already wrote is removed (best effort)
 * and the error names how many were; a file this call did not write is
 * never removed by the rollback. Every failure -- a symlink refusal, a raw
 * `lstat`/`mkdir` error such as `ENOTDIR`, a write error -- is thrown as one
 * "could not install the /customize skill" `Error` carrying the underlying
 * message and the raw error as `cause`.
 */
function copyCustomizeSkillFiles(
  targetDir: string,
  destSegments: readonly string[],
  sourceDir: string,
): InstallPluginResult {
  const contents = customizeSkillPayload(sourceDir).map(([toName, from]) => {
    if (!existsSync(from)) {
      throw new Error(`the /customize skill's source file is missing: ${from}`);
    }
    return [
      toName,
      wrapFs(`could not read ${from}`, () => readFileSync(from, "utf8")),
    ] as const;
  });

  const destDir = wrapFs(
    `could not prepare ${join(targetDir, ...destSegments)}`,
    () => {
      let dir = targetDir;
      for (const segment of destSegments) {
        dir = join(dir, segment);
        assertNotSymlink(dir);
      }
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  );

  const written: string[] = [];
  const filesWritten: string[] = [];
  for (const [toName, content] of contents) {
    const dest = join(destDir, toName);
    try {
      // Remove, then "wx": a symlink at dest is replaced, never followed.
      rmSync(dest, { force: true });
      writeFileSync(dest, content, { flag: "wx" });
    } catch (cause) {
      const { removed, leftBehind } = rollBack(written);
      const notRemoved =
        leftBehind.length > 0
          ? ` (could not remove: ${leftBehind.join(", ")})`
          : "";
      throw installError(
        `could not write ${dest}; removed the ${removed} file(s) already written by this run${notRemoved}`,
        cause,
      );
    }
    written.push(dest);
    filesWritten.push(join(...destSegments, toName));
  }

  return { filesWritten };
}

/**
 * Installs the skill into `<targetDir>/.claude/skills/customize/`. Used by
 * fresh-bootstrap mode, where the directory is always new. A symlinked
 * `.claude`, `.claude/skills` or `.claude/skills/customize` is refused, not
 * routed around.
 *
 * @throws `Error` ("could not install the /customize skill ...", raw error
 * as `cause`) on a symlinked directory component, any fs failure, or a
 * failed write -- after removing every file this call already wrote. A
 * missing source file throws before anything is written.
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
  return copyCustomizeSkillFiles(targetDir, CLAUDE_DEST_SEGMENTS, sourceDir);
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
   * Set only when `.claude/skills/customize/` could not be used because one
   * of its directory components is a symlink; names that path.
   */
  fallbackReason?: string;
}

/**
 * True only when every payload file is a regular file (by `lstat` -- a
 * symlink, FIFO or directory is never read and counts as differing) and
 * matches its source byte-for-byte.
 */
function isCustomizeSkillCurrent(
  installedDir: string,
  sourceDir: string,
): boolean {
  return customizeSkillPayload(sourceDir).every(([name, sourcePath]) => {
    const installedPath = join(installedDir, name);
    if (
      lstatSync(installedPath, { throwIfNoEntry: false })?.isFile() !== true
    ) {
      return false;
    }
    return (
      existsSync(sourcePath) &&
      readFileSync(installedPath).equals(readFileSync(sourcePath))
    );
  });
}

/** The first of `<targetDir>/<segments>`'s directory components that is a symlink, if any. */
function firstSymlinkedComponent(
  targetDir: string,
  segments: readonly string[],
): string | undefined {
  let dir = targetDir;
  for (const segment of segments) {
    dir = join(dir, segment);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      return dir;
    }
  }
  return undefined;
}

/**
 * Adopt-mode install: purely additive, never overwrites a project entry
 * under `.claude/skills/customize/`.
 *
 * - If `.claude`, `.claude/skills` or `.claude/skills/customize` is a
 *   symlink, the skill is written to `.groundwork/customize/` instead and
 *   `fallbackReason` names the symlinked path -- the link and its target
 *   are left untouched.
 * - Otherwise, if anything at all (file, directory, symlink, dangling or
 *   not; detected by `lstat`) exists under any payload name in
 *   `.claude/skills/customize/`, the existing copy is kept: either it is an
 *   exact current copy (every payload file a regular file matching what
 *   this CLI ships -- `"already-present"`, nothing written) or the skill is
 *   written to `.groundwork/customize/` instead, reported in the adoption
 *   report rather than silently replacing whatever the project had there.
 * - Otherwise it is installed into `.claude/skills/customize/`.
 *
 * Writes into `.groundwork/customize/` replace that directory's payload
 * files (remove, then `"wx"`); a symlinked `.groundwork` or
 * `.groundwork/customize` is refused, never routed around.
 *
 * @throws `Error` ("could not install the /customize skill ...", raw error
 * as `cause`) on any fs failure while probing or writing, or a symlinked
 * `.groundwork`/`.groundwork/customize` -- after removing every file this
 * call already wrote. A missing source file throws before anything is
 * written.
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
  const installToGroundwork = (): InstallPluginResult =>
    copyCustomizeSkillFiles(targetDir, GROUNDWORK_DEST_SEGMENTS, sourceDir);
  const existingDir = join(targetDir, ...CLAUDE_DEST_SEGMENTS);

  const symlinked = wrapFs(`could not inspect ${existingDir}`, () =>
    firstSymlinkedComponent(targetDir, CLAUDE_DEST_SEGMENTS),
  );
  if (symlinked !== undefined) {
    const { filesWritten } = installToGroundwork();
    return {
      filesWritten,
      location: "groundwork",
      fallbackReason: `${symlinked} is a symlink, so the /customize skill was installed into .groundwork/customize/ instead of writing through it`,
    };
  }

  const present = wrapFs(`could not inspect ${existingDir}`, () =>
    CUSTOMIZE_SKILL_FILE_NAMES.some(
      (name) =>
        lstatSync(join(existingDir, name), { throwIfNoEntry: false }) !==
        undefined,
    ),
  );
  if (present) {
    const current = wrapFs(`could not compare ${existingDir}`, () =>
      isCustomizeSkillCurrent(existingDir, sourceDir),
    );
    if (current) {
      return { filesWritten: [], location: "already-present" };
    }
    return {
      filesWritten: installToGroundwork().filesWritten,
      location: "groundwork",
    };
  }

  const { filesWritten } = installCustomizeSkill(targetDir, sourceDir);
  return { filesWritten, location: "claude" };
}
