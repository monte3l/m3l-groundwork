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
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveAsset } from "./assets.js";
import {
  CLAUDE_DEST_SEGMENTS,
  CUSTOMIZE_SKILL_FILE_NAMES,
  GROUNDWORK_DEST_SEGMENTS,
} from "./customize-paths.js";
import { assertNotSymlink } from "./fs-guard.js";

/** Resolves the plugin payload for a source checkout (`packages/plugin`) or a published tarball (`plugin/`). */
function pluginDir(): string {
  return resolveAsset({ repo: "packages/plugin", local: "plugin" });
}

export interface InstallPluginResult {
  filesWritten: string[];
}

/** Each payload file's name inside an installed copy, paired with its path in the plugin source. */
function customizeSkillPayload(
  sourceDir: string,
): readonly (readonly [string, string])[] {
  return CUSTOMIZE_SKILL_FILE_NAMES.map((name) => [
    name,
    name === "SKILL.md"
      ? join(sourceDir, "skills", "customize", name)
      : join(sourceDir, "src", name),
  ]);
}

/**
 * Copies `skills/customize/SKILL.md` and its backing data
 * (`src/kind-facet-map.ts`, `src/domain-map.ts`, `src/pack-map.ts`,
 * `src/plugin-map.ts`) from `sourceDir` into `<targetDir>/<destSegments>`,
 * returning the written paths relative to `targetDir`. A missing source
 * file is a broken install, not something to degrade past silently -- it
 * throws.
 *
 * Before any `mkdir`/`rm`/write, every directory component from `targetDir`
 * down to the destination is `lstat`-checked ({@link assertNotSymlink}), so
 * a symlinked `.claude`/`.groundwork` (or any level below it) is refused
 * rather than followed out of the project. Each payload file is then
 * removed and recreated with `"wx"`, so a symlink planted at the file itself
 * is replaced, never written through. A directory component swapped for a
 * symlink between the check and the write (a TOCTOU race) is not covered.
 */
function copyCustomizeSkillFiles(
  targetDir: string,
  destSegments: readonly string[],
  sourceDir: string,
): InstallPluginResult {
  let destDir = targetDir;
  for (const segment of destSegments) {
    destDir = join(destDir, segment);
    assertNotSymlink(destDir);
  }
  mkdirSync(destDir, { recursive: true });

  const filesWritten: string[] = [];
  for (const [toName, from] of customizeSkillPayload(sourceDir)) {
    if (!existsSync(from)) {
      throw new Error(`the /customize skill's source file is missing: ${from}`);
    }
    const content = readFileSync(from, "utf8");
    const dest = join(destDir, toName);
    try {
      // Remove, then "wx": a symlink at dest is replaced, never followed.
      rmSync(dest, { force: true });
      writeFileSync(dest, content, { flag: "wx" });
    } catch (cause) {
      throw new Error(
        `could not write ${dest} while installing the /customize skill -- fix the cause and re-run the CLI`,
        { cause },
      );
    }
    filesWritten.push(join(...destSegments, toName));
  }

  return { filesWritten };
}

/**
 * Installs the skill into `<targetDir>/.claude/skills/customize/`. Used by
 * fresh-bootstrap mode, where the directory is always new.
 */
export function installCustomizeSkill(
  targetDir: string,
  sourceDir: string = pluginDir(),
): InstallPluginResult {
  return copyCustomizeSkillFiles(targetDir, CLAUDE_DEST_SEGMENTS, sourceDir);
}

type InstallLocation = "claude" | "groundwork" | "already-present";

export interface GuardedInstallResult {
  filesWritten: string[];
  location: InstallLocation;
}

/** True only when every payload file exists in both places and matches byte-for-byte. */
function isCustomizeSkillCurrent(
  installedDir: string,
  sourceDir: string,
): boolean {
  return customizeSkillPayload(sourceDir).every(([name, sourcePath]) => {
    const installedPath = join(installedDir, name);
    return (
      existsSync(installedPath) &&
      existsSync(sourcePath) &&
      readFileSync(installedPath).equals(readFileSync(sourcePath))
    );
  });
}

/**
 * Adopt-mode install: purely additive, never overwrites. If the project
 * already has its own `.claude/skills/customize/SKILL.md` and any file
 * `customizeSkillPayload()` names is missing or differs from what this CLI
 * ships, the skill is written to `.groundwork/customize/` instead --
 * reported in the adoption report rather than silently overwriting whatever
 * the project already had there.
 */
export function installCustomizeSkillGuarded(
  targetDir: string,
  sourceDir: string = pluginDir(),
): GuardedInstallResult {
  const existingDir = join(targetDir, ".claude", "skills", "customize");
  const existingSkillMdPath = join(existingDir, "SKILL.md");

  if (existsSync(existingSkillMdPath)) {
    if (isCustomizeSkillCurrent(existingDir, sourceDir)) {
      return { filesWritten: [], location: "already-present" };
    }

    const result = copyCustomizeSkillFiles(
      targetDir,
      GROUNDWORK_DEST_SEGMENTS,
      sourceDir,
    );
    return { filesWritten: result.filesWritten, location: "groundwork" };
  }

  const result = installCustomizeSkill(targetDir, sourceDir);
  return { filesWritten: result.filesWritten, location: "claude" };
}
