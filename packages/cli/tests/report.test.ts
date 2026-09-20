import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport } from "../src/report.js";
import type { Inventory } from "../src/inventory.js";
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
