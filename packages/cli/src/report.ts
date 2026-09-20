/**
 * Renders `.groundwork/adoption-report.md` from an `Inventory` -- the human
 * artifact adopt mode stops at. Every section is index-level, matching what
 * the survey actually collected: this module never infers, it only lays out
 * what was found so the user (and later `/customize`'s Step 0) can decide
 * what to do about it.
 */
import type { CapCounts } from "./caps.js";
import { CAP_LIMITS, countBaselineCaps } from "./caps.js";
import type { Inventory, PackSurvey } from "./inventory.js";

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
  const workflowsExisting = inventory.survey.toolchain.workflows.files.length;
  const scriptsExisting = Object.keys(
    inventory.survey.toolchain.scripts,
  ).length;
  return {
    baseline,
    postMerge: {
      agents: baseline.agents + existing.agents.length,
      skills: baseline.skills + existing.skills.length,
      hooks: baseline.hooks + existing.hooks.length,
      workflows: baseline.workflows + workflowsExisting,
      scripts: baseline.scripts + scriptsExisting,
    },
  };
}

/** Sums every listed pack's declared `budget` -- the "if every pack were installed" delta, not just the ones a user will choose. */
function sumPackBudgets(packs: PackSurvey[]): CapCounts {
  const total: CapCounts = {
    agents: 0,
    skills: 0,
    hooks: 0,
    workflows: 0,
    scripts: 0,
  };
  for (const pack of packs) {
    total.agents += pack.budget.agents;
    total.skills += pack.budget.skills;
    total.hooks += pack.budget.hooks;
    total.workflows += pack.budget.workflows;
    total.scripts += pack.budget.scripts;
  }
  return total;
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

/** The toolchain grade: wiring integrity, rubric quality, and drift from the baseline -- three separate measurements. */
function renderToolchainGradeSection(inventory: Inventory): string {
  const { toolchainGrade: grade, toolchainConformance: conformance } =
    inventory;
  const lines = ["## Toolchain grade", ""];

  const rubricChecked = Object.values(grade.rubric).reduce(
    (sum, tally) => sum + tally.checked,
    0,
  );
  if (grade.structural.checked === 0 && rubricChecked === 0) {
    lines.push(
      "No TypeScript toolchain files (tsconfig, ESLint or vitest config, verify steps) found -- nothing to grade.",
    );
    return lines.join("\n");
  }

  lines.push(
    `- **Wiring (structural):** ${grade.structural.checked - grade.structural.failed} of ${grade.structural.checked} checks pass.`,
    `- **Quality (rubric):** ${Math.round(grade.rubricScore * 100)}% over ${rubricChecked} checks -- advisory, never a blocker.`,
    `- **Drift from the baseline toolchain:** ${conformance.identical} identical, ${conformance.divergent} divergent, ${conformance.absent} absent. ` +
      "Informational only -- `/customize` rewrites the baseline on purpose, so divergence is not a defect.",
  );

  const structural = grade.findings.filter((f) => f.level === "structural");
  const rubric = grade.findings.filter((f) => f.level === "rubric");

  lines.push("", "### Toolchain wiring findings", "");
  if (structural.length === 0) {
    lines.push("None.");
  } else {
    for (const finding of structural) {
      lines.push(
        `- [${finding.ruleId}] ${finding.subject} -- ${finding.message}`,
      );
    }
  }

  lines.push("", "### Toolchain quality findings (advisory)", "");
  if (rubric.length === 0) {
    lines.push("None.");
  } else {
    for (const finding of rubric) {
      lines.push(
        `- [${finding.ruleId}] ${finding.subject} -- ${finding.message}`,
      );
    }
  }
  return lines.join("\n");
}

/** The harness grade: wiring integrity, rubric quality, and drift from the baseline -- three separate measurements. */
function renderHarnessGradeSection(inventory: Inventory): string {
  const { harnessGrade: grade, harnessConformance: conformance } = inventory;
  const harness = inventory.survey.harness;
  const lines = ["## Harness grade", ""];

  if (!harness.present && !harness.hasClaudeMd) {
    lines.push(
      "No `.claude/` directory or `CLAUDE.md` found -- nothing to grade.",
    );
    return lines.join("\n");
  }

  const rubricChecked = Object.values(grade.rubric).reduce(
    (sum, tally) => sum + tally.checked,
    0,
  );
  lines.push(
    `- **Wiring (structural):** ${grade.structural.checked - grade.structural.failed} of ${grade.structural.checked} checks pass.`,
    `- **Quality (rubric):** ${Math.round(grade.rubricScore * 100)}% over ${rubricChecked} checks -- advisory, never a blocker.`,
    `- **Drift from the baseline harness:** ${conformance.identical} identical, ${conformance.divergent} divergent, ${conformance.absent} absent. ` +
      "Informational only -- `/customize` rewrites the baseline on purpose, so divergence is not a defect.",
  );

  const structural = grade.findings.filter((f) => f.level === "structural");
  const rubric = grade.findings.filter((f) => f.level === "rubric");

  lines.push("", "### Wiring findings", "");
  if (structural.length === 0) {
    lines.push("None.");
  } else {
    for (const finding of structural) {
      lines.push(
        `- [${finding.ruleId}] ${finding.subject} -- ${finding.message}`,
      );
    }
  }

  lines.push("", "### Quality findings (advisory)", "");
  if (rubric.length === 0) {
    lines.push("None.");
  } else {
    for (const finding of rubric) {
      lines.push(
        `- [${finding.ruleId}] ${finding.subject} -- ${finding.message}`,
      );
    }
  }

  if (harness.present && conformance.divergentFiles.length > 0) {
    lines.push(
      "",
      "### Baseline harness files this project has changed",
      "",
      ...conformance.divergentFiles.map((file) => `- ${file}`),
    );
  }
  return lines.join("\n");
}

function renderCapsSection(inventory: Inventory): string {
  const { baseline, postMerge } = estimatePostMergeCaps(inventory);
  const hasPacks = inventory.packs.length > 0;
  const packBudget = sumPackBudgets(inventory.packs);
  const overCap = (count: number, cap: number): string =>
    count > cap ? " ⚠ over cap" : "";

  const header = hasPacks
    ? "| Artifact | Baseline | Existing project | + all packs | Post-merge (approx.) | Cap |"
    : "| Artifact | Baseline | Existing project | Post-merge (approx.) | Cap |";
  const divider = hasPacks
    ? "| --- | --- | --- | --- | --- | --- |"
    : "| --- | --- | --- | --- | --- |";

  const row = (
    label: string,
    key: "agents" | "skills" | "hooks",
    existingCount: number,
    cap: number,
  ): string => {
    const cells = [label, String(baseline[key]), String(existingCount)];
    if (hasPacks) cells.push(`+${packBudget[key]}`);
    cells.push(`${postMerge[key]}${overCap(postMerge[key], cap)}`, String(cap));
    return `| ${cells.join(" | ")} |`;
  };

  const lines = [
    "## Baseline caps after a merge (approximate)",
    "",
    header,
    divider,
    row(
      "Agents",
      "agents",
      inventory.survey.harness.agents.length,
      CAP_LIMITS.agents,
    ),
    row(
      "Skills",
      "skills",
      inventory.survey.harness.skills.length,
      CAP_LIMITS.skills,
    ),
    row(
      "Hooks",
      "hooks",
      inventory.survey.harness.hooks.length,
      CAP_LIMITS.hooks,
    ),
    "",
    "This is an approximate count assuming no name overlap; `/customize`'s Step 0 resolves it for real.",
  ];
  if (hasPacks) {
    lines.push(
      "",
      '"+ all packs" sums every pack listed below, not just the ones you choose ' +
        'to install -- see "## Available packs" for per-pack numbers.',
    );
  }
  return lines.join("\n");
}

function renderConflictTable(conflicts: Inventory["conflicts"]): string[] {
  const divergent = conflicts.filter((c) => c.status === "divergent");
  if (divergent.length === 0) {
    return [];
  }
  const lines = ["", "| File | Differing keys |", "| --- | --- |"];
  for (const conflict of divergent) {
    lines.push(
      `| ${conflict.relPath} | ${conflict.keyDiffs?.join(", ") ?? "(whole file)"} |`,
    );
  }
  return lines;
}

function renderPacksSection(inventory: Inventory): string {
  const lines = ["## Available packs", ""];
  if (inventory.packs.length === 0) {
    lines.push("No packs found under `templates/packs/`.");
    return lines.join("\n");
  }

  for (const pack of inventory.packs) {
    const b = pack.budget;
    lines.push(
      `### ${pack.name}`,
      "",
      `- Modes: ${pack.modes.join(", ")}`,
      `- Budget: ${b.agents} agent(s), ${b.skills} skill(s), ${b.hooks} hook(s), ${b.workflows} workflow(s), ${b.scripts} script(s)`,
    );
    for (const observation of pack.wiringObservations) {
      lines.push(`- ${observation}`);
    }
    if (pack.adoptNotes !== undefined) {
      lines.push(`- Adopt notes: ${pack.adoptNotes}`);
    }
    lines.push(...renderConflictTable(pack.fileConflicts), "");
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
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
  ];

  if (divergent.length > 0) {
    lines.push(...renderConflictTable(conflicts));
  } else {
    lines.push("", "No conflicts found.");
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
    renderToolchainGradeSection(inventory),
    "",
    renderHarnessSection(inventory),
    "",
    renderHarnessGradeSection(inventory),
    "",
    renderDocsSection(inventory),
    "",
    renderCapsSection(inventory),
    "",
    renderPacksSection(inventory),
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
