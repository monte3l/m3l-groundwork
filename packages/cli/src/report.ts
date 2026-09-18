/**
 * Renders `.groundwork/adoption-report.md` from an `Inventory` -- the human
 * artifact adopt mode stops at. Every section is index-level, matching what
 * the survey actually collected: this module never infers, it only lays out
 * what was found so the user (and later `/customize`'s Step 0) can decide
 * what to do about it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Inventory } from "./inventory.js";

function countDirEntries(
  dir: string,
  filter?: (name: string) => boolean,
): number {
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir);
  return filter === undefined ? names.length : names.filter(filter).length;
}

interface CapCounts {
  agents: number;
  skills: number;
  hooks: number;
}

/** Counts baseline .claude/ artifacts at `templateRoot`, for the caps table. */
function countBaselineCaps(templateRoot: string): CapCounts {
  const claudeDir = join(templateRoot, ".claude");
  return {
    // +1 for the /customize skill, which ships via the plugin copy rather
    // than as a templates/core file -- see plugin.ts.
    agents: countDirEntries(join(claudeDir, "agents"), (n) =>
      n.endsWith(".md"),
    ),
    skills: countDirEntries(join(claudeDir, "skills")) + 1,
    hooks: countDirEntries(
      join(claudeDir, "hooks"),
      (n) => n.endsWith(".mjs") || n.endsWith(".js"),
    ),
  };
}

/**
 * Estimates the post-merge total against each cap: the baseline's own count
 * plus whatever the existing project already has, on the (approximate)
 * assumption nothing overlaps by name. This is a decision to surface, not a
 * precise reconciliation -- Step 0's confirmation round settles it for real.
 */
function estimatePostMergeCaps(inventory: Inventory): {
  baseline: CapCounts;
  postMerge: CapCounts;
} {
  const baseline = countBaselineCaps(inventory.templateRoot);
  const existing = inventory.survey.harness;
  return {
    baseline,
    postMerge: {
      agents: baseline.agents + existing.agents.length,
      skills: baseline.skills + existing.skills.length,
      hooks: baseline.hooks + existing.hooks.length,
    },
  };
}

function renderShapeSection(inventory: Inventory): string {
  const s = inventory.survey.shape;
  const lines = [
    "## Codebase shape",
    "",
    `- Package manager: ${s.packageManager}`,
    `- Monorepo tool: ${s.monorepoTool}${s.workspaceGlobs.length > 0 ? ` (${s.workspaceGlobs.join(", ")})` : ""}`,
    `- Module type: ${s.moduleType}`,
    `- TypeScript: ${s.typescriptVersion ?? "not declared"}`,
    `- Node pin: ${s.nodeVersionPin ? `${s.nodeVersionPin.value} (${s.nodeVersionPin.source})` : "none found"}`,
    `- Source layout: ${s.sourceLayout}`,
    `- Test placement: ${s.testPlacement}`,
    `- Kind evidence: exports map=${s.kindEvidence.hasExportsMap}, bin=${s.kindEvidence.hasBinField}, main=${s.kindEvidence.hasMainField}, framework deps=${s.kindEvidence.frameworkDeps.join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

function renderToolchainSection(inventory: Inventory): string {
  const t = inventory.survey.toolchain;
  const lines = [
    "## Toolchain enforcement in effect",
    "",
    `- tsconfig chain: ${t.tsconfig.files.length > 0 ? t.tsconfig.files.join(" -> ") : "none found"}`,
    `- Effective strict flags: ${Object.keys(t.tsconfig.effectiveFlags).length > 0 ? JSON.stringify(t.tsconfig.effectiveFlags) : "none set"}`,
    `- ESLint: ${t.eslint.configFile ? `${t.eslint.configFile} (${t.eslint.flat ? "flat" : "legacy"} config)` : "not found"}`,
    `- Test runner: ${t.testRunner.tool}${t.testRunner.configFile ? ` (${t.testRunner.configFile})` : ""}`,
    `- Formatter: ${t.formatter.tool}${t.formatter.configFile ? ` (${t.formatter.configFile})` : ""}`,
    `- Git hooks: ${t.gitHooks.manager}${t.gitHooks.configFile ? ` (${t.gitHooks.configFile})` : ""}`,
    `- CI workflows: ${t.workflows.files.length > 0 ? t.workflows.files.join(", ") : "none found"}`,
    `- package.json scripts: ${Object.keys(t.scripts).length > 0 ? Object.keys(t.scripts).join(", ") : "none"}`,
  ];
  return lines.join("\n");
}

function renderHarnessSection(inventory: Inventory): string {
  const h = inventory.survey.harness;
  if (!h.present) {
    return [
      "## Existing Claude Code harness",
      "",
      "No `.claude/` directory found -- the baseline harness would be entirely new.",
    ].join("\n");
  }
  const lines = [
    "## Existing Claude Code harness",
    "",
    `- Agents: ${h.agents.length > 0 ? h.agents.map((a) => a.name).join(", ") : "none"}`,
    `- Skills: ${h.skills.length > 0 ? h.skills.map((s) => s.name).join(", ") : "none"}`,
    `- Hooks: ${h.hooks.length > 0 ? h.hooks.join(", ") : "none"}`,
    `- Rules: ${h.rules.length > 0 ? h.rules.map((r) => r.name).join(", ") : "none"}`,
    `- Commands: ${h.commands.length > 0 ? h.commands.join(", ") : "none"}`,
    `- settings.local.json present: ${h.hasSettingsLocal}`,
  ];
  return lines.join("\n");
}

function renderDocsSection(inventory: Inventory): string {
  const files = inventory.survey.docs.files;
  const lines = ["## Human-facing docs & guidelines", ""];
  if (files.length === 0) {
    lines.push(
      "No CONTRIBUTING.md, docs/contributing, ADR directory, or style guide found.",
    );
  } else {
    for (const file of files) {
      lines.push(
        `- ${file.path}${file.headings.length > 0 ? ` -- ${file.headings.join(" / ")}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function renderCapsSection(inventory: Inventory): string {
  const { baseline, postMerge } = estimatePostMergeCaps(inventory);
  const overCap = (count: number, cap: number): string =>
    count > cap ? " ⚠ over cap" : "";
  return [
    "## Baseline caps after a merge (approximate)",
    "",
    "| Artifact | Baseline | Existing project | Post-merge (approx.) | Cap |",
    "| --- | --- | --- | --- | --- |",
    `| Agents | ${baseline.agents} | ${inventory.survey.harness.agents.length} | ${postMerge.agents}${overCap(postMerge.agents, 5)} | 5 |`,
    `| Skills | ${baseline.skills} | ${inventory.survey.harness.skills.length} | ${postMerge.skills}${overCap(postMerge.skills, 8)} | 8 |`,
    `| Hooks | ${baseline.hooks} | ${inventory.survey.harness.hooks.length} | ${postMerge.hooks}${overCap(postMerge.hooks, 10)} | 10 |`,
    "",
    "This is an approximate count assuming no name overlap; `/customize`'s Step 0 resolves it for real.",
  ].join("\n");
}

function renderConflictsSection(inventory: Inventory): string {
  const { conflicts } = inventory;
  const absent = conflicts.filter((c) => c.status === "absent");
  const identical = conflicts.filter((c) => c.status === "identical");
  const divergent = conflicts.filter((c) => c.status === "divergent");

  const lines = [
    "## What groundwork would change",
    "",
    `- ${absent.length} file(s) would be added cleanly (no collision).`,
    `- ${identical.length} file(s) already match the baseline.`,
    `- ${divergent.length} file(s) conflict and need a decision.`,
    "",
  ];

  if (divergent.length > 0) {
    lines.push("| File | Differing keys |", "| --- | --- |");
    for (const conflict of divergent) {
      lines.push(
        `| ${conflict.relPath} | ${conflict.keyDiffs?.join(", ") ?? "(whole file)"} |`,
      );
    }
  } else {
    lines.push("No conflicts found.");
  }

  return lines.join("\n");
}

function renderUndeterminedSection(inventory: Inventory): string {
  const lines = ["## Could not be determined", ""];
  if (inventory.survey.undetermined.length === 0) {
    lines.push("Nothing -- every file the survey looked at parsed cleanly.");
  } else {
    for (const entry of inventory.survey.undetermined) {
      lines.push(`- ${entry}`);
    }
  }
  return lines.join("\n");
}

/** Renders the full adoption report as Markdown. */
export function renderReport(inventory: Inventory): string {
  const sections = [
    "# Adoption report",
    "",
    `Generated ${inventory.generatedAt} by m3l-groundwork ${inventory.cliVersion}.`,
    "",
    `**Mode:** adopt -- ${inventory.modeSignal}`,
    "",
    renderShapeSection(inventory),
    "",
    renderToolchainSection(inventory),
    "",
    renderHarnessSection(inventory),
    "",
    renderDocsSection(inventory),
    "",
    renderCapsSection(inventory),
    "",
    renderConflictsSection(inventory),
    "",
    renderUndeterminedSection(inventory),
    "",
    "## Next step",
    "",
    "Open this project in Claude Code and run `/customize`. It reads this " +
      "report and `.groundwork/inventory.json`, does a deeper read of " +
      "anything above marked as needing one, and asks you to confirm before " +
      "changing anything. Did this report miss something about your " +
      "project? Say so when `/customize` asks -- that confirmation round " +
      "is the point where it's caught.",
    "",
    "`.groundwork/` itself was not added to this project's `.gitignore` -- " +
      "that choice is yours. It's disposable (regenerate it any time by " +
      "re-running the CLI), so most projects gitignore it; some prefer to " +
      "commit it as a record of what the adoption found.",
    "",
  ];
  return sections.join("\n");
}
