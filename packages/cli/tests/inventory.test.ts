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
import type { ProjectSurvey } from "../src/survey/survey.js";

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
    expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+$/);
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
    });

    expect(inventory.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
    expect(inventory.modeSignal).toBe("found package.json");
    expect(inventory.templateRoot).toBe("/tmp/templates/core");
    expect(inventory.survey).toBe(EMPTY_SURVEY);
    expect(inventory.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes inventory.json into the groundwork directory and returns its path", () => {
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
    });

    const path = writeInventory(inventory, join(groundworkDir, "nested"));

    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Inventory;
    expect(parsed.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
  });
});
