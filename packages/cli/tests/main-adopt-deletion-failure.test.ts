// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt`'s three stale-file deletions (`inventory.json`,
 * `adoption-report.md`, `adoption-decisions.json`) now run INSIDE the
 * wrapped block (item 2): the first deletion is the point of no return, so
 * a failure of ANY of the three -- not just a later staging/grading/install
 * step, which `main-adopt-failure-wrapping.test.ts` already covers -- must
 * be rethrown as `removedStaleFilesError` (chaining the original failure),
 * never propagate raw. A failure of the FIRST deletion is wrapped too, even
 * though nothing was actually removed yet -- the message must stay
 * truthful about that (never claim the files "were removed" when the very
 * first `rmSync` call itself failed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) =>
      rmSyncMock(...args) as ReturnType<
        typeof actual.rmSync
      >) as typeof actual.rmSync,
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

function seedStaleGroundwork(projectDir: string): {
  inventoryPath: string;
  reportPath: string;
  decisionsPath: string;
} {
  const groundworkDir = join(projectDir, ".groundwork");
  mkdirSync(groundworkDir, { recursive: true });
  const inventoryPath = join(groundworkDir, "inventory.json");
  const reportPath = join(groundworkDir, "adoption-report.md");
  const decisionsPath = join(groundworkDir, "adoption-decisions.json");
  writeFileSync(inventoryPath, "stale inventory\n");
  writeFileSync(reportPath, "stale report\n");
  writeFileSync(decisionsPath, "stale decisions\n");
  return { inventoryPath, reportPath, decisionsPath };
}

describe("runAdopt -- deletion-step failures (item 2: deletions run inside the wrapped block)", () => {
  let targetDir: string;
  let realRmSync: typeof FsModule.rmSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRmSync = actual.rmSync;
    rmSyncMock.mockReset();
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) =>
      realRmSync(...args),
    );
    installCustomizeSkillGuardedMock.mockReset();
    installCustomizeSkillGuardedMock.mockImplementation(() => ({
      filesWritten: [],
      location: "claude" as const,
    }));
    installCustomizeSkillMock.mockClear();
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    targetDir = mkdtempSync(join(tmpdir(), "adopt-deletion-fail-"));
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    realRmSync(targetDir, { recursive: true, force: true });
  });

  it("wraps a failure of the THIRD deletion (adoption-decisions.json) as removedStaleFilesError, leaving inventory.json/adoption-report.md actually removed and adoption-decisions.json still on disk", () => {
    const projectDir = seedProject(targetDir, "fail-third-deletion");
    const { inventoryPath, reportPath, decisionsPath } =
      seedStaleGroundwork(projectDir);

    const rmFailure = new Error(
      "simulated EISDIR removing adoption-decisions.json",
    );
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) => {
      const [path] = args;
      if (path === decisionsPath) {
        throw rmFailure;
      }
      return realRmSync(...args);
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(assert.AssertionError);
    expect((thrown as Error).cause).toBe(rmFailure);
    expect((thrown as Error).message).toMatch(/re-run/);

    // The first two deletions DID succeed; only the third's rmSync failed,
    // so the third file is still on disk.
    expect(existsSync(inventoryPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(decisionsPath)).toBe(true);
  });

  it("wraps a failure of the SECOND deletion (adoption-report.md), never attempting the third", () => {
    const projectDir = seedProject(targetDir, "fail-second-deletion");
    const { inventoryPath, reportPath, decisionsPath } =
      seedStaleGroundwork(projectDir);

    const rmFailure = new Error("simulated EISDIR removing adoption-report.md");
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) => {
      const [path] = args;
      if (path === reportPath) {
        throw rmFailure;
      }
      return realRmSync(...args);
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(assert.AssertionError);
    expect((thrown as Error).cause).toBe(rmFailure);
    expect((thrown as Error).message).toMatch(/re-run/);

    expect(existsSync(inventoryPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    // The third deletion is never reached once the second one throws.
    expect(existsSync(decisionsPath)).toBe(true);
  });

  it("wraps a failure of the FIRST deletion (inventory.json, the commitment point) even though nothing was actually removed -- the message must not falsely claim the files 'were removed'", () => {
    const projectDir = seedProject(targetDir, "fail-first-deletion");
    const { inventoryPath, reportPath, decisionsPath } =
      seedStaleGroundwork(projectDir);

    const rmFailure = new Error("simulated EISDIR removing inventory.json");
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) => {
      const [path] = args;
      if (path === inventoryPath) {
        throw rmFailure;
      }
      return realRmSync(...args);
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(assert.AssertionError);
    expect((thrown as Error).cause).toBe(rmFailure);
    expect((thrown as Error).message).toMatch(/re-run/);
    // Nothing was actually removed -- the message must not say so.
    expect((thrown as Error).message).not.toMatch(/were removed/i);

    expect(existsSync(inventoryPath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(decisionsPath)).toBe(true);
  });
});
