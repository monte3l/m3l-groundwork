// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stageBaselineAdditions`' empty-plan branch (nothing marked
 * "absent"): removing any previous `baseline/` staging there is currently
 * OUTSIDE the function's try/catch, so a failure propagates as a raw,
 * unwrapped `rmSync` error instead of the standard
 * ".groundwork/ ... incomplete ... re-run" `Error` with `cause` every other
 * staging failure gets (see `baseline-stage-swap-restore.test.ts` and
 * `baseline-stage.test.ts`'s own coverage of that wrapping). `node:fs`'s
 * `rmSync` is mocked (importOriginal-preserving) in this file ONLY, matching
 * the isolation pattern `baseline-stage-cleanup-warn.test.ts` uses for the
 * same export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflicts } from "../src/conflicts.js";
import { stageBaselineAdditions } from "../src/baseline-stage.js";

const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, rmSync: rmSyncMock };
});

describe("stageBaselineAdditions -- empty-plan cleanup failure", () => {
  let templateRoot: string;
  let targetDir: string;
  let groundworkDir: string;
  let realRmSync: typeof FsModule.rmSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRmSync = actual.rmSync;
    rmSyncMock.mockReset();
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => realRmSync(...args),
    );
    templateRoot = mkdtempSync(join(tmpdir(), "empty-plan-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "empty-plan-target-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "empty-plan-groundwork-"));
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    realRmSync(templateRoot, { recursive: true, force: true });
    realRmSync(targetDir, { recursive: true, force: true });
    realRmSync(groundworkDir, { recursive: true, force: true });
  });

  it("wraps a failure removing the previous baseline/ (when nothing is absent) in the standard incomplete/re-run Error with cause, instead of letting it propagate raw", () => {
    // Nothing absent: templateRoot and targetDir have identical content, so
    // the conflict plan marks the only file "identical", never "absent" --
    // stageBaselineAdditions then takes its empty-plan branch, whose only
    // job is to clear out any PREVIOUS staging.
    writeFileSync(join(templateRoot, "only.txt"), "same everywhere\n");
    writeFileSync(join(targetDir, "only.txt"), "same everywhere\n");
    const conflicts = planConflicts(templateRoot, targetDir, {});
    expect(conflicts.every((c) => c.status !== "absent")).toBe(true);

    const cleanupFailure = new Error(
      "simulated rmSync failure removing baseline/",
    );
    rmSyncMock.mockImplementation(() => {
      throw cleanupFailure;
    });

    let thrown: unknown;
    try {
      stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(cleanupFailure);
    expect((thrown as Error).cause).toBe(cleanupFailure);
    const message = (thrown as Error).message;
    expect(message).toContain(".groundwork/");
    expect(message).toContain("incomplete");
    expect(message).toContain("re-run");
  });
});
