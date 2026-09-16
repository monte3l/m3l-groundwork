/**
 * Installs the `/customize` skill into a bootstrapped project. Claude Code's
 * marketplace-based plugin installation is an interactive, network-involving
 * flow this offline CLI can't drive; instead this copies the skill's SKILL.md
 * plus its deterministic backing data directly into the target's
 * `.claude/skills/customize/`, so `/customize` works immediately after
 * bootstrap with no further setup step.
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
 * (`src/kind-facet-map.ts`, `src/domain-map.ts`) from `sourceDir` into
 * `<targetDir>/.claude/skills/customize/`.
 */
export function installCustomizeSkill(
  targetDir: string,
  sourceDir: string = pluginDir(),
): InstallPluginResult {
  const skillSourceDir = join(sourceDir, "skills", "customize");
  const dataSourceDir = join(sourceDir, "src");
  const destDir = join(targetDir, ".claude", "skills", "customize");
  mkdirSync(destDir, { recursive: true });

  const filesWritten: string[] = [];
  const copyInto = (from: string, toName: string): void => {
    if (!existsSync(from)) return;
    writeFileSync(join(destDir, toName), readFileSync(from, "utf8"));
    filesWritten.push(join(".claude", "skills", "customize", toName));
  };

  copyInto(join(skillSourceDir, "SKILL.md"), "SKILL.md");
  copyInto(join(dataSourceDir, "kind-facet-map.ts"), "kind-facet-map.ts");
  copyInto(join(dataSourceDir, "domain-map.ts"), "domain-map.ts");

  return { filesWritten };
}
