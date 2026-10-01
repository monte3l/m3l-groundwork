// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt`'s failure wrapping after the point of no return (round-3 item
 * 3): once the three stale `.groundwork/` files (`inventory.json`,
 * `adoption-report.md`, `adoption-decisions.json`) are deleted, any
 * subsequent failure -- staging packs, staging the baseline, grading the
 * harness, grading the toolchain, installing the guarded `/customize`
 * skill, or writing `adoption-report.md` itself -- must be rethrown as a new
 * `Error` whose message says those three files were just removed
 * (`adoption-decisions.json` included, since a re-run does NOT recreate it
 * on its own -- only `/customize` does) and that the cause should be fixed
 * and the CLI re-run, chaining the original failure as `cause`.
 *
 * `writeInventory`'s OWN failure is deliberately NOT one of these cases: it
 * already has its own documented, narrower handling (remove the
 * just-written report, best effort, and rethrow the original failure
 * unmodified) -- see `main-write-inventory-failure.test.ts`, which this file
 * leaves untouched.
 *
 * An `AssertionError` from `assertAdoptWriteScope`'s own write-scope check
 * firing AFTER the deletions (a guarded skill install reporting an
 * out-of-scope `filesWritten` path) is a broken invariant, not something a
 * re-run fixes, and must propagate UNWRAPPED -- the after-deletion half of
 * the same distinction `main-pack-staging-order.test.ts` and
 * `main-baseline-staging-order.test.ts` already cover for the two planners
 * running BEFORE the deletions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as BaselineStageModule from "../src/baseline-stage.js";
import type * as PackStageModule from "../src/pack-stage.js";
import type * as HarnessGradeModule from "../src/harness/grade.js";
import type * as ToolchainGradeModule from "../src/toolchain/grade.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn(() => ({ filesWritten: [] }));

const {
  installCustomizeSkillGuardedMock,
  stageBaselineAdditionsMock,
  stagePacksMock,
  gradeHarnessMock,
  gradeToolchainMock,
  writeFileSyncMock,
} = vi.hoisted(() => ({
  installCustomizeSkillGuardedMock: vi.fn(() => ({
    filesWritten: [] as string[],
    location: "claude" as const,
  })),
  stageBaselineAdditionsMock: vi.fn(),
  stagePacksMock: vi.fn(),
  gradeHarnessMock: vi.fn(),
  gradeToolchainMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
  installCustomizeSkillGuarded: installCustomizeSkillGuardedMock,
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

vi.mock("../src/pack-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PackStageModule>();
  return {
    ...actual,
    stagePacks: (...args: Parameters<typeof actual.stagePacks>) =>
      stagePacksMock(...args) as ReturnType<typeof actual.stagePacks>,
  };
});

vi.mock("../src/harness/grade.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HarnessGradeModule>();
  return {
    ...actual,
    gradeHarness: (...args: Parameters<typeof actual.gradeHarness>) =>
      gradeHarnessMock(...args) as ReturnType<typeof actual.gradeHarness>,
  };
});

vi.mock("../src/toolchain/grade.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ToolchainGradeModule>();
  return {
    ...actual,
    gradeToolchain: (...args: Parameters<typeof actual.gradeToolchain>) =>
      gradeToolchainMock(...args) as ReturnType<typeof actual.gradeToolchain>,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) =>
      writeFileSyncMock(...args) as ReturnType<
        typeof actual.writeFileSync
      >) as typeof actual.writeFileSync,
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

describe("runAdopt -- failure wrapping after the point of no return (round-3 item 3)", () => {
  let targetDir: string;
  let realWriteFileSync: typeof FsModule.writeFileSync;

  beforeEach(async () => {
    const fsActual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteFileSync = fsActual.writeFileSync;
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realWriteFileSync>) =>
        realWriteFileSync(...args),
    );

    const baselineActual = await vi.importActual<typeof BaselineStageModule>(
      "../src/baseline-stage.js",
    );
    stageBaselineAdditionsMock.mockReset();
    stageBaselineAdditionsMock.mockImplementation(
      (...args: Parameters<typeof baselineActual.stageBaselineAdditions>) =>
        baselineActual.stageBaselineAdditions(...args),
    );

    const packActual = await vi.importActual<typeof PackStageModule>(
      "../src/pack-stage.js",
    );
    stagePacksMock.mockReset();
    stagePacksMock.mockImplementation(
      (...args: Parameters<typeof packActual.stagePacks>) =>
        packActual.stagePacks(...args),
    );

    const harnessActual = await vi.importActual<typeof HarnessGradeModule>(
      "../src/harness/grade.js",
    );
    gradeHarnessMock.mockReset();
    gradeHarnessMock.mockImplementation(
      (...args: Parameters<typeof harnessActual.gradeHarness>) =>
        harnessActual.gradeHarness(...args),
    );

    const toolchainActual = await vi.importActual<typeof ToolchainGradeModule>(
      "../src/toolchain/grade.js",
    );
    gradeToolchainMock.mockReset();
    gradeToolchainMock.mockImplementation(
      (...args: Parameters<typeof toolchainActual.gradeToolchain>) =>
        toolchainActual.gradeToolchain(...args),
    );

    installCustomizeSkillGuardedMock.mockReset();
    installCustomizeSkillGuardedMock.mockImplementation(() => ({
      filesWritten: [],
      location: "claude" as const,
    }));
    installCustomizeSkillMock.mockClear();
    gitInitMock.mockClear();
    runInstallMock.mockClear();

    targetDir = mkdtempSync(join(tmpdir(), "post-deletion-fail-"));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it.each([
    [
      "stageBaselineAdditions",
      () => {
        const cause = new Error("simulated stageBaselineAdditions failure");
        stageBaselineAdditionsMock.mockImplementationOnce(() => {
          throw cause;
        });
        return cause;
      },
    ],
    [
      "stagePacks",
      () => {
        const cause = new Error("simulated stagePacks failure");
        stagePacksMock.mockImplementationOnce(() => {
          throw cause;
        });
        return cause;
      },
    ],
    [
      "gradeHarness",
      () => {
        const cause = new Error("simulated gradeHarness failure");
        gradeHarnessMock.mockImplementationOnce(() => {
          throw cause;
        });
        return cause;
      },
    ],
    [
      "gradeToolchain",
      () => {
        const cause = new Error("simulated gradeToolchain failure");
        gradeToolchainMock.mockImplementationOnce(() => {
          throw cause;
        });
        return cause;
      },
    ],
    [
      "installCustomizeSkillGuarded",
      () => {
        const cause = new Error(
          "simulated installCustomizeSkillGuarded failure",
        );
        installCustomizeSkillGuardedMock.mockImplementationOnce(() => {
          throw cause;
        });
        return cause;
      },
    ],
  ] as const)(
    "wraps a %s failure as an Error naming the three removed files and 're-run', chaining the original as cause",
    (label, arrange) => {
      const projectDir = seedProject(targetDir, `fail-${label}`);
      const { inventoryPath, reportPath, decisionsPath } =
        seedStaleGroundwork(projectDir);
      const cause = arrange();

      let thrown: unknown;
      try {
        main([projectDir]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(assert.AssertionError);
      const message = (thrown as Error).message;
      expect(message).toMatch(/adoption-decisions\.json/);
      expect(message).toMatch(/removed/);
      expect(message).toMatch(/re-run/);
      expect((thrown as Error).cause).toBe(cause);

      expect(existsSync(inventoryPath)).toBe(false);
      expect(existsSync(reportPath)).toBe(false);
      expect(existsSync(decisionsPath)).toBe(false);
    },
  );

  it("wraps a non-Error value thrown after the point of no return (String(cause) fallback), still naming the three removed files and 're-run', chaining the original string as cause and including it in the message", () => {
    const projectDir = seedProject(targetDir, "fail-non-error-cause");
    const { inventoryPath, reportPath, decisionsPath } =
      seedStaleGroundwork(projectDir);

    const cause = "simulated-non-error-stageBaselineAdditions-failure";
    stageBaselineAdditionsMock.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to exercise removedStaleFilesError's String(cause) fallback
      throw cause;
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(assert.AssertionError);
    const message = (thrown as Error).message;
    expect(message).toMatch(/adoption-decisions\.json/);
    expect(message).toMatch(/removed/);
    expect(message).toMatch(/re-run/);
    expect(message).toContain(cause);
    expect((thrown as Error).cause).toBe(cause);

    expect(existsSync(inventoryPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(decisionsPath)).toBe(false);
  });

  it("wraps a failure writing adoption-report.md itself, naming the three removed files and 're-run', chaining the original as cause", () => {
    const projectDir = seedProject(targetDir, "fail-report-write");
    const { inventoryPath, reportPath, decisionsPath } =
      seedStaleGroundwork(projectDir);

    const cause = new Error("simulated adoption-report.md write failure");
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realWriteFileSync>) => {
        const [path] = args;
        if (path === reportPath) {
          throw cause;
        }
        return realWriteFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(assert.AssertionError);
    const message = (thrown as Error).message;
    expect(message).toMatch(/adoption-decisions\.json/);
    expect(message).toMatch(/removed/);
    expect(message).toMatch(/re-run/);
    expect((thrown as Error).cause).toBe(cause);

    expect(existsSync(inventoryPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(decisionsPath)).toBe(false);
  });

  it("propagates assertAdoptWriteScope's own AssertionError UNWRAPPED when it fires AFTER the deletions (installCustomizeSkillGuarded reporting an out-of-scope filesWritten path)", () => {
    const projectDir = seedProject(targetDir, "escape-after-deletion");
    const { inventoryPath, reportPath, decisionsPath } =
      seedStaleGroundwork(projectDir);

    installCustomizeSkillGuardedMock.mockImplementationOnce(() => ({
      filesWritten: [join(projectDir, "package.json")],
      location: "claude" as const,
    }));

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(assert.AssertionError);
    expect((thrown as Error).message).toMatch(
      /adopt mode wrote outside its scope/,
    );
    // The broken invariant is never re-wrapped with the generic
    // "removed ... re-run" staging-failure wording.
    expect((thrown as Error).message).not.toMatch(/re-run the CLI/);

    expect(existsSync(inventoryPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(decisionsPath)).toBe(false);
  });
});
