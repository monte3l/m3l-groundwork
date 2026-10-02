// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 2's other half for `walkBounded`: a non-permission `readdirSync`
 * failure (`EIO`, `EMFILE`) is not a property of the directory the way
 * `EACCES`/`EPERM` is -- today `walkBounded`'s catch-all swallows it
 * silently (`return;`, same as a genuinely missing directory). It must
 * instead propagate as a thrown `Error`, with the original failure chained
 * as `cause` and the directory's path named in the message.
 *
 * `node:fs` is mocked (`importOriginal`-preserving) in this file ONLY,
 * matching the isolation pattern other mocked-`node:fs` siblings use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readdirSyncMock } = vi.hoisted(() => ({
  readdirSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, readdirSync: readdirSyncMock };
});

const { walkBounded } = await import("../../src/survey/fs-walk.js");

describe("walkBounded -- a non-permission readdirSync failure propagates, not swallowed", () => {
  let dir: string;
  let realReaddirSync: typeof FsModule.readdirSync;
  let targetDir: string;
  const ioFailure = Object.assign(new Error("simulated EMFILE"), {
    code: "EMFILE",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReaddirSync = actual.readdirSync;
    readdirSyncMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "walk-io-error-"));
    targetDir = join(dir, "locked");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "secret.md"), "# secret\n");

    readdirSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.readdirSync>) => {
        const [path] = args;
        if (path === targetDir) {
          throw ioFailure;
        }
        return (
          realReaddirSync as (
            ...callArgs: Parameters<typeof FsModule.readdirSync>
          ) => ReturnType<typeof FsModule.readdirSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    readdirSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws an Error naming the directory's path, with the original EMFILE failure chained as cause, rather than silently skipping it", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      walkBounded(dir, 3, undetermined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(ioFailure);
    expect((thrown as Error).message).toContain(targetDir);
    expect((thrown as Error).cause).toBe(ioFailure);
    expect(undetermined).toEqual([]);
  });
});
