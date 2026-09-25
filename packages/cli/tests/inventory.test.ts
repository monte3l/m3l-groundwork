// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInventory,
  resolveCliVersion,
  writeInventory,
  INVENTORY_SCHEMA_VERSION,
} from "../src/inventory.js";
import type { Inventory } from "../src/inventory.js";
import type { HarnessGrade } from "../src/harness/types.js";
import type { ToolchainGrade } from "../src/toolchain/types.js";
import type { ProjectSurvey } from "../src/survey/survey.js";

const EMPTY_TALLY = { checked: 0, failed: 0 };
const EMPTY_GRADE: HarnessGrade = {
  findings: [],
  structural: EMPTY_TALLY,
  rubric: {
    settings: EMPTY_TALLY,
    hooks: EMPTY_TALLY,
    skills: EMPTY_TALLY,
    agents: EMPTY_TALLY,
    rules: EMPTY_TALLY,
    "claude-md": EMPTY_TALLY,
  },
  rubricScore: 1,
};

const EMPTY_TOOLCHAIN_GRADE: ToolchainGrade = {
  findings: [],
  structural: EMPTY_TALLY,
  rubric: {
    tsconfig: EMPTY_TALLY,
    modules: EMPTY_TALLY,
    eslint: EMPTY_TALLY,
    testing: EMPTY_TALLY,
    gates: EMPTY_TALLY,
    deps: EMPTY_TALLY,
  },
  rubricScore: 1,
};

const EMPTY_SURVEY: ProjectSurvey = {
  shape: {
    packageManager: "unknown",
    monorepoTool: "none",
    workspaceGlobs: [],
    moduleType: "unspecified",
    typescriptVersion: undefined,
    nodeVersionPin: undefined,
    sourceLayout: "unknown",
    testPlacement: "unknown",
    kindEvidence: {
      hasExportsMap: false,
      hasBinField: false,
      hasMainField: false,
      frameworkDeps: [],
    },
  },
  toolchain: {
    tsconfig: { files: [], effectiveFlags: {}, parsed: false },
    eslint: { configFile: undefined, flat: false, referencedPlugins: [] },
    testRunner: { tool: "unknown", configFile: undefined },
    formatter: { tool: "unknown", configFile: undefined },
    gitHooks: { manager: "none", configFile: undefined, needsReading: false },
    workflows: { files: [], needsReading: false },
    scripts: {},
  },
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
  docs: { files: [] },
  undetermined: [],
};

describe("resolveCliVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-version-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a version string from this package's own package.json", () => {
    // Not a plain X.Y.Z: this project is in Changesets prerelease mode
    // (.changeset/pre.json), so the real version is X.Y.Z-next.N most of
    // the time -- CI #13 failed on exactly this assumption the first time
    // a real version bump landed.
    expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/);
  });

  it("reports unknown when the package.json doesn't exist", () => {
    expect(resolveCliVersion(join(dir, "missing.json"))).toBe("unknown");
  });

  it("reports unknown when the package.json fails to parse", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, "{not json");
    expect(resolveCliVersion(path)).toBe("unknown");
  });

  it("reports unknown when the version field isn't a string", () => {
    const path = join(dir, "package.json");
    writeFileSync(path, JSON.stringify({ version: 123 }));
    expect(resolveCliVersion(path)).toBe("unknown");
  });
});

describe("buildInventory / writeInventory", () => {
  let groundworkDir: string;

  beforeEach(() => {
    groundworkDir = mkdtempSync(join(tmpdir(), "inventory-"));
  });

  afterEach(() => {
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("builds an inventory carrying the schema version, mode signal, and survey", () => {
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
    });

    expect(inventory.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
    expect(inventory.modeSignal).toBe("found package.json");
    expect(inventory.templateRoot).toBe("/tmp/templates/core");
    expect(inventory.survey).toBe(EMPTY_SURVEY);
    expect(inventory.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries the harness grade verbatim and derives conformance from the conflict plan, counting only harness paths", () => {
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [
        { relPath: ".claude/settings.json", status: "identical", keyDiffs: [] },
        { relPath: ".claude/agents/a.md", status: "divergent", keyDiffs: [] },
        { relPath: "CLAUDE.md", status: "absent", keyDiffs: [] },
        { relPath: "tsconfig.json", status: "divergent", keyDiffs: [] },
      ],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
    });

    expect(inventory.harnessGrade).toBe(EMPTY_GRADE);
    expect(inventory.harnessConformance).toEqual({
      identical: 1,
      divergent: 1,
      absent: 1,
      divergentFiles: [".claude/agents/a.md"],
      absentFiles: ["CLAUDE.md"],
    });
  });

  it("carries the toolchain grade verbatim and derives its conformance from toolchain paths only", () => {
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [
        { relPath: ".claude/agents/a.md", status: "divergent", keyDiffs: [] },
        { relPath: "tsconfig.json", status: "divergent", keyDiffs: [] },
        { relPath: "eslint.config.js", status: "absent", keyDiffs: [] },
        { relPath: "package.json", status: "identical", keyDiffs: [] },
      ],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
    });

    expect(inventory.toolchainGrade).toBe(EMPTY_TOOLCHAIN_GRADE);
    expect(inventory.toolchainConformance).toEqual({
      identical: 1,
      divergent: 1,
      absent: 1,
      divergentFiles: ["tsconfig.json"],
      absentFiles: ["eslint.config.js"],
    });
  });

  it("writes inventory.json into the groundwork directory and returns its path", () => {
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
    });

    const path = writeInventory(inventory, join(groundworkDir, "nested"));

    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Inventory;
    expect(parsed.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
  });
});
