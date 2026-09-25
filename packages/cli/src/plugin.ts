/**
 * Installs the `/customize` skill into a bootstrapped or adopted project.
 * Claude Code's marketplace-based plugin installation is an interactive,
 * network-involving flow this offline CLI can't drive; instead this copies
 * the skill's SKILL.md plus its deterministic backing data directly into a
 * destination directory, so `/customize` works immediately with no further
 * setup step.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAsset } from "./assets.js";

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
  const dataSourceDir = join(sourceDir, "src");
  return [
    ["SKILL.md", join(sourceDir, "skills", "customize", "SKILL.md")],
    ["kind-facet-map.ts", join(dataSourceDir, "kind-facet-map.ts")],
    ["domain-map.ts", join(dataSourceDir, "domain-map.ts")],
    ["pack-map.ts", join(dataSourceDir, "pack-map.ts")],
  ];
}

/**
 * Copies `skills/customize/SKILL.md` and its backing data
 * (`src/kind-facet-map.ts`, `src/domain-map.ts`, `src/pack-map.ts`) from
 * `sourceDir` into `destDir`. A missing source file is a broken install,
 * not something to degrade past silently -- it throws.
 */
function copyCustomizeSkillFiles(
  destDir: string,
  sourceDir: string,
): InstallPluginResult {
  mkdirSync(destDir, { recursive: true });

  const filesWritten: string[] = [];
  for (const [toName, from] of customizeSkillPayload(sourceDir)) {
    if (!existsSync(from)) {
      throw new Error(`the /customize skill's source file is missing: ${from}`);
    }
    writeFileSync(join(destDir, toName), readFileSync(from, "utf8"));
    filesWritten.push(toName);
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
  const destDir = join(targetDir, ".claude", "skills", "customize");
  const result = copyCustomizeSkillFiles(destDir, sourceDir);
  return {
    filesWritten: result.filesWritten.map((name) =>
      join(".claude", "skills", "customize", name),
    ),
  };
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
 * already has its own `.claude/skills/customize/SKILL.md` and any of the
 * four payload files (SKILL.md plus its three backing data files) is missing
 * or differs from what this CLI ships, the skill is written to
 * `.groundwork/customize/` instead -- reported in the adoption report
 * rather than silently overwriting whatever the project already had there.
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

    const destDir = join(targetDir, ".groundwork", "customize");
    const result = copyCustomizeSkillFiles(destDir, sourceDir);
    return {
      filesWritten: result.filesWritten.map((name) =>
        join(".groundwork", "customize", name),
      ),
      location: "groundwork",
    };
  }

  const result = installCustomizeSkill(targetDir, sourceDir);
  return { filesWritten: result.filesWritten, location: "claude" };
}
