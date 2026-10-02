// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2's other half for `surveyDocs`: a non-permission `readFileSync`
 * failure (`EIO`) reading an indexed doc must propagate as a thrown `Error`,
 * with the original failure chained as `cause` and the path named in the
 * message -- never silently recorded in `undetermined` alongside a genuine
 * permission problem.
 *
 * `node:fs` is mocked (`importOriginal`-preserving) in this file ONLY,
 * matching the isolation pattern other mocked-`node:fs` siblings use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { surveyDocs } = await import("../../src/survey/survey-docs.js");

describe("surveyDocs -- a non-permission readFileSync failure propagates, not swallowed", () => {
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
    dir = mkdtempSync(join(tmpdir(), "docs-io-error-"));
    targetPath = join(dir, "README.md");
    writeFileSync(targetPath, "# Title\n");

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

  it("throws an Error naming README.md's path, with the original EIO failure chained as cause, rather than recording it in undetermined", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      surveyDocs(dir, undetermined);
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
