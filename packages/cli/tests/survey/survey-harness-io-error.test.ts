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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, readFileSync: readFileSyncMock };
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
