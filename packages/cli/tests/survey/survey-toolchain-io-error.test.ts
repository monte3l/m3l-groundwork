// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Same discrimination as `survey-shape-io-error.test.ts`, applied to
 * `surveyToolchain`'s own `package.json` read: a non-permission `readFileSync`
 * failure (`EIO`) must propagate as a thrown `Error` with the original
 * failure chained as `cause` and the path in the message, never silently
 * folded into `undetermined` the way `readPackageJson`'s single catch-all
 * does today.
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

const { surveyToolchain } =
  await import("../../src/survey/survey-toolchain.js");

describe("surveyToolchain -- a non-permission readFileSync failure on package.json propagates, not swallowed into undetermined", () => {
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
    dir = mkdtempSync(join(tmpdir(), "toolchain-io-error-"));
    targetPath = join(dir, "package.json");
    writeFileSync(targetPath, JSON.stringify({ name: "acme" }));

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

  it("throws an Error naming package.json's path, with the original EIO failure chained as cause, rather than recording it in undetermined", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      surveyToolchain(dir, undetermined);
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
