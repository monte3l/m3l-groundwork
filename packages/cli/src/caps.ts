// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

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

/**
 * Every capped category, in display order: the one list the caps summary,
 * `--add-pack`'s plan and anything else iterating the caps use.
 *
 * @example
 * ```ts
 * import { CAP_KEYS, CAP_LIMITS } from "./caps.js";
 * const over = CAP_KEYS.filter((key) => counts[key] > CAP_LIMITS[key]);
 * ```
 */
export const CAP_KEYS: readonly (keyof CapCounts)[] = [
  "agents",
  "skills",
  "hooks",
  "workflows",
  "scripts",
];

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

function countPackageScripts(
  root: string,
  undetermined: string[] | undefined,
): number {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return 0;
  const parsed = parseJsonc(readFileSync(pkgPath, "utf8"));
  if (!parsed.ok || !isRecord(parsed.value)) {
    // Relative path only, never the parser's message: it can quote the file.
    undetermined?.push(
      "package.json is not a parseable JSON object, so its scripts were not counted toward the scripts cap",
    );
    return 0;
  }
  const scripts = parsed.value["scripts"];
  return isRecord(scripts) ? Object.keys(scripts).length : 0;
}

/**
 * Raw artifact counts at a project root, with no adjustment of any kind:
 * `.claude/agents/*.md`, every entry of `.claude/skills/` (the `/customize`
 * skill included when it is there), `.claude/hooks/*.{mjs,js}`,
 * `.github/workflows/*.{yml,yaml}` and the keys of `package.json`'s
 * `scripts`. A missing directory or `package.json`, or one that does not
 * parse, counts 0; when `undetermined` is given, a `package.json` that
 * exists but is not a parseable JSON object also pushes a note naming it by
 * relative path (never the parser's message). `--add-pack` uses it for the
 * project's current counts; {@link countBaselineCaps} and
 * {@link countPackBudget} build on it, without notes.
 *
 * @throws The raw `fs` error when an existing directory or `package.json`
 * cannot be read.
 *
 * @example
 * ```ts
 * const notes: string[] = [];
 * const current = countProjectCaps("/work/app", notes);
 * console.log(`${String(current.agents)} agents`);
 * ```
 */
export function countProjectCaps(
  root: string,
  undetermined?: string[],
): CapCounts {
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
    scripts: countPackageScripts(root, undetermined),
  };
}

/**
 * Counts every capped artifact category at `templateRoot`
 * (`templates/core`). The `skills` count adds 1 for the `/customize` skill,
 * which ships via the plugin copy rather than as a `templates/core` file --
 * see `plugin.ts`.
 */
export function countBaselineCaps(templateRoot: string): CapCounts {
  const raw = countProjectCaps(templateRoot);
  return { ...raw, skills: raw.skills + 1 };
}

/**
 * Counts every capped artifact category under a pack's `files/` root --
 * the same shape as {@link countBaselineCaps} but without the `/customize`
 * adjustment, since a pack never ships that skill. Used to verify a pack's
 * declared `budget` matches what its own file tree actually contains.
 * `packageScripts` is the pack's `wiring.packageScripts`, added to the
 * `scripts` count -- those are merged into the target's real `package.json`
 * at install time, never shipped as a file, so the tree walk can't see them.
 */
export function countPackBudget(
  packFilesDir: string,
  packageScripts?: Record<string, string>,
): CapCounts {
  const raw = countProjectCaps(packFilesDir);
  return {
    ...raw,
    scripts: raw.scripts + Object.keys(packageScripts ?? {}).length,
  };
}

function formatCounts(counts: CapCounts): string {
  return `${counts.agents} agents, ${counts.skills} skills, ${counts.hooks} hooks, ${counts.workflows} workflows, ${counts.scripts} scripts`;
}

/**
 * The result of {@link formatCapsSummary}: the rendered summary text plus an
 * explicit over-cap flag, so a caller never has to string-match the text to
 * decide how to present it.
 *
 * @example
 * ```ts
 * const summary: CapsSummary = { text: "= 5 agents, ...", overCap: false };
 * console.log(summary.overCap ? `warning: ${summary.text}` : summary.text);
 * ```
 */
export interface CapsSummary {
  /** The summary line(s), newline-joined, exactly as printed. */
  readonly text: string;
  /** `true` when the baseline plus installed packs exceeds any cap in `CAP_LIMITS`. */
  readonly overCap: boolean;
}

/**
 * The post-`--pack`-install caps summary line(s) printed to fresh-mode's
 * console output, plus whether any cap is exceeded. `label` starts the first
 * line (colon included); it defaults to `templates/core:`, and `--add-pack`
 * passes `project:` for a project's current counts.
 *
 * @example
 * ```ts
 * const summary = formatCapsSummary(baselineCounts, [
 *   { name: "harness-extras", budget: packBudget },
 * ]);
 * console.log(summary.text);
 * ```
 */
export function formatCapsSummary(
  baseline: CapCounts,
  installed: { name: string; budget: CapCounts }[],
  label = "templates/core:",
): CapsSummary {
  const total: CapCounts = { ...baseline };
  const lines = [
    `${label} ${formatCounts(baseline)} (caps: ${formatCounts(CAP_LIMITS)})`,
  ];

  for (const { name, budget } of installed) {
    lines.push(`+ ${name}: ${formatCounts(budget)}`);
    for (const key of CAP_KEYS) total[key] += budget[key];
  }

  const overCap = CAP_KEYS.filter((key) => total[key] > CAP_LIMITS[key]);

  lines.push(
    `= ${formatCounts(total)}${overCap.length > 0 ? ` ⚠ over cap: ${overCap.join(", ")}` : ""}`,
  );
  return { text: lines.join("\n"), overCap: overCap.length > 0 };
}
