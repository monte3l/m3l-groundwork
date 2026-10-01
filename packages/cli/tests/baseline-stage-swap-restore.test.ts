// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stageBaselineAdditions`' atomic-swap restore branch
 * (`swapInto` in `src/baseline-stage.ts`): when the final rename of the new
 * staging directory into place fails, a previously-staged `baseline/` must
 * be restored rather than left parked or missing, and the thrown error must
 * chain the rename failure as its `cause`. `node:fs`'s `renameSync` is
 * mocked (importOriginal-preserving) in this file ONLY -- isolated from
 * `baseline-stage.test.ts`'s much larger real-filesystem suite, so the
 * mock's blast radius stays small (the pattern `git.test.ts`'s own header
 * comment documents for closing a per-file coverage gap without mocking
 * away the thing genuinely under test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflicts } from "../src/conflicts.js";
import {
  STAGED_BASELINE_DIR,
  stageBaselineAdditions,
} from "../src/baseline-stage.js";

const { renameSyncMock } = vi.hoisted(() => ({ renameSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, renameSync: renameSyncMock };
});

describe("stageBaselineAdditions -- atomic swap restore", () => {
  let templateRoot: string;
  let targetDir: string;
  let groundworkDir: string;
  let realRenameSync: typeof FsModule.renameSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRenameSync = actual.renameSync;
    renameSyncMock.mockReset();
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) =>
        realRenameSync(...args),
    );
    templateRoot = mkdtempSync(join(tmpdir(), "swap-restore-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "swap-restore-target-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "swap-restore-groundwork-"));
  });

  afterEach(() => {
    renameSyncMock.mockReset();
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("restores the previous baseline/ and chains the rename failure as cause when the final swap rename fails", () => {
    writeFileSync(join(templateRoot, "first.txt"), "first\n");
    const firstConflicts = planConflicts(templateRoot, targetDir, {});
    const firstStaged = stageBaselineAdditions(
      templateRoot,
      firstConflicts,
      groundworkDir,
      {},
    );

    const baselineDir = join(groundworkDir, STAGED_BASELINE_DIR);
    const firstStagedName = firstStaged[0]?.staged ?? "";
    expect(readFileSync(join(baselineDir, firstStagedName), "utf8")).toBe(
      "first\n",
    );

    writeFileSync(join(templateRoot, "second.txt"), "second\n");
    const secondConflicts = planConflicts(templateRoot, targetDir, {});

    const renameFailure = new Error("simulated rename failure");
    let callCount = 0;
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => {
        callCount += 1;
        // swapInto's calls, in order: (1) park the previous baseline/ aside
        // -- must succeed so there is something to restore; (2) the final
        // newDir -> destDir swap -- fail exactly this one; (3), on that
        // failure, the restore rename of the parked dir back into place --
        // must succeed so the restore actually lands.
        if (callCount === 2) {
          throw renameFailure;
        }
        return realRenameSync(...args);
      },
    );

    let thrown: unknown;
    try {
      stageBaselineAdditions(templateRoot, secondConflicts, groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(renameFailure);
    expect((thrown as Error).message).toContain(".groundwork/");
    expect((thrown as Error).message).toContain("re-run");

    // The previous staging (first.txt.staged) is restored, not left parked
    // or missing.
    expect(readFileSync(join(baselineDir, firstStagedName), "utf8")).toBe(
      "first\n",
    );
  });
});
