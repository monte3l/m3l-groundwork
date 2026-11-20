// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `writeManifest`'s failure branch: when the final temp -> manifest
 * rename fails and removing the leftover `manifest.json.tmp` fails too, the
 * leftover is reported with `console.warn` (not swallowed) and the original
 * failure is still the error thrown. `node:fs`'s `renameSync` and `rmSync`
 * are mocked (importOriginal-preserving) in this file ONLY, the same
 * isolation `inventory-write-failure.test.ts` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../src/manifest.js";

const { renameSyncMock, rmSyncMock } = vi.hoisted(() => ({
  renameSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, renameSync: renameSyncMock, rmSync: rmSyncMock };
});

const { ManifestError, readManifest, writeManifest } =
  await import("../src/manifest.js");

const MANIFEST: Manifest = {
  schemaVersion: 1,
  cliVersion: "1.2.3",
  tokens: { PROJECT_NAME: "widgets", YEAR: "2026" },
  packs: [],
  files: { "a.txt": { sha256: "a".repeat(64), origin: "emitted" } },
  jsonKeys: {},
};

describe("writeManifest -- rename failure", () => {
  let dir: string;
  let realRenameSync: typeof FsModule.renameSync;
  let realRmSync: typeof FsModule.rmSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRenameSync = actual.renameSync;
    realRmSync = actual.rmSync;
    renameSyncMock.mockReset();
    rmSyncMock.mockReset();
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) =>
        realRenameSync(...args),
    );
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => realRmSync(...args),
    );
    dir = mkdtempSync(join(tmpdir(), "manifest-write-failure-"));
  });

  afterEach(() => {
    renameSyncMock.mockReset();
    rmSyncMock.mockReset();
    vi.restoreAllMocks();
    realRmSync(dir, { recursive: true, force: true });
  });

  it("leaves an existing manifest untouched and no temp file when the rename fails", () => {
    writeManifest(dir, MANIFEST);
    const before = readManifest(dir);

    const renameFailure = new Error("simulated rename failure");
    renameSyncMock.mockImplementation(() => {
      throw renameFailure;
    });
    let thrown: unknown;
    try {
      writeManifest(dir, { ...MANIFEST, cliVersion: "9.9.9" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    expect((thrown as Error).cause).toBe(renameFailure);
    expect(readManifest(dir)).toEqual(before);
    expect(existsSync(join(dir, ".groundwork", "manifest.json.tmp"))).toBe(
      false,
    );
  });

  it("warns with the thrown value itself when the cleanup failure is not an Error, still throwing the original failure", () => {
    const tmpPath = join(dir, ".groundwork", "manifest.json.tmp");
    const renameFailure = new Error("simulated rename failure");
    renameSyncMock.mockImplementation(() => {
      throw renameFailure;
    });
    let rmCalls = 0;
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => {
        if (args[0] === tmpPath) {
          rmCalls += 1;
          if (rmCalls > 1) {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the warning copes with an unnormalized cleanup failure
            throw "disk on fire";
          }
        }
        return realRmSync(...args);
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let thrown: unknown;
    try {
      writeManifest(dir, MANIFEST);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestError);
    expect((thrown as Error).cause).toBe(renameFailure);
    const lines = warnSpy.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines.some((line) => line.includes(tmpPath))).toBe(true);
    expect(lines.some((line) => line.includes("disk on fire"))).toBe(true);
  });

  it("warns naming the leftover temp path when removing it fails, and still throws the original failure", () => {
    const tmpPath = join(dir, ".groundwork", "manifest.json.tmp");
    const renameFailure = new Error("simulated rename failure");
    renameSyncMock.mockImplementation(() => {
      throw renameFailure;
    });
    let rmCalls = 0;
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => {
        if (args[0] === tmpPath) {
          rmCalls += 1;
          // The first call is the pre-write clearing of a stale temp file and
          // must work; only the catch block's cleanup fails.
          if (rmCalls > 1) throw new Error("simulated tmp removal failure");
        }
        return realRmSync(...args);
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let thrown: unknown;
    try {
      writeManifest(dir, MANIFEST);
    } catch (error) {
      thrown = error;
    }

    expect(rmCalls).toBeGreaterThan(1);
    expect(thrown).toBeInstanceOf(ManifestError);
    expect((thrown as Error).cause).toBe(renameFailure);
    expect(
      warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes(tmpPath)),
      ),
    ).toBe(true);
  });
});
