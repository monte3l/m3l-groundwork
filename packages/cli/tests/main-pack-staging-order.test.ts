// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt`'s pack- and baseline-staging write-scope ordering (issue #99,
 * extended by round-2 item 3 to the baseline planner too, and round-3 item 2
 * to the new `planPackStaging`/`planBaselineStaging` exports those planners
 * were renamed/restructured into -- see `pack-stage-plan.test.ts`/
 * `baseline-stage-plan.test.ts`): both `planPackStaging` and
 * `planBaselineStaging` must be computed, and `assertAdoptWriteScope` run
 * against BOTH results' `paths`, before any of the three stale
 * `.groundwork/` files are deleted and before either stager writes
 * anything.
 *
 * Unlike an earlier version of this file (which mocked a planner to THROW
 * directly, a shape a real CWE-22 escape can't actually produce through the
 * CLI's own input validation -- see the historical note this replaces),
 * these tests mock a planner to RETURN a real, resolvable, but
 * out-of-scope path: a project file outside `.groundwork/`.
 * `assertAdoptWriteScope`'s own `AssertionError` must be the thing that
 * stops the run -- if the `assertAdoptWriteScope` call wrapping either
 * planner's result is ever dropped, these tests fail outright (the run
 * would instead proceed to stage, and for the baseline case delete the
 * previous `.groundwork/` files, despite the escaping path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as BaselineStageModule from "../src/baseline-stage.js";
import type * as PackStageModule from "../src/pack-stage.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn(() => ({ filesWritten: [] }));
const installCustomizeSkillGuardedMock = vi.fn(() => ({
  filesWritten: [],
  location: "claude" as const,
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
  installCustomizeSkillGuarded: installCustomizeSkillGuardedMock,
}));

const {
  planPackStagingMock,
  stagePacksMock,
  planBaselineStagingMock,
  stageBaselineAdditionsMock,
  callOrder,
} = vi.hoisted(() => ({
  planPackStagingMock: vi.fn(),
  stagePacksMock: vi.fn(),
  planBaselineStagingMock: vi.fn(),
  stageBaselineAdditionsMock: vi.fn(),
  callOrder: [] as string[],
}));

vi.mock("../src/pack-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PackStageModule>();
  return {
    ...actual,
    planPackStaging: (...args: Parameters<typeof actual.planPackStaging>) => {
      callOrder.push("pack-planned");
      return planPackStagingMock(...args) as ReturnType<
        typeof actual.planPackStaging
      >;
    },
    stagePacks: (...args: Parameters<typeof actual.stagePacks>) => {
      callOrder.push("pack-staged");
      return stagePacksMock(...args) as ReturnType<typeof actual.stagePacks>;
    },
  };
});

vi.mock("../src/baseline-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BaselineStageModule>();
  return {
    ...actual,
    planBaselineStaging: (
      ...args: Parameters<typeof actual.planBaselineStaging>
    ) => {
      callOrder.push("baseline-planned");
      return planBaselineStagingMock(...args) as ReturnType<
        typeof actual.planBaselineStaging
      >;
    },
    stageBaselineAdditions: (
      ...args: Parameters<typeof actual.stageBaselineAdditions>
    ) => {
      callOrder.push("baseline-staged");
      return stageBaselineAdditionsMock(...args) as ReturnType<
        typeof actual.stageBaselineAdditions
      >;
    },
  };
});

const { main } = await import("../src/main.js");

describe("runAdopt pack/baseline-staging write-scope ordering (#99, round-2 item 3)", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-stage-order-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
    planPackStagingMock.mockReset();
    stagePacksMock.mockReset();
    planBaselineStagingMock.mockReset();
    stageBaselineAdditionsMock.mockReset();
    callOrder.length = 0;
    // Safe defaults every test can rely on unless it overrides one: an
    // empty plan/result never trips assertAdoptWriteScope and never writes
    // anything real.
    planPackStagingMock.mockImplementation(() => ({ paths: [] }));
    stagePacksMock.mockImplementation(() => []);
    planBaselineStagingMock.mockImplementation(() => ({ paths: [] }));
    stageBaselineAdditionsMock.mockImplementation(() => []);
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("calls planPackStaging (feeding assertAdoptWriteScope) BEFORE stagePacks on a normal run", () => {
    const projectDir = join(targetDir, "project-normal");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );

    main([projectDir]);

    expect(planPackStagingMock).toHaveBeenCalled();
    expect(stagePacksMock).toHaveBeenCalled();
    const plannedIndex = callOrder.indexOf("pack-planned");
    const stagedIndex = callOrder.indexOf("pack-staged");
    expect(plannedIndex).toBeGreaterThanOrEqual(0);
    expect(stagedIndex).toBeGreaterThan(plannedIndex);
  });

  it("throws 'adopt mode wrote outside its scope', calls stagePacks NEVER, and leaves the previous inventory.json/packs/ byte-for-byte intact when planPackStaging returns a real but out-of-scope path (a project file, not under .groundwork/)", () => {
    const projectDir = join(targetDir, "project-pack-escape");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const groundworkDir = join(projectDir, ".groundwork");
    mkdirSync(join(groundworkDir, "packs", "old-pack"), { recursive: true });
    const priorPackFile = join(
      groundworkDir,
      "packs",
      "old-pack",
      "pack.json.staged",
    );
    writeFileSync(priorPackFile, "{}");
    const inventoryPath = join(groundworkDir, "inventory.json");
    const priorInventory = JSON.stringify({
      schemaVersion: 0,
      marker: "pre-existing",
    });
    writeFileSync(inventoryPath, priorInventory);

    // A REAL, resolvable path -- not a contrived throw -- that is genuinely
    // outside .groundwork/: assertAdoptWriteScope's own AssertionError must
    // be what stops the run.
    planPackStagingMock.mockImplementation(() => ({
      paths: [join(projectDir, "package.json")],
    }));

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toMatch(
      /adopt mode wrote outside its scope/,
    );
    expect(stagePacksMock).not.toHaveBeenCalled();
    expect(stageBaselineAdditionsMock).not.toHaveBeenCalled();

    expect(existsSync(inventoryPath)).toBe(true);
    expect(readFileSync(inventoryPath, "utf8")).toBe(priorInventory);
    expect(existsSync(priorPackFile)).toBe(true);
    expect(readFileSync(priorPackFile, "utf8")).toBe("{}");
  });

  it("throws 'adopt mode wrote outside its scope', calls stageBaselineAdditions and stagePacks NEVER, and leaves the previous inventory.json/packs/ byte-for-byte intact when planBaselineStaging returns a real but out-of-scope path", () => {
    const projectDir = join(targetDir, "project-baseline-escape");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const groundworkDir = join(projectDir, ".groundwork");
    mkdirSync(join(groundworkDir, "packs", "old-pack"), { recursive: true });
    const priorPackFile = join(
      groundworkDir,
      "packs",
      "old-pack",
      "pack.json.staged",
    );
    writeFileSync(priorPackFile, "{}");
    const inventoryPath = join(groundworkDir, "inventory.json");
    const priorInventory = JSON.stringify({
      schemaVersion: 0,
      marker: "pre-existing",
    });
    writeFileSync(inventoryPath, priorInventory);

    planBaselineStagingMock.mockImplementation(() => ({
      paths: [join(projectDir, "package.json")],
    }));

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toMatch(
      /adopt mode wrote outside its scope/,
    );
    expect(stageBaselineAdditionsMock).not.toHaveBeenCalled();
    expect(stagePacksMock).not.toHaveBeenCalled();

    expect(existsSync(inventoryPath)).toBe(true);
    expect(readFileSync(inventoryPath, "utf8")).toBe(priorInventory);
    expect(existsSync(priorPackFile)).toBe(true);
    expect(readFileSync(priorPackFile, "utf8")).toBe("{}");
  });
});
