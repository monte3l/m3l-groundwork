// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport } from "../src/report.js";
import { CAP_LIMITS } from "../src/caps.js";
import type { Inventory } from "../src/inventory.js";
import type { HarnessGrade } from "../src/harness/types.js";
import type { ToolchainGrade } from "../src/toolchain/types.js";
import type { ProjectSurvey } from "../src/survey/survey.js";

function baseSurvey(overrides: Partial<ProjectSurvey> = {}): ProjectSurvey {
  return {
    shape: {
      packageManager: "pnpm",
      monorepoTool: "none",
      workspaceGlobs: [],
      moduleType: "module",
      typescriptVersion: "^5.4.0",
      nodeVersionPin: { source: ".node-version", value: "20" },
      sourceLayout: "src",
      testPlacement: "colocated",
      kindEvidence: {
        hasExportsMap: true,
        hasBinField: false,
        hasMainField: false,
        frameworkDeps: [],
      },
    },
    toolchain: {
      tsconfig: {
        files: ["tsconfig.json"],
        effectiveFlags: { strict: false },
        parsed: true,
      },
      eslint: {
        configFile: ".eslintrc.cjs",
        flat: false,
        referencedPlugins: [],
      },
      testRunner: { tool: "jest", configFile: "jest.config.js" },
      formatter: { tool: "unknown", configFile: undefined },
      gitHooks: { manager: "husky", configFile: ".husky", needsReading: true },
      workflows: { files: ["ci.yml"], needsReading: true },
      scripts: { build: "tsc", test: "jest" },
    },
    harness: {
      present: true,
      settingsFile: "settings.json",
      agents: [{ name: "reviewer", model: "sonnet" }],
      skills: [{ name: "my-skill", description: "does a thing" }],
      hooks: ["guard-foo.mjs"],
      rules: [],
      commands: [],
      hasSettingsLocal: false,
      hasClaudeMd: true,
      claudeMdHeadings: ["Title"],
    },
    docs: {
      files: [
        {
          path: "/proj/CONTRIBUTING.md",
          sizeBytes: 100,
          headings: ["Contributing"],
        },
      ],
    },
    undetermined: [],
    ...overrides,
  };
}

const TALLY = { checked: 0, failed: 0 };
const CLEAN_GRADE: HarnessGrade = {
  findings: [],
  structural: { checked: 12, failed: 0 },
  rubric: {
    settings: TALLY,
    hooks: { checked: 4, failed: 0 },
    skills: TALLY,
    agents: TALLY,
    rules: TALLY,
    "claude-md": TALLY,
  },
  rubricScore: 1,
};

const CLEAN_TOOLCHAIN_GRADE: ToolchainGrade = {
  findings: [],
  structural: { checked: 9, failed: 0 },
  rubric: {
    tsconfig: { checked: 12, failed: 0 },
    modules: TALLY,
    eslint: TALLY,
    testing: TALLY,
    gates: TALLY,
    deps: TALLY,
  },
  rubricScore: 1,
};

const NO_CONFORMANCE = {
  identical: 0,
  divergent: 0,
  absent: 0,
  divergentFiles: [],
  absentFiles: [],
};

function baseInventory(
  templateRoot: string,
  overrides: Partial<Inventory> = {},
): Inventory {
  return {
    schemaVersion: 1,
    cliVersion: "0.1.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    modeSignal: "found package.json",
    templateRoot,
    targetDir: "/proj",
    survey: baseSurvey(),
    conflicts: [],
    packs: [],
    harnessGrade: CLEAN_GRADE,
    harnessConformance: NO_CONFORMANCE,
    toolchainGrade: CLEAN_TOOLCHAIN_GRADE,
    toolchainConformance: NO_CONFORMANCE,
    ...overrides,
  };
}

function basePackSurvey(
  overrides: Partial<Inventory["packs"][number]> = {},
): Inventory["packs"][number] {
  return {
    name: "harness-extras",
    modes: ["fresh", "adopt"],
    budget: { agents: 1, skills: 0, hooks: 3, workflows: 0, scripts: 0 },
    fileConflicts: [],
    wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
    wiringObservations: ["no .claude/settings.json found"],
    adoptNotes: "some note about a gate dependency",
    ...overrides,
  };
}

describe("renderReport", () => {
  let templateRoot: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "report-template-"));
    mkdirSync(join(templateRoot, ".claude", "agents"), { recursive: true });
    mkdirSync(join(templateRoot, ".claude", "skills"), { recursive: true });
    mkdirSync(join(templateRoot, ".claude", "hooks"), { recursive: true });
    for (const name of [
      "Explore",
      "test-author",
      "code-implementer",
      "code-reviewer",
      "silent-failure-hunter",
    ]) {
      writeFileSync(join(templateRoot, ".claude", "agents", `${name}.md`), "");
    }
    for (const name of [
      "starting-work",
      "writing-commits",
      "creating-prs",
      "finishing-work",
      "triaging-ci",
      "typescript-guidance",
      "harness-guidance",
    ]) {
      mkdirSync(join(templateRoot, ".claude", "skills", name));
    }
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        join(templateRoot, ".claude", "hooks", `hook-${i}.mjs`),
        "",
      );
    }
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
  });

  it("renders every section with real content", () => {
    const report = renderReport(baseInventory(templateRoot));

    expect(report).toContain("# Adoption report");
    expect(report).toContain("**Mode:** adopt -- found package.json");
    expect(report).toContain("## Codebase shape");
    expect(report).toContain("Package manager: pnpm");
    expect(report).toContain("## Toolchain enforcement in effect");
    expect(report).toContain("jest.config.js");
    expect(report).toContain("## Existing Claude Code harness");
    expect(report).toContain("reviewer");
    expect(report).toContain("## Harness grade");
    expect(report).toContain("## Human-facing docs & guidelines");
    expect(report).toContain("CONTRIBUTING.md");
    expect(report).toContain("## Baseline caps after a merge (approximate)");
    expect(report).toContain("## What groundwork would change");
    expect(report).toContain("## Could not be determined");
    expect(report).toContain("## Next step");
    expect(report).toContain("/customize");
  });

  it("reports no harness found when .claude/ is absent", () => {
    const survey = baseSurvey({
      harness: {
        present: false,
        settingsFile: undefined,
        agents: [],
        skills: [],
        hooks: [],
        rules: [],
        commands: [],
        hasSettingsLocal: false,
        hasClaudeMd: false,
        claudeMdHeadings: [],
      },
    });
    const report = renderReport(baseInventory(templateRoot, { survey }));
    expect(report).toContain("No `.claude/` directory found");
  });

  it("renders the harness grade as three separate measurements, with findings split by level", () => {
    const grade: HarnessGrade = {
      ...CLEAN_GRADE,
      structural: { checked: 12, failed: 1 },
      rubric: { ...CLEAN_GRADE.rubric, hooks: { checked: 4, failed: 1 } },
      rubricScore: 0.75,
      findings: [
        {
          ruleId: "hook-dangling",
          level: "structural",
          category: "hooks",
          subject: ".claude/hooks/gone.mjs",
          message: "is named by a hook registration but does not exist on disk",
        },
        {
          ruleId: "hook-timeout",
          level: "rubric",
          category: "hooks",
          subject: "PreToolUse hook",
          message: "has no `timeout`",
        },
      ],
    };
    const report = renderReport(
      baseInventory(templateRoot, {
        harnessGrade: grade,
        harnessConformance: {
          identical: 3,
          divergent: 1,
          absent: 2,
          divergentFiles: [".claude/agents/reviewer.md"],
          absentFiles: [],
        },
      }),
    );

    expect(report).toContain("**Wiring (structural):** 11 of 12 checks pass.");
    expect(report).toContain("**Quality (rubric):** 75% over 4 checks");
    expect(report).toContain(
      "3 identical, 1 divergent, 2 absent. Informational only",
    );
    const wiring = report.split("### Wiring findings")[1] ?? "";
    expect(wiring.split("### Quality findings")[0]).toContain(
      "- [hook-dangling] .claude/hooks/gone.mjs",
    );
    expect(report.split("### Quality findings (advisory)")[1]).toContain(
      "- [hook-timeout] PreToolUse hook",
    );
    expect(report).toContain("- .claude/agents/reviewer.md");
  });

  it("renders the toolchain grade as three separate measurements, with findings split by level", () => {
    const grade: ToolchainGrade = {
      ...CLEAN_TOOLCHAIN_GRADE,
      structural: { checked: 9, failed: 1 },
      rubric: {
        ...CLEAN_TOOLCHAIN_GRADE.rubric,
        tsconfig: { checked: 12, failed: 3 },
      },
      rubricScore: 0.75,
      findings: [
        {
          ruleId: "tsconfig-emit-coherence",
          level: "structural",
          category: "tsconfig",
          subject: "tsconfig.build.json",
          message: "is compiled by the `build` script but sets no outDir",
        },
        {
          ruleId: "strict-flags",
          level: "rubric",
          category: "tsconfig",
          subject: "tsconfig.json",
          message: "noUncheckedIndexedAccess is not set (want true)",
        },
      ],
    };
    const report = renderReport(
      baseInventory(templateRoot, {
        toolchainGrade: grade,
        toolchainConformance: {
          identical: 4,
          divergent: 2,
          absent: 1,
          divergentFiles: ["tsconfig.base.json"],
          absentFiles: ["vitest.config.ts"],
        },
      }),
    );
    const section =
      report
        .split("## Toolchain grade")[1]
        ?.split("## Existing Claude Code")[0] ?? "";

    expect(section).toContain("**Wiring (structural):** 8 of 9 checks pass.");
    expect(section).toContain("**Quality (rubric):** 75% over 12 checks");
    expect(section).toContain(
      "4 identical, 2 divergent, 1 absent. Informational only",
    );
    expect(
      section
        .split("### Toolchain wiring findings")[1]
        ?.split("### Toolchain quality")[0],
    ).toContain("- [tsconfig-emit-coherence] tsconfig.build.json");
    expect(
      section.split("### Toolchain quality findings (advisory)")[1],
    ).toContain(
      "- [strict-flags] tsconfig.json -- noUncheckedIndexedAccess is not set",
    );
  });

  it("says None under both toolchain headings for a clean toolchain grade", () => {
    const report = renderReport(baseInventory(templateRoot));
    const section =
      report
        .split("## Toolchain grade")[1]
        ?.split("## Existing Claude Code")[0] ?? "";
    expect(section).toContain("### Toolchain wiring findings\n\nNone.");
    expect(section).toContain(
      "### Toolchain quality findings (advisory)\n\nNone.",
    );
  });

  it("says there is nothing to grade when no toolchain file was found", () => {
    const empty = { checked: 0, failed: 0 };
    const report = renderReport(
      baseInventory(templateRoot, {
        toolchainGrade: {
          findings: [],
          structural: empty,
          rubric: {
            tsconfig: empty,
            modules: empty,
            eslint: empty,
            testing: empty,
            gates: empty,
            deps: empty,
          },
          rubricScore: 1,
        },
      }),
    );
    expect(report).toContain("nothing to grade.");
    expect(report).not.toContain("### Toolchain wiring findings");
  });

  it("says None under each findings heading for a clean grade", () => {
    const report = renderReport(baseInventory(templateRoot));
    const grade = report
      .split("## Harness grade")[1]
      ?.split("## Human-facing")[0];
    expect(grade).toContain("### Wiring findings\n\nNone.");
    expect(grade).toContain("### Quality findings (advisory)\n\nNone.");
  });

  it("has nothing to grade when there is neither a .claude/ directory nor a CLAUDE.md", () => {
    const survey = baseSurvey({
      harness: {
        present: false,
        settingsFile: undefined,
        agents: [],
        skills: [],
        hooks: [],
        rules: [],
        commands: [],
        hasSettingsLocal: false,
        hasClaudeMd: false,
        claudeMdHeadings: [],
      },
    });
    const report = renderReport(baseInventory(templateRoot, { survey }));
    expect(report).toContain("nothing to grade");
  });

  it("reports no docs found when the docs survey is empty", () => {
    const survey = baseSurvey({ docs: { files: [] } });
    const report = renderReport(baseInventory(templateRoot, { survey }));
    expect(report).toContain("No CONTRIBUTING.md");
  });

  it("flags a cap that would be exceeded post-merge", () => {
    const survey = baseSurvey({
      harness: {
        present: true,
        settingsFile: "settings.json",
        agents: Array.from({ length: 6 }, (_, i) => ({
          name: `agent-${i}`,
          model: undefined,
        })),
        skills: [],
        hooks: [],
        rules: [],
        commands: [],
        hasSettingsLocal: false,
        hasClaudeMd: false,
        claudeMdHeadings: [],
      },
    });
    const report = renderReport(baseInventory(templateRoot, { survey }));
    expect(report).toContain("⚠ over cap");
  });

  it("lists divergent conflicts in a table with their differing keys", () => {
    const report = renderReport(
      baseInventory(templateRoot, {
        conflicts: [
          {
            relPath: "package.json",
            status: "divergent",
            keyDiffs: ["type", "scripts"],
          },
          { relPath: "README.md", status: "absent", keyDiffs: undefined },
          { relPath: "tsconfig.json", status: "identical", keyDiffs: [] },
        ],
      }),
    );
    expect(report).toContain("| package.json | type, scripts |");
    expect(report).toContain("1 file(s) would be added cleanly");
    expect(report).toContain("1 file(s) already match");
    expect(report).toContain("1 file(s) conflict");
  });

  it("reports no conflicts when the conflict list has nothing divergent", () => {
    const report = renderReport(baseInventory(templateRoot, { conflicts: [] }));
    expect(report).toContain("No conflicts found.");
  });

  it("never leaves the could-not-determine section empty when undetermined entries exist", () => {
    const survey = baseSurvey({
      undetermined: ["could not parse lefthook.yml"],
    });
    const report = renderReport(baseInventory(templateRoot, { survey }));
    expect(report).toContain("could not parse lefthook.yml");
    expect(report).not.toContain("Nothing -- every file");
  });

  it("says nothing was undetermined when the list is empty", () => {
    const report = renderReport(baseInventory(templateRoot));
    expect(report).toContain(
      "Nothing -- every file the survey looked at parsed cleanly.",
    );
  });

  it("reports no packs found when templates/packs has nothing", () => {
    const report = renderReport(baseInventory(templateRoot));
    expect(report).toContain("## Available packs");
    expect(report).toContain("No packs found under `templates/packs/`.");
    // No packs -- the caps table stays at its original column count.
    expect(report).not.toContain("+ all packs");
  });

  it("lists a pack's budget, wiring observations, and adopt notes", () => {
    const report = renderReport(
      baseInventory(templateRoot, { packs: [basePackSurvey()] }),
    );
    expect(report).toContain("### harness-extras");
    expect(report).toContain("Modes: fresh, adopt");
    expect(report).toContain(
      "Budget: 1 agent(s), 0 skill(s), 3 hook(s), 0 workflow(s), 0 script(s)",
    );
    expect(report).toContain("no .claude/settings.json found");
    expect(report).toContain("Adopt notes: some note about a gate dependency");
  });

  it("adds a + all packs column to the caps table when any pack is listed", () => {
    const report = renderReport(
      baseInventory(templateRoot, { packs: [basePackSurvey()] }),
    );
    expect(report).toContain("+ all packs");
    expect(report).toContain('"+ all packs" sums every pack listed below');
  });

  it("includes both the CLI version and the inventory schema version in the header", () => {
    // schemaVersion 7 is distinct from any digit in cliVersion ("0.1.0") or
    // generatedAt's year, so a match on "7" in the header can only come from
    // schemaVersion being rendered.
    const report = renderReport(
      baseInventory(templateRoot, { schemaVersion: 7 }),
    );
    const header = report.split("\n").slice(0, 5).join("\n");
    expect(header).toContain("0.1.0");
    expect(header).toMatch(/schema[^\n]*7/i);
  });

  it("renders a Workflows row in the caps table, over cap once a pack's declared budget is accounted for", () => {
    // Baseline sits exactly at the workflows cap; the existing project's own
    // survey has none. Without adding the pack's declared budget into the
    // displayed post-merge total, this would show "at cap, not over" -- the
    // exact gap this test proves.
    mkdirSync(join(templateRoot, ".github", "workflows"), {
      recursive: true,
    });
    for (let i = 0; i < CAP_LIMITS.workflows; i++) {
      writeFileSync(
        join(templateRoot, ".github", "workflows", `wf-${i}.yml`),
        "",
      );
    }
    const survey = baseSurvey();
    const surveyWithNoExistingWorkflows = {
      ...survey,
      toolchain: {
        ...survey.toolchain,
        workflows: { files: [], needsReading: true },
      },
    };
    const report = renderReport(
      baseInventory(templateRoot, {
        survey: surveyWithNoExistingWorkflows,
        packs: [
          basePackSurvey({
            budget: {
              agents: 0,
              skills: 0,
              hooks: 0,
              workflows: 1,
              scripts: 0,
            },
          }),
        ],
      }),
    );

    const workflowsRow = report
      .split("\n")
      .find((line) => line.startsWith("| Workflows |"));
    expect(workflowsRow).toBeDefined();
    expect(workflowsRow).toContain("⚠ over cap");
  });

  it("renders a Scripts row in the caps table", () => {
    const report = renderReport(baseInventory(templateRoot));
    const scriptsRow = report
      .split("\n")
      .find((line) => line.startsWith("| Scripts |"));
    expect(scriptsRow).toBeDefined();
  });

  it("lists a pack's own divergent file conflicts in a table", () => {
    const report = renderReport(
      baseInventory(templateRoot, {
        packs: [
          basePackSurvey({
            fileConflicts: [
              {
                relPath: "bin/file-budget-baseline.json",
                status: "divergent",
                keyDiffs: undefined,
              },
            ],
          }),
        ],
      }),
    );
    expect(report).toContain(
      "| bin/file-budget-baseline.json | (whole file) |",
    );
  });
});
