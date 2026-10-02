// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2's other half: a non-permission errno (`EIO`, a failing disk; `EMFILE`,
 * too many open files) reading a `.claude/` project file is NOT a property of
 * that file the way `EACCES`/`EPERM` is -- it must still surface as a thrown
 * `Error`, with the original failure chained as `cause` and the path named in
 * the message, never silently swallowed into `undetermined` alongside a
 * genuine permission problem. `node:fs` is mocked (`importOriginal`-preserving)
 * in this file ONLY, matching the isolation pattern every other mocked-`node:fs`
 * sibling test in this package uses (see `pack-stage-statsync-plan-error.test.ts`) --
 * mixing it with `survey-harness-unreadable.test.ts`'s real chmod-based reads
 * would make the mock intercept those too.
 *
 * The second `describe` below covers the same discrimination one layer
 * earlier: `guardedExists`'s own `statSync` call (`surveyHarness`'s very
 * first read, on `CLAUDE.md`) must propagate a non-permission failure too --
 * the first `describe`'s `readFileSync` mock never reaches it, since every
 * path it exercises genuinely exists on disk and `statSync` succeeds for
 * real before the mocked `readFileSync` ever throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readFileSyncMock, statSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    readFileSync: readFileSyncMock,
    statSync: statSyncMock,
  };
});

const { surveyHarness } = await import("../../src/survey/survey-harness.js");

describe("surveyHarness -- a non-permission readFileSync failure propagates, not swallowed", () => {
  let dir: string;
  let realReadFileSync: typeof FsModule.readFileSync;
  let targetPath: string;
  const ioFailure = Object.assign(new Error("simulated EIO"), {
    code: "EIO",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReadFileSync = actual.readFileSync;
    readFileSyncMock.mockReset();
    // statSync is mocked for the whole file (see the top-level `vi.mock`
    // above, shared with the second `describe` below) -- pass through to the
    // real syscall here so this describe's own `guardedExists` calls behave
    // exactly as they would unmocked.
    statSyncMock.mockReset();
    statSyncMock.mockImplementation(actual.statSync);
    dir = mkdtempSync(join(tmpdir(), "harness-io-error-"));
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    targetPath = join(dir, ".claude", "agents", "reviewer.md");
    writeFileSync(targetPath, "---\nmodel: sonnet\n---\n# reviewer\n");

    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.readFileSync>) => {
        const [path] = args;
        if (path === targetPath) {
          throw ioFailure;
        }
        return (
          realReadFileSync as (
            ...callArgs: Parameters<typeof FsModule.readFileSync>
          ) => ReturnType<typeof FsModule.readFileSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    statSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws an Error naming the path, with the original EIO failure chained as cause, rather than recording it in undetermined", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(ioFailure);
    expect((thrown as Error).message).toContain(targetPath);
    expect((thrown as Error).cause).toBe(ioFailure);
  });
});

describe("surveyHarness -- a non-permission statSync failure on guardedExists's own existence check propagates, not swallowed", () => {
  let dir: string;
  let realStatSync: typeof FsModule.statSync;
  let targetPath: string;
  const ioFailure = Object.assign(new Error("simulated EIO"), {
    code: "EIO",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realStatSync = actual.statSync;
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(actual.readFileSync);
    statSyncMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "harness-exists-io-error-"));
    targetPath = join(dir, "CLAUDE.md");
    writeFileSync(targetPath, "# Title\n");

    statSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.statSync>) => {
        const [path] = args;
        if (path === targetPath) {
          throw ioFailure;
        }
        return (
          realStatSync as (
            ...callArgs: Parameters<typeof FsModule.statSync>
          ) => ReturnType<typeof FsModule.statSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    statSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws an Error naming CLAUDE.md's path, with the original EIO failure chained as cause, rather than recording it in undetermined", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      surveyHarness(dir, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(ioFailure);
    expect((thrown as Error).message).toContain(targetPath);
    expect((thrown as Error).cause).toBe(ioFailure);
    expect(undetermined).toEqual([]);
  });
});
