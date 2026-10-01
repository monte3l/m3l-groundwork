// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `writeInventory`'s failure branch: when the final
 * `inventory.json.tmp` -> `inventory.json` rename fails, any pre-existing
 * `inventory.json` must stay byte-identical and no partial file may survive.
 * `node:fs`'s `renameSync` is mocked (importOriginal-preserving) in this file
 * ONLY, matching the isolation `baseline-stage-swap-restore.test.ts` uses --
 * `vi.spyOn` cannot override a named export of the real ESM `node:fs` module
 * (it throws `TypeError: Cannot redefine property`), so this mock replaces
 * the whole module via `vi.mock` + a `vi.hoisted` mock function instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInventory, writeInventory } from "../src/inventory.js";
import type { StagedBaseline } from "../src/inventory.js";
import type { HarnessGrade } from "../src/harness/types.js";
import type { ToolchainGrade } from "../src/toolchain/types.js";
import type { ProjectSurvey } from "../src/survey/survey.js";

const { renameSyncMock, rmSyncMock } = vi.hoisted(() => ({
  renameSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, renameSync: renameSyncMock, rmSync: rmSyncMock };
});

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

const EMPTY_STAGED_BASELINE: StagedBaseline = {
  dir: ".groundwork/baseline",
  suffix: ".staged",
  files: [],
};

function makeInventory(signal: string): ReturnType<typeof buildInventory> {
  return buildInventory({
    detection: { mode: "adopt", signal },
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
}

describe("writeInventory -- rename failure", () => {
  let groundworkDir: string;
  let realRenameSync: typeof FsModule.renameSync;
  let realRmSync: typeof FsModule.rmSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRenameSync = actual.renameSync;
    realRmSync = actual.rmSync;
    renameSyncMock.mockReset();
    rmSyncMock.mockReset();
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) =>
        realRenameSync(...args),
    );
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => realRmSync(...args),
    );
    groundworkDir = mkdtempSync(join(tmpdir(), "inventory-write-failure-"));
  });

  afterEach(() => {
    renameSyncMock.mockReset();
    rmSyncMock.mockReset();
    realRmSync(groundworkDir, { recursive: true, force: true });
  });

  it("leaves the existing inventory.json untouched and writes no partial file when the rename step fails, with the new 'fix the cause and re-run' wording and no 'previous inventory' claim", () => {
    const path = writeInventory(
      makeInventory("found package.json"),
      groundworkDir,
    );
    const before = readFileSync(path, "utf8");

    const renameFailure = new Error("simulated rename failure");
    renameSyncMock.mockImplementation(() => {
      throw renameFailure;
    });

    let thrown: unknown;
    try {
      writeInventory(makeInventory("a different signal"), groundworkDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(renameFailure);
    expect((thrown as Error).message).toBe(
      `writing ${path} failed, so .groundwork/ is incomplete -- fix the cause and re-run the CLI`,
    );
    expect((thrown as Error).message).not.toContain(
      "previous inventory.json is unchanged",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe("writeInventory -- failed tmp-file cleanup warns instead of swallowing", () => {
  let groundworkDir: string;
  let realRenameSync: typeof FsModule.renameSync;
  let realRmSync: typeof FsModule.rmSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRenameSync = actual.renameSync;
    realRmSync = actual.rmSync;
    renameSyncMock.mockReset();
    rmSyncMock.mockReset();
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) =>
        realRenameSync(...args),
    );
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => realRmSync(...args),
    );
    groundworkDir = mkdtempSync(join(tmpdir(), "inventory-cleanup-warn-"));
  });

  afterEach(() => {
    renameSyncMock.mockReset();
    rmSyncMock.mockReset();
    vi.restoreAllMocks();
    realRmSync(groundworkDir, { recursive: true, force: true });
  });

  it("calls console.warn naming the tmp path when removing the failed write's own tmp file fails, and still throws the wrapped write error", () => {
    const renameFailure = new Error("simulated rename failure");
    renameSyncMock.mockImplementation(() => {
      throw renameFailure;
    });

    const tmpPath = join(groundworkDir, "inventory.json.tmp");
    let rmCallCount = 0;
    const cleanupFailure = new Error("simulated tmp removal failure");
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => {
        const [path] = args;
        if (path === tmpPath) {
          rmCallCount += 1;
          // The FIRST call is writeInventory's own pre-write cleanup
          // (before anything failed yet) and must succeed normally; only
          // the SECOND call -- the catch block's best-effort cleanup after
          // the rename above already failed -- is made to fail here.
          if (rmCallCount === 1) {
            return realRmSync(...args);
          }
          throw cleanupFailure;
        }
        return realRmSync(...args);
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let thrown: unknown;
    try {
      writeInventory(makeInventory("found package.json"), groundworkDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // The error actually reported is still the rename failure, not the
    // cleanup failure -- the cleanup failure is only warned about.
    expect((thrown as Error).cause).toBe(renameFailure);
    expect(warnSpy).toHaveBeenCalled();
    const sawTmpPath = warnSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes(tmpPath)),
    );
    expect(sawTmpPath).toBe(true);
  });
});
