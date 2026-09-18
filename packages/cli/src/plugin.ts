/**
 * Installs the `/customize` skill into a bootstrapped or adopted project.
 * Claude Code's marketplace-based plugin installation is an interactive,
 * network-involving flow this offline CLI can't drive; instead this copies
 * the skill's SKILL.md plus its deterministic backing data directly into a
 * destination directory, so `/customize` works immediately with no further
 * setup step.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves the m3l-groundwork plugin package directory relative to this module. */
function pluginDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "packages", "plugin");
}

export interface InstallPluginResult {
  filesWritten: string[];
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
  const skillSourceDir = join(sourceDir, "skills", "customize");
  const dataSourceDir = join(sourceDir, "src");
  mkdirSync(destDir, { recursive: true });

  const filesWritten: string[] = [];
  const copyInto = (from: string, toName: string): void => {
    if (!existsSync(from)) {
      throw new Error(`the /customize skill's source file is missing: ${from}`);
    }
    writeFileSync(join(destDir, toName), readFileSync(from, "utf8"));
    filesWritten.push(toName);
  };

  copyInto(join(skillSourceDir, "SKILL.md"), "SKILL.md");
  copyInto(join(dataSourceDir, "kind-facet-map.ts"), "kind-facet-map.ts");
  copyInto(join(dataSourceDir, "domain-map.ts"), "domain-map.ts");
  copyInto(join(dataSourceDir, "pack-map.ts"), "pack-map.ts");

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

/**
 * Adopt-mode install: purely additive, never overwrites. If the project
 * already has its own `.claude/skills/customize/SKILL.md` and its content
 * differs from what this CLI ships, the skill is written to
 * `.groundwork/customize/` instead -- reported in the adoption report
 * rather than silently overwriting whatever the project already had there.
 */
export function installCustomizeSkillGuarded(
  targetDir: string,
  sourceDir: string = pluginDir(),
): GuardedInstallResult {
  const existingSkillMdPath = join(
    targetDir,
    ".claude",
    "skills",
    "customize",
    "SKILL.md",
  );
  const sourceSkillMdPath = join(sourceDir, "skills", "customize", "SKILL.md");

  if (existsSync(existingSkillMdPath)) {
    const existingContent = readFileSync(existingSkillMdPath, "utf8");
    const sourceContent = existsSync(sourceSkillMdPath)
      ? readFileSync(sourceSkillMdPath, "utf8")
      : undefined;

    if (sourceContent !== undefined && existingContent === sourceContent) {
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
