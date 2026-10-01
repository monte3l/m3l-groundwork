// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stageBaselineAdditions`' `finally` cleanup branch: when removing
 * the temporary staging work directory itself fails (best-effort today, but
 * must not fail silently), it must warn naming the work directory path.
 * `node:fs`'s `rmSync` is mocked (importOriginal-preserving) in this file
 * ONLY, matching the isolation `baseline-stage-swap-restore.test.ts` uses
 * for `renameSync` -- see that file's header comment for why the mock lives
 * in its own file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
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

describe("stageBaselineAdditions -- work dir cleanup failure", () => {
  let templateRoot: string;
  let targetDir: string;
  let groundworkDir: string;
  let realRmSync: typeof FsModule.rmSync;
  const cleanupFailure = new Error("simulated rmSync failure");

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRmSync = actual.rmSync;
    rmSyncMock.mockReset();
    templateRoot = mkdtempSync(join(tmpdir(), "cleanup-warn-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "cleanup-warn-target-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "cleanup-warn-groundwork-"));
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    vi.restoreAllMocks();
    realRmSync(templateRoot, { recursive: true, force: true });
    realRmSync(targetDir, { recursive: true, force: true });
    realRmSync(groundworkDir, { recursive: true, force: true });
  });

  it("calls console.warn with the work dir path when removing the temp staging work dir fails", () => {
    writeFileSync(join(templateRoot, "only.txt"), "same everywhere\n");
    const conflicts = planConflicts(templateRoot, targetDir, {});

    let capturedWorkDir = "";
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => {
        const [path] = args;
        if (
          typeof path === "string" &&
          path.includes(join(groundworkDir, ".baseline-"))
        ) {
          capturedWorkDir = path;
          throw cleanupFailure;
        }
        return realRmSync(...args);
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {});

    expect(warnSpy).toHaveBeenCalled();
    const sawWorkDir = warnSpy.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes(capturedWorkDir),
      ),
    );
    expect(capturedWorkDir).not.toBe("");
    expect(sawWorkDir).toBe(true);

    // The stray temp dir itself is left behind by the mocked failure (real
    // rmSync never ran for it), but that's this test's own artifact, not a
    // regression to clean up here -- the real filesystem cleanup below
    // handles the whole groundworkDir regardless.
    expect(
      readdirSync(groundworkDir).some((name) => name.startsWith(".baseline-")),
    ).toBe(true);
  });
});
