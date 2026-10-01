// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stageBaselineAdditions`' failure branch AFTER the temporary
 * staging directory already exists (one file already copied, a later one
 * fails to write): the thrown error must wrap the real cause (`.groundwork/`
 * + "incomplete" + "re-run" + the cause's own message), and no `.baseline-*`
 * temp dir may survive under `groundworkDir` while any previous `baseline/`
 * stays intact. `node:fs`'s `writeFileSync` is mocked
 * (importOriginal-preserving) in this file ONLY, matching the isolation
 * baseline-stage-swap-restore.test.ts uses for `renameSync` -- see that
 * file's header comment for why the mock lives in its own file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflicts } from "../src/conflicts.js";
import {
  STAGED_BASELINE_DIR,
  stageBaselineAdditions,
} from "../src/baseline-stage.js";

const { writeFileSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, writeFileSync: writeFileSyncMock };
});

describe("stageBaselineAdditions -- write failure after the temp dir exists", () => {
  let templateRoot: string;
  let targetDir: string;
  let groundworkDir: string;
  let realWriteFileSync: typeof FsModule.writeFileSync;
  const writeFailure = new Error("simulated disk full");

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteFileSync = actual.writeFileSync;
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.writeFileSync>) => {
        const [path] = args;
        if (typeof path === "string" && path.endsWith("b.txt.staged")) {
          throw writeFailure;
        }
        return realWriteFileSync(...args);
      },
    );
    templateRoot = mkdtempSync(join(tmpdir(), "write-failure-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "write-failure-target-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "write-failure-groundwork-"));
  });

  afterEach(() => {
    writeFileSyncMock.mockReset();
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("wraps the write failure as cause, naming '.groundwork/', 'incomplete', 're-run' and the cause's own message, leaving no temp dir and the previous baseline intact", async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    actual.writeFileSync(join(templateRoot, "a.txt"), "a\n");
    actual.writeFileSync(join(templateRoot, "b.txt"), "b\n");

    const conflicts = planConflicts(templateRoot, targetDir, {});
    expect(conflicts.length).toBe(2);

    let thrown: unknown;
    try {
      stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(".groundwork/");
    expect(message).toContain("incomplete");
    expect(message).toContain("re-run");
    expect(message).toContain(writeFailure.message);
    expect((thrown as Error).cause).toBe(writeFailure);

    // No .baseline-* temp dir survives, and nothing was ever swapped into
    // place -- the previous (nonexistent) baseline/ stays absent, not
    // half-written.
    expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
    expect(
      readdirSync(groundworkDir).filter((name) => name.startsWith(".")),
    ).toEqual([]);
  });
});
