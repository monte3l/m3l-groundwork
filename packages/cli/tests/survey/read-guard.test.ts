// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `guardedExists` (`read-guard.ts`) itself, direct: the discrimination it
 * documents between a permission failure (recorded, answers `false`), an
 * absent-path errno (`ENOENT`/`ENOTDIR`/`ELOOP`, answers `false` with
 * nothing recorded), and anything else (`EIO`, `EMFILE`, thrown as a
 * {@link SurveyReadError} naming the path, with the original chained as
 * `cause`). Every collector's own `*-io-error.test.ts` sibling only proves a
 * `readFileSync` failure propagates through `guardedRead`; this file is
 * `guardedExists`'s own `statSync` discrimination, including the two
 * absent-path codes (`ELOOP`, `ENOTDIR`) no existing test reaches.
 *
 * `node:fs` is mocked (`importOriginal`-preserving) in this file ONLY,
 * matching the isolation pattern other mocked-`node:fs` siblings use --
 * only `statSync` is replaced, so the real-symlink and real-ENOTDIR cases in
 * the second `describe` still exercise the genuine syscall.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { statSyncMock } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, statSync: statSyncMock };
});

const { guardedExists } =
  await import("../../src/survey/internal/read-guard.js");

describe("guardedExists -- a non-permission statSync failure throws, rather than being recorded or swallowed", () => {
  let dir: string;
  let realStatSync: typeof FsModule.statSync;
  let targetPath: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realStatSync = actual.statSync;
    statSyncMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "read-guard-exists-"));
    targetPath = join(dir, "probe");
    writeFileSync(targetPath, "x");
  });

  afterEach(() => {
    statSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["EIO", "EMFILE"])(
    "throws a SurveyReadError naming the path, with the original %s failure chained as cause, and records nothing in undetermined",
    (code) => {
      const failure = Object.assign(new Error(`simulated ${code}`), { code });
      statSyncMock.mockImplementation(
        (...args: Parameters<typeof FsModule.statSync>) => {
          const [path] = args;
          if (path === targetPath) {
            throw failure;
          }
          return (
            realStatSync as (
              ...callArgs: Parameters<typeof FsModule.statSync>
            ) => ReturnType<typeof FsModule.statSync>
          )(...args);
        },
      );

      const undetermined: string[] = [];
      let thrown: unknown;
      try {
        guardedExists(targetPath, undetermined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("SurveyReadError");
      expect(thrown).not.toBe(failure);
      expect((thrown as Error).message).toContain(targetPath);
      expect((thrown as Error).cause).toBe(failure);
      expect(undetermined).toEqual([]);
    },
  );
});

describe("guardedExists -- ELOOP is recorded in undetermined, not silently absent (RED: was answering false with nothing recorded)", () => {
  let dir: string;

  beforeEach(async () => {
    // statSync is mocked for the whole file (see the top-level `vi.mock`
    // above) -- without an explicit passthrough here it would default to
    // `vi.fn()`'s `undefined` return, masking the real ELOOP syscall this
    // describe block exists to exercise.
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    statSyncMock.mockReset();
    statSyncMock.mockImplementation(actual.statSync);
    dir = mkdtempSync(join(tmpdir(), "read-guard-eloop-"));
  });

  afterEach(() => {
    statSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A symlink loop is a property of the path itself (unlike EACCES, which
   * is about an ANCESTOR directory's permissions) -- adopt mode must be
   * able to tell "nothing here" (ENOENT) apart from "something here this
   * process could not resolve" (ELOOP, e.g. a loop at `.claude` or
   * `CLAUDE.md`), the same way it already tells EACCES apart from ENOENT.
   * Silently folding ELOOP in beside a genuinely absent path would report a
   * clean "resolves to no file"/"clean add" for a project that actually has
   * something unreadable there.
   */
  it("a symlink loop (ELOOP) is recorded in undetermined (naming the path and ELOOP), answers false, and does not throw", () => {
    const loopA = join(dir, "loop-a");
    const loopB = join(dir, "loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);

    const undetermined: string[] = [];
    let thrown: unknown;
    let result: boolean | undefined;
    try {
      result = guardedExists(loopA, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result).toBe(false);
    expect(undetermined).toHaveLength(1);
    expect(undetermined[0]).toContain(loopA);
    expect(undetermined[0]).toContain("ELOOP");
  });
});

describe("guardedExists -- a genuinely absent path answers false, with nothing recorded, via the real syscall", () => {
  let dir: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    statSyncMock.mockReset();
    statSyncMock.mockImplementation(actual.statSync);
    dir = mkdtempSync(join(tmpdir(), "read-guard-absent-"));
  });

  afterEach(() => {
    statSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a path below a regular file (ENOTDIR) answers false without throwing and records nothing in undetermined", () => {
    const filePath = join(dir, "regular-file");
    writeFileSync(filePath, "x");
    const belowFile = join(filePath, "child");

    const undetermined: string[] = [];
    let thrown: unknown;
    let result: boolean | undefined;
    try {
      result = guardedExists(belowFile, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    expect(result).toBe(false);
    expect(undetermined).toEqual([]);
  });
});
