// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `removedStaleFilesError` names only the stale `.groundwork/` files that
 * actually existed BEFORE the run (item 6): `runAdopt` records `existsSync`
 * for `inventory.json`, `adoption-report.md` and `adoption-decisions.json`
 * before any deletion is attempted, and the message a later wrapped failure
 * produces lists exactly those -- never a file that was never there to
 * begin with. `main-adopt-failure-wrapping.test.ts` already covers the "all
 * three existed" case; this file covers "none existed" (a first adopt run)
 * and "only adoption-decisions.json existed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as BaselineStageModule from "../src/baseline-stage.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn(() => ({ filesWritten: [] }));
const installCustomizeSkillGuardedMock = vi.fn(() => ({
  filesWritten: [] as string[],
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

const { stageBaselineAdditionsMock } = vi.hoisted(() => ({
  stageBaselineAdditionsMock: vi.fn(),
}));

vi.mock("../src/baseline-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BaselineStageModule>();
  return {
    ...actual,
    stageBaselineAdditions: (
      ...args: Parameters<typeof actual.stageBaselineAdditions>
    ) =>
      stageBaselineAdditionsMock(...args) as ReturnType<
        typeof actual.stageBaselineAdditions
      >,
  };
});

const { main } = await import("../src/main.js");

function seedProject(targetDir: string, name: string): string {
  const projectDir = join(targetDir, name);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "acme", type: "module" }),
  );
  return projectDir;
}

describe("removedStaleFilesError -- names only the files that existed before the run (item 6)", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "adopt-removed-wording-"));
    stageBaselineAdditionsMock.mockReset();
    installCustomizeSkillGuardedMock.mockReset();
    installCustomizeSkillGuardedMock.mockImplementation(() => ({
      filesWritten: [],
      location: "claude" as const,
    }));
    installCustomizeSkillMock.mockClear();
    gitInitMock.mockClear();
    runInstallMock.mockClear();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("does not name adoption-decisions.json (or claim anything was removed) on a first run where NOTHING previously existed under .groundwork/", () => {
    const projectDir = seedProject(targetDir, "first-run-none-existed");
    const cause = new Error("simulated stageBaselineAdditions failure");
    stageBaselineAdditionsMock.mockImplementationOnce(() => {
      throw cause;
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(cause);
    const message = (thrown as Error).message;
    expect(message).not.toContain("adoption-decisions.json");
    expect(message).not.toContain("inventory.json");
    expect(message).not.toContain("adoption-report.md");
    expect(message).toMatch(/re-run/);
  });

  it("names ONLY adoption-decisions.json, and says it is not recreated by a re-run, when it was the sole pre-existing file", () => {
    const projectDir = seedProject(targetDir, "only-decisions-existed");
    const groundworkDir = join(projectDir, ".groundwork");
    mkdirSync(groundworkDir, { recursive: true });
    const decisionsPath = join(groundworkDir, "adoption-decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({ stale: true }));

    const cause = new Error("simulated stageBaselineAdditions failure");
    stageBaselineAdditionsMock.mockImplementationOnce(() => {
      throw cause;
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(cause);
    const message = (thrown as Error).message;
    expect(message).toContain("adoption-decisions.json");
    expect(message).toMatch(/not recreate/i);
    expect(message).not.toContain("inventory.json");
    expect(message).not.toContain("adoption-report.md");
  });
});
