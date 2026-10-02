// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `compareFile` (`conflicts.ts`) calls a bare `readFileSync` on the
 * project's target file once it has established (via `existsSync`) that the
 * file exists. An `EACCES`/`EPERM` on that read is a property of the
 * project file itself and must land as a "divergent" conflict rather than
 * throwing (see `conflicts.test.ts`'s own permission-based suite); any OTHER
 * read failure (`EIO`, say) says something about the machine, not the
 * project, and must propagate as a thrown `Error` naming the target path,
 * with the original failure chained as `cause`. `node:fs`'s `readFileSync`
 * is mocked (`importOriginal`-preserving) in this file ONLY, matching the
 * isolation pattern every other mocked-`node:fs` sibling file uses (see
 * `pack-stage-statsync-plan-error.test.ts`).
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

const { planConflicts } = await import("../src/conflicts.js");

describe("planConflicts -- a non-permission readFileSync failure on the target file propagates, not folded into a conflict", () => {
  let templateRoot: string;
  let targetDir: string;
  let targetPath: string;
  let realReadFileSync: typeof FsModule.readFileSync;
  const ioFailure = Object.assign(new Error("simulated EIO"), {
    code: "EIO",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReadFileSync = actual.readFileSync;
    readFileSyncMock.mockReset();
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-io-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-io-target-"));
    writeFileSync(join(templateRoot, "README.md"), "# body\n");
    targetPath = join(targetDir, "README.md");
    writeFileSync(targetPath, "# body\n");

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
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("throws an Error naming the target path, with the original EIO failure chained as cause", () => {
    let thrown: unknown;
    try {
      planConflicts(templateRoot, targetDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(ioFailure);
    expect((thrown as Error).message).toContain(targetPath);
    expect((thrown as Error).cause).toBe(ioFailure);
  });
});
