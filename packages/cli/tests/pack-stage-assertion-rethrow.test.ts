// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stagePacks`' handling of an `assert.AssertionError` thrown while
 * writing a pack's file (the CWE-22 path-containment re-assertion against the
 * directory actually written to, the same invariant
 * `baseline-stage.ts`/`staging.ts` re-asserts): that specific failure must
 * surface UNWRAPPED -- the exact same object, never re-wrapped in
 * `stagePacks`' own ".groundwork/ is incomplete -- re-run the CLI" `Error` --
 * because an assertion failure here means a real security invariant broke,
 * not an ordinary I/O failure a re-run could fix. Any OTHER failure from the
 * same write step must still wrap, exactly as before. `node:fs`'s
 * `writeFileSync` is mocked (importOriginal-preserving) in this file ONLY,
 * matching the isolation pattern `pack-stage-write-failure.test.ts` uses for
 * the same export, and the former `packs-assertion-rethrow.test.ts`'s
 * isolation of the now-removed `stagePackFiles`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pack } from "../src/packs.js";

const { writeFileSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, writeFileSync: writeFileSyncMock };
});

const { stagePacks } = await import("../src/pack-stage.js");

function makePack(name: string, filesDir: string): Pack {
  return {
    manifest: {
      schemaVersion: 1,
      name,
      description: "a test pack",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      requires: undefined,
      wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      adoptNotes: undefined,
    },
    filesDir,
  };
}

describe("stagePacks -- assert.AssertionError from the write step", () => {
  let filesRoot: string;
  let groundworkDir: string;
  let realWriteFileSync: typeof FsModule.writeFileSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteFileSync = actual.writeFileSync;
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.writeFileSync>) =>
        realWriteFileSync(...args),
    );
    filesRoot = mkdtempSync(join(tmpdir(), "pack-assertion-files-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "pack-assertion-gw-"));
  });

  afterEach(() => {
    writeFileSyncMock.mockReset();
    rmSync(filesRoot, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("surfaces an assert.AssertionError unwrapped -- the same object, no '.groundwork/ is incomplete' wrapper", () => {
    writeFileSync(join(filesRoot, "a.txt"), "a\n");
    const assertionError = new assert.AssertionError({
      message: "stagePacks: staged path escapes the staging directory",
    });
    writeFileSyncMock.mockImplementationOnce(() => {
      throw assertionError;
    });

    let thrown: unknown;
    try {
      stagePacks([makePack("assertion-pack", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(assertionError);
    expect(thrown).toBeInstanceOf(assert.AssertionError);
    expect((thrown as Error).message).not.toContain("is incomplete");
    expect((thrown as Error).message).not.toContain("re-run");
  });

  it("still wraps a non-assertion failure from the same write step with the '.groundwork/ is incomplete -- re-run' Error, cause preserved", () => {
    writeFileSync(join(filesRoot, "a.txt"), "a\n");
    const copyFailure = new Error("simulated copy failure");
    writeFileSyncMock.mockImplementationOnce(() => {
      throw copyFailure;
    });

    let thrown: unknown;
    try {
      stagePacks([makePack("copy-pack", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(copyFailure);
    expect((thrown as Error).message).toContain("is incomplete");
    expect((thrown as Error).message).toContain("re-run");
    expect((thrown as Error).cause).toBe(copyFailure);
  });
});
