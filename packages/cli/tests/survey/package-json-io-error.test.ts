// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `readPackageJson` (`internal/package-json.ts`) checks existence with
 * `guardedExists` before ever reading the file. `survey-shape-io-error.test.ts`
 * and `survey-toolchain-io-error.test.ts` already prove a non-permission
 * `readFileSync` failure on `package.json` propagates (`guardedRead`'s own
 * discrimination); neither reaches `guardedExists`'s own `statSync` call,
 * since the file genuinely exists in both fixtures and `statSync` succeeds
 * for real before the mocked `readFileSync` ever throws. This file closes
 * that gap directly against `readPackageJson` itself.
 *
 * `node:fs` is mocked (`importOriginal`-preserving) in this file ONLY,
 * matching the isolation pattern other mocked-`node:fs` siblings use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { readPackageJson } =
  await import("../../src/survey/internal/package-json.js");

describe("readPackageJson -- a non-permission statSync failure on its own existence check propagates, not swallowed", () => {
  let dir: string;
  let realStatSync: typeof FsModule.statSync;
  let targetPath: string;
  const ioFailure = Object.assign(new Error("simulated EIO"), {
    code: "EIO",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realStatSync = actual.statSync;
    statSyncMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "package-json-io-error-"));
    targetPath = join(dir, "package.json");
    writeFileSync(targetPath, JSON.stringify({ name: "acme" }));

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
    statSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws an Error naming package.json's path, with the original EIO failure chained as cause, rather than recording it in undetermined", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      readPackageJson(dir, undetermined);
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
