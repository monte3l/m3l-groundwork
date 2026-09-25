/**
 * Counts the baseline's own `.claude/` + workflow + script artifacts
 * against the five hard caps `templates/core`'s own `CLAUDE.md` states
 * (≤5 agents, ≤8 skills, ≤10 hooks, ≤3 CI workflows, ≤12 root scripts).
 * A cap is a fixed upper bound on how many artifacts of one category
 * (agents, skills, hooks, CI workflows, root `package.json` scripts) the
 * emitted baseline may contain -- kept deliberately low so a bootstrapped
 * project's Claude Code harness and toolchain stay small enough for a human
 * to read and reason about in full, rather than growing without bound as
 * more capability gets added. The counting logic and the cap numbers both live here, once, so
 * `report.ts` (the adoption-report table) and `main.ts` (the fresh-mode
 * post-install summary) can't state a different number for the same cap.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "./jsonc.js";

export interface CapCounts {
  agents: number;
  skills: number;
  hooks: number;
  workflows: number;
  scripts: number;
}

/** The baseline's own hard caps -- `templates/core`'s `CLAUDE.md` is the prose statement of these same numbers. */
export const CAP_LIMITS: CapCounts = {
  agents: 5,
  skills: 8,
  hooks: 10,
  workflows: 3,
  scripts: 12,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function countDirEntries(
  dir: string,
  filter?: (name: string) => boolean,
): number {
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir);
  return filter === undefined ? names.length : names.filter(filter).length;
}

function countPackageScripts(root: string): number {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return 0;
  const parsed = parseJsonc(readFileSync(pkgPath, "utf8"));
  if (!parsed.ok || !isRecord(parsed.value)) return 0;
  const scripts = parsed.value["scripts"];
  return isRecord(scripts) ? Object.keys(scripts).length : 0;
}

/** Raw artifact counts at `root`, with no baseline-specific adjustment. */
function countArtifacts(root: string): CapCounts {
  const claudeDir = join(root, ".claude");
  return {
    agents: countDirEntries(join(claudeDir, "agents"), (n) =>
      n.endsWith(".md"),
    ),
    skills: countDirEntries(join(claudeDir, "skills")),
    hooks: countDirEntries(
      join(claudeDir, "hooks"),
      (n) => n.endsWith(".mjs") || n.endsWith(".js"),
    ),
    workflows: countDirEntries(
      join(root, ".github", "workflows"),
      (n) => n.endsWith(".yml") || n.endsWith(".yaml"),
    ),
    scripts: countPackageScripts(root),
  };
}

/**
 * Counts every capped artifact category at `templateRoot`
 * (`templates/core`). The `skills` count adds 1 for the `/customize` skill,
 * which ships via the plugin copy rather than as a `templates/core` file --
 * see `plugin.ts`.
 */
export function countBaselineCaps(templateRoot: string): CapCounts {
  const raw = countArtifacts(templateRoot);
  return { ...raw, skills: raw.skills + 1 };
}

/**
 * Counts every capped artifact category under a pack's `files/` root --
 * the same shape as {@link countBaselineCaps} but without the `/customize`
 * adjustment, since a pack never ships that skill. Used to verify a pack's
 * declared `budget` matches what its own file tree actually contains.
 */
export function countPackBudget(packFilesDir: string): CapCounts {
  return countArtifacts(packFilesDir);
}
