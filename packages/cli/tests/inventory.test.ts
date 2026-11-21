// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInventory,
  resolveCliVersion,
  writeInventory,
  INVENTORY_SCHEMA_VERSION,
} from "../src/inventory.js";
import type {
  Inventory,
  PackSurvey,
  StagedBaseline,
} from "../src/inventory.js";
import { toPosixPath } from "../src/assets.js";
import type { StagedBaselineFile } from "../src/baseline-stage.js";
import type { StagedPack, StagedPackFile } from "../src/pack-stage.js";
import type { FileConflict } from "../src/conflicts.js";
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
    pluginLayout: null,
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

const EMPTY_STAGED_BASELINE: StagedBaseline = {
  dir: ".groundwork/baseline",
  suffix: ".staged",
  files: [],
};

function stagedBaselineFile(
  overrides: Partial<StagedBaselineFile> = {},
): StagedBaselineFile {
  return {
    path: "eslint.config.js",
    staged: "eslint.config.js.staged",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

describe("buildInventory / writeInventory", () => {
  let groundworkDir: string;

  beforeEach(() => {
    groundworkDir = mkdtempSync(join(tmpdir(), "inventory-"));
  });

  afterEach(() => {
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("bumps the schema version to 6 for HarnessSurvey.pluginLayout", () => {
    // Hardcoded rather than compared against the imported constant: this
    // pins the version bump itself, which a self-referencing comparison
    // against INVENTORY_SCHEMA_VERSION could never discriminate.
    expect(INVENTORY_SCHEMA_VERSION).toBe(6);
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
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks: [],
    });

    expect(inventory.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
    expect(inventory.modeSignal).toBe("found package.json");
    expect(inventory.templateRoot).toBe("/tmp/templates/core");
    expect(inventory.survey).toBe(EMPTY_SURVEY);
    expect(inventory.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries stagedBaseline through verbatim, including the per-file path/staged/sha256 shape", () => {
    const stagedBaseline: StagedBaseline = {
      dir: ".groundwork/baseline",
      suffix: ".staged",
      files: [
        stagedBaselineFile({
          path: "eslint.config.js",
          staged: "eslint.config.js.staged",
        }),
        stagedBaselineFile({
          path: "vitest.config.ts",
          staged: "vitest.config.ts.staged",
        }),
      ],
    };
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline,
      stagedPacks: [],
    });

    expect(inventory.stagedBaseline).toBe(stagedBaseline);
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
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks: [],
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
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks: [],
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
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks: [],
    });

    const path = writeInventory(inventory, join(groundworkDir, "nested"));

    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Inventory;
    expect(parsed.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
  });

  it("round-trips a non-empty stagedBaseline (dir/suffix/files) through JSON", () => {
    const stagedBaseline: StagedBaseline = {
      dir: ".groundwork/baseline",
      suffix: ".staged",
      files: [stagedBaselineFile()],
    };
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline,
      stagedPacks: [],
    });

    const path = writeInventory(inventory, join(groundworkDir, "roundtrip"));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Inventory;

    expect(parsed.stagedBaseline.dir).toBe(".groundwork/baseline");
    expect(parsed.stagedBaseline.suffix).toBe(".staged");
    expect(parsed.stagedBaseline.files).toEqual([stagedBaselineFile()]);
  });
});

describe("writeInventory writes atomically", () => {
  let groundworkDir: string;

  beforeEach(() => {
    groundworkDir = mkdtempSync(join(tmpdir(), "inventory-atomic-"));
  });

  afterEach(() => {
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("leaves no inventory.json.tmp behind and the final inventory.json parses, after a normal write", () => {
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks: [],
    });

    const path = writeInventory(inventory, groundworkDir);

    expect(existsSync(`${path}.tmp`)).toBe(false);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Inventory;
    expect(parsed.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
  });

  // The rename-failure case (the existing inventory.json must stay
  // untouched and no partial file survive) is covered in the isolated
  // packages/cli/tests/inventory-write-failure.test.ts, which mocks
  // node:fs's renameSync via vi.mock + vi.hoisted (vi.spyOn can't override
  // a named export of the real ESM node:fs module -- see that file's header
  // comment).
});

describe("writeInventory refuses to write through a pre-existing symlink at inventory.json.tmp", () => {
  let groundworkDir: string;
  let outsideDir: string;

  beforeEach(() => {
    groundworkDir = mkdtempSync(join(tmpdir(), "inventory-symlink-"));
    outsideDir = mkdtempSync(join(tmpdir(), "inventory-symlink-outside-"));
  });

  afterEach(() => {
    rmSync(groundworkDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("does not follow a pre-existing inventory.json.tmp symlink: the outside file stays byte-identical and inventory.json ends up a regular file", () => {
    const outsidePath = join(outsideDir, "sensitive.txt");
    writeFileSync(outsidePath, "do not touch\n");
    symlinkSync(outsidePath, join(groundworkDir, "inventory.json.tmp"));

    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks: [],
    });

    writeInventory(inventory, groundworkDir);

    // The symlink's target must be untouched -- writeInventory must not
    // follow a pre-existing inventory.json.tmp symlink when writing through
    // it.
    expect(readFileSync(outsidePath, "utf8")).toBe("do not touch\n");

    const finalPath = join(groundworkDir, "inventory.json");
    expect(lstatSync(finalPath).isSymbolicLink()).toBe(false);
    const parsed = JSON.parse(readFileSync(finalPath, "utf8")) as Inventory;
    expect(parsed.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
  });
});

function basePackSurvey(overrides: Partial<PackSurvey> = {}): PackSurvey {
  return {
    name: "harness-extras",
    modes: ["fresh", "adopt"],
    budget: { agents: 1, skills: 0, hooks: 3, workflows: 0, scripts: 0 },
    fileConflicts: [],
    wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
    wiringObservations: ["no .claude/settings.json found"],
    adoptNotes: undefined,
    ...overrides,
  };
}

describe("buildInventory normalizes backslash paths to forward slashes", () => {
  // Deliberately native-backslash relPaths (as a Windows run of planConflicts
  // would produce), covering a harness path, a toolchain path, and a plain
  // src path -- each prefix check in summarizeHarnessConformance /
  // summarizeToolchainConformance only matches a forward-slash-prefixed
  // string, so this is RED today: the prefix checks silently fail against
  // the raw backslash form and neither conformance summary counts these
  // paths at all.
  function nativeConflicts(): FileConflict[] {
    return [
      { relPath: "src\\index.ts", status: "divergent", keyDiffs: undefined },
      {
        relPath: ".claude\\agents\\x.md",
        status: "absent",
        keyDiffs: undefined,
      },
      {
        relPath: "bin\\lib\\verify-steps.mjs",
        status: "identical",
        keyDiffs: undefined,
      },
    ];
  }

  function buildWith(conflicts: FileConflict[], packs: PackSurvey[] = []) {
    return buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts,
      packs,
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks: [],
    });
  }

  it("normalizes every top-level conflicts[].relPath to forward slashes", () => {
    const inventory = buildWith(nativeConflicts());

    expect(inventory.conflicts.map((c) => c.relPath)).toEqual([
      "src/index.ts",
      ".claude/agents/x.md",
      "bin/lib/verify-steps.mjs",
    ]);
  });

  it("normalizes every packs[].fileConflicts[].relPath the same way", () => {
    const pack = basePackSurvey({ fileConflicts: nativeConflicts() });

    const inventory = buildWith([], [pack]);

    expect(inventory.packs[0]?.fileConflicts.map((c) => c.relPath)).toEqual([
      "src/index.ts",
      ".claude/agents/x.md",
      "bin/lib/verify-steps.mjs",
    ]);
  });

  it("feeds the normalized paths to the harness and toolchain conformance summaries, not the raw backslash form", () => {
    const inventory = buildWith(nativeConflicts());

    // .claude\agents\x.md is absent and a harness path only once normalized
    // to .claude/agents/x.md -- summarizeHarnessConformance's isHarnessPath
    // prefix check (`.claude/`) never matches the raw backslash string.
    expect(inventory.harnessConformance.absentFiles).toEqual([
      ".claude/agents/x.md",
    ]);
    expect(inventory.harnessConformance.absent).toBe(1);

    // bin\lib\verify-steps.mjs is identical and a toolchain path only once
    // normalized to bin/lib/verify-steps.mjs -- isToolchainPath's `bin/`
    // prefix check has the same failure mode on the raw backslash string.
    expect(inventory.toolchainConformance.identical).toBe(1);
  });

  it("does not mutate the conflicts array (or its FileConflict objects) the caller passed in", () => {
    const conflicts = nativeConflicts();
    const snapshot = conflicts.map((c) => ({ ...c }));

    buildWith(conflicts);

    expect(conflicts).toEqual(snapshot);
    // Explicit per-object check: main.ts reuses these exact objects for real
    // file operations afterwards, so the native backslash form must survive
    // identically, not just "look equal" via a deep-equal that could pass on
    // a coincidentally-reconstructed copy.
    expect(conflicts[0]?.relPath).toBe("src\\index.ts");
    expect(conflicts[1]?.relPath).toBe(".claude\\agents\\x.md");
    expect(conflicts[2]?.relPath).toBe("bin\\lib\\verify-steps.mjs");
  });

  it("normalizes conflicts[].relPath the same way stagedBaseline.files[].path is derived (toPosixPath), so the two sets of absent paths agree", () => {
    const conflicts = nativeConflicts();
    const absent = conflicts.filter((c) => c.status === "absent");
    const stagedBaseline: StagedBaseline = {
      dir: ".groundwork/baseline",
      suffix: ".staged",
      files: absent.map(({ relPath }): StagedBaselineFile => ({
        path: toPosixPath(relPath),
        staged: `${toPosixPath(relPath)}.staged`,
        sha256: "a".repeat(64),
      })),
    };

    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts,
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline,
      stagedPacks: [],
    });

    const inventoryAbsentPaths = new Set(
      inventory.conflicts
        .filter((c) => c.status === "absent")
        .map((c) => c.relPath),
    );
    const stagedPaths = new Set(
      inventory.stagedBaseline.files.map((f) => f.path),
    );

    expect(inventoryAbsentPaths).toEqual(stagedPaths);
  });
});

describe("StagedBaseline / StagedBaselineFile shapes", () => {
  it("types stagedBaseline as { dir, suffix, files: StagedBaselineFile[] }, each file carrying path/staged/sha256", () => {
    expectTypeOf<StagedBaseline>().toEqualTypeOf<{
      dir: string;
      suffix: string;
      files: StagedBaselineFile[];
    }>();
    expectTypeOf<StagedBaselineFile>().toEqualTypeOf<{
      path: string;
      staged: string;
      sha256: string;
    }>();
  });
});

function stagedPackFile(
  overrides: Partial<StagedPackFile> = {},
): StagedPackFile {
  return {
    path: ".claude/agents/a.md",
    staged: ".claude/agents/a.md.staged",
    sha256: "b".repeat(64),
    ...overrides,
  };
}

function stagedPack(overrides: Partial<StagedPack> = {}): StagedPack {
  return {
    name: "harness-extras",
    dir: ".groundwork/packs/harness-extras",
    suffix: ".staged",
    manifest: {
      path: "pack.json",
      staged: "pack.json.staged",
      sha256: "c".repeat(64),
    },
    files: [stagedPackFile()],
    ...overrides,
  };
}

describe("Inventory.stagedPacks", () => {
  let groundworkDir: string;

  beforeEach(() => {
    groundworkDir = mkdtempSync(join(tmpdir(), "inventory-staged-packs-"));
  });

  afterEach(() => {
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("stays schemaVersion 6 -- stagedPacks (added in 5) is additive within the same schema, not a further bump", () => {
    expect(INVENTORY_SCHEMA_VERSION).toBe(6);
  });

  it("carries stagedPacks through buildInventory verbatim, one entry per pack", () => {
    const stagedPacks: StagedPack[] = [
      stagedPack({ name: "harness-extras" }),
      stagedPack({ name: "quality", dir: ".groundwork/packs/quality" }),
    ];

    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks,
    });

    expect(inventory.stagedPacks).toBe(stagedPacks);
  });

  it("round-trips stagedPacks (name/dir/suffix/manifest/files) through JSON", () => {
    const stagedPacks: StagedPack[] = [stagedPack()];
    const inventory = buildInventory({
      detection: { mode: "adopt", signal: "found package.json" },
      templateRoot: "/tmp/templates/core",
      targetDir: "/tmp/project",
      survey: EMPTY_SURVEY,
      conflicts: [],
      packs: [],
      harnessGrade: EMPTY_GRADE,
      toolchainGrade: EMPTY_TOOLCHAIN_GRADE,
      stagedBaseline: EMPTY_STAGED_BASELINE,
      stagedPacks,
    });

    const path = writeInventory(inventory, groundworkDir);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Inventory;

    expect(parsed.stagedPacks).toEqual(stagedPacks);
    expect(parsed.stagedPacks[0]?.dir).toBe(".groundwork/packs/harness-extras");
    expect(parsed.stagedPacks[0]?.manifest.staged).toBe("pack.json.staged");
    expect(parsed.stagedPacks[0]?.files[0]?.staged).toBe(
      ".claude/agents/a.md.staged",
    );
  });

  it("types StagedPack as { name, dir, suffix, manifest: StagedPackFile, files: StagedPackFile[] }", () => {
    expectTypeOf<StagedPack>().toEqualTypeOf<{
      name: string;
      dir: string;
      suffix: string;
      manifest: StagedPackFile;
      files: StagedPackFile[];
    }>();
    expectTypeOf<StagedPackFile>().toEqualTypeOf<{
      path: string;
      staged: string;
      sha256: string;
    }>();
  });
});
