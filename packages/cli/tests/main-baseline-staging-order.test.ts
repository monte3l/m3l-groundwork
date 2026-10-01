// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt`'s write-scope ordering, extended to the BASELINE planner
 * (round-2 item 3, mirroring issue #99's pack-planner fix):
 * `plannedBaselineStagingPaths` must be called, and
 * `assertAdoptWriteScope` run against its result, BEFORE the three stale
 * `.groundwork/` files (`inventory.json`, `adoption-report.md`,
 * `adoption-decisions.json`) are deleted and before either stager writes
 * anything -- the same isolation pattern `main-pack-staging-order.test.ts`
 * uses for the pack planner, applied to the baseline planner's own export.
 * An invalid baseline plan must therefore delete nothing and stage nothing,
 * packs included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  plannedBaselineStagingPathsMock,
  stageBaselineAdditionsMock,
  stagePacksMock,
} = vi.hoisted(() => ({
  plannedBaselineStagingPathsMock: vi.fn(),
  stageBaselineAdditionsMock: vi.fn(),
  stagePacksMock: vi.fn(),
}));

vi.mock("../src/baseline-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BaselineStageModule>();
  return {
    ...actual,
    plannedBaselineStagingPaths: (
      ...args: Parameters<typeof actual.plannedBaselineStagingPaths>
    ) =>
      plannedBaselineStagingPathsMock(...args) as ReturnType<
        typeof actual.plannedBaselineStagingPaths
      >,
    stageBaselineAdditions: (
      ...args: Parameters<typeof actual.stageBaselineAdditions>
    ) =>
      stageBaselineAdditionsMock(...args) as ReturnType<
        typeof actual.stageBaselineAdditions
      >,
  };
});

vi.mock("../src/pack-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PackStageModule>();
  return {
    ...actual,
    stagePacks: (...args: Parameters<typeof actual.stagePacks>) =>
      stagePacksMock(...args) as ReturnType<typeof actual.stagePacks>,
  };
});

const { main } = await import("../src/main.js");

describe("runAdopt baseline-staging write-scope ordering (round-2 item 3)", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-baseline-order-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
    plannedBaselineStagingPathsMock.mockReset();
    stageBaselineAdditionsMock.mockReset();
    stagePacksMock.mockReset();
    // Safe defaults every test can rely on unless it overrides one: an
    // empty plan/result never trips assertAdoptWriteScope and never writes
    // anything real, regardless of which of the two planners the
    // implementation happens to call first.
    plannedBaselineStagingPathsMock.mockImplementation(() => []);
    stageBaselineAdditionsMock.mockImplementation(() => []);
    stagePacksMock.mockImplementation(() => []);
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("calls plannedBaselineStagingPaths on a normal run (feeding assertAdoptWriteScope before any staging)", () => {
    const projectDir = join(targetDir, "project-normal");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );

    main([projectDir]);

    expect(plannedBaselineStagingPathsMock).toHaveBeenCalled();
    expect(existsSync(join(projectDir, ".groundwork", "inventory.json"))).toBe(
      true,
    );
  });

  it("deletes NOTHING and stages NOTHING (neither baseline nor packs) when plannedBaselineStagingPaths -- the write-scope check's input -- throws an invalid-plan error before any deletion", () => {
    const projectDir = join(targetDir, "project-invalid-baseline-plan");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const groundworkDir = join(projectDir, ".groundwork");
    mkdirSync(groundworkDir, { recursive: true });
    const inventoryPath = join(groundworkDir, "inventory.json");
    const reportPath = join(groundworkDir, "adoption-report.md");
    const decisionsPath = join(groundworkDir, "adoption-decisions.json");
    const priorInventory = JSON.stringify({
      schemaVersion: 0,
      marker: "pre-existing",
    });
    const priorReport = "# stale report\n";
    const priorDecisions = JSON.stringify({ stale: true });
    writeFileSync(inventoryPath, priorInventory);
    writeFileSync(reportPath, priorReport);
    writeFileSync(decisionsPath, priorDecisions);

    const planError = new Error(
      "absent baseline file ghost.txt has no counterpart under /some/template/root",
    );
    plannedBaselineStagingPathsMock.mockImplementation(() => {
      throw planError;
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(planError);
    expect(stageBaselineAdditionsMock).not.toHaveBeenCalled();
    expect(stagePacksMock).not.toHaveBeenCalled();
    expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
    expect(existsSync(join(groundworkDir, "baseline"))).toBe(false);
    expect(
      readdirSync(groundworkDir).some(
        (name) => name.startsWith(".packs-") || name.startsWith(".baseline-"),
      ),
    ).toBe(false);

    expect(existsSync(inventoryPath)).toBe(true);
    expect(readFileSync(inventoryPath, "utf8")).toBe(priorInventory);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe(priorReport);
    expect(existsSync(decisionsPath)).toBe(true);
    expect(readFileSync(decisionsPath, "utf8")).toBe(priorDecisions);
  });
});
