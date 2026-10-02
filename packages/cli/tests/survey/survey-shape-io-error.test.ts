// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `readPackageJson` (`survey-shape.ts`) wraps `readFileSync` and `JSON.parse`
 * in ONE try/catch today, so it already (by accident) swallows a
 * non-permission `readFileSync` failure (`EIO`) the same way it swallows a
 * genuine `EACCES` -- both land in `undetermined` as "could not parse".
 * GAP 2 requires discriminating the two: `EIO` is not a property of the
 * file the way `EACCES`/`EPERM` is, and must propagate as a thrown `Error`
 * with the original failure chained as `cause` and the path in the message,
 * never silently folded into `undetermined`.
 *
 * `node:fs` is mocked (`importOriginal`-preserving) in this file ONLY,
 * matching the isolation pattern other mocked-`node:fs` siblings use (see
 * `pack-stage-statsync-plan-error.test.ts`).
 *
 * The second `describe` below covers the same discrimination one layer
 * earlier: `detectPackageManager`'s `guardedExists(pnpm-lock.yaml)` call
 * (reached after `readPackageJson` and `detectMonorepo`'s own `guardedExists`
 * probes, all against an empty fixture directory so each answers `false` for
 * real) must propagate a non-permission `statSync` failure too -- the first
 * `describe`'s `readFileSync` mock never reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { surveyShape } = await import("../../src/survey/survey-shape.js");

describe("surveyShape -- a non-permission readFileSync failure on package.json propagates, not swallowed into undetermined", () => {
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
    dir = mkdtempSync(join(tmpdir(), "shape-io-error-"));
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
    statSyncMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws an Error naming package.json's path, with the original EIO failure chained as cause, rather than recording it in undetermined", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      surveyShape(dir, undetermined);
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

describe("surveyShape -- a non-permission statSync failure on guardedExists's own existence check propagates, not swallowed", () => {
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
    // An empty fixture directory: no package.json, pnpm-workspace.yaml,
    // turbo.json, nx.json, or lerna.json, so every `guardedExists` probe
    // ahead of `detectPackageManager`'s own answers `false` for real (ENOENT)
    // before the mocked statSync ever throws for the targeted path.
    dir = mkdtempSync(join(tmpdir(), "shape-exists-io-error-"));
    targetPath = join(dir, "pnpm-lock.yaml");

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

  it("throws an Error naming pnpm-lock.yaml's path, with the original EIO failure chained as cause, rather than recording it in undetermined", () => {
    const undetermined: string[] = [];
    let thrown: unknown;
    try {
      surveyShape(dir, undetermined);
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
