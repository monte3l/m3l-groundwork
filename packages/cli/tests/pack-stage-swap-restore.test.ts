// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stagePacks`' atomic-swap restore branch: when the final rename of
 * the new `packs/` staging directory into place fails, a previously-staged
 * `packs/` must be restored rather than left parked or missing, and the
 * thrown error must chain the rename failure as its `cause`. `node:fs`'s
 * `renameSync` is mocked (importOriginal-preserving) in this file ONLY,
 * matching the isolation `baseline-stage-swap-restore.test.ts` uses for the
 * same export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pack } from "../src/packs.js";

const { renameSyncMock } = vi.hoisted(() => ({ renameSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, renameSync: renameSyncMock };
});

const { stagePacks } = await import("../src/pack-stage.js");

function makePack(name: string, filesDir: string): Pack {
  return {
    manifest: {
      schemaVersion: 1,
      name,
      description: "a test pack",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      requires: undefined,
      wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      adoptNotes: undefined,
    },
    filesDir,
  };
}

describe("stagePacks -- atomic swap restore", () => {
  let filesRoot: string;
  let groundworkDir: string;
  let realRenameSync: typeof FsModule.renameSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRenameSync = actual.renameSync;
    renameSyncMock.mockReset();
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) =>
        realRenameSync(...args),
    );
    filesRoot = mkdtempSync(join(tmpdir(), "pack-swap-restore-files-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "pack-swap-restore-gw-"));
  });

  afterEach(() => {
    renameSyncMock.mockReset();
    rmSync(filesRoot, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("restores the previous packs/ and chains the rename failure as cause when the final swap rename fails", () => {
    writeFileSync(join(filesRoot, "first.txt"), "first\n");
    const firstStaged = stagePacks(
      [makePack("first-pack", filesRoot)],
      groundworkDir,
      {},
    );
    const packsDir = join(groundworkDir, "packs");
    const firstStagedName = firstStaged[0]?.files[0]?.staged ?? "";
    expect(
      readFileSync(
        join(packsDir, "first-pack", "files", firstStagedName),
        "utf8",
      ),
    ).toBe("first\n");

    const renameFailure = new Error("simulated rename failure");
    let callCount = 0;
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => {
        callCount += 1;
        if (callCount === 2) {
          throw renameFailure;
        }
        return realRenameSync(...args);
      },
    );

    writeFileSync(join(filesRoot, "second.txt"), "second\n");

    let thrown: unknown;
    try {
      stagePacks([makePack("first-pack", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(renameFailure);
    expect((thrown as Error).message).toContain(".groundwork/");
    expect((thrown as Error).message).toContain("re-run");

    expect(
      readFileSync(
        join(packsDir, "first-pack", "files", firstStagedName),
        "utf8",
      ),
    ).toBe("first\n");
  });

  it("throws an AggregateError carrying both the swap failure and the restore failure when the restore rename ALSO fails, leaving the parked previous packs/ intact and naming where it was parked", () => {
    writeFileSync(join(filesRoot, "first.txt"), "first\n");
    const firstStaged = stagePacks(
      [makePack("first-pack", filesRoot)],
      groundworkDir,
      {},
    );
    const packsDir = join(groundworkDir, "packs");
    const firstStagedName = firstStaged[0]?.files[0]?.staged ?? "";

    const swapFailure = new Error("simulated final-swap failure");
    const restoreFailure = new Error("simulated restore failure");
    let callCount = 0;
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => {
        callCount += 1;
        if (callCount === 2) throw swapFailure;
        if (callCount === 3) throw restoreFailure;
        return realRenameSync(...args);
      },
    );

    writeFileSync(join(filesRoot, "second.txt"), "second\n");

    let thrown: unknown;
    try {
      stagePacks([makePack("first-pack", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toEqual([swapFailure, restoreFailure]);
    expect(aggregate.message).toContain("re-run");
    expect(aggregate.message).not.toContain("by hand");
    // "packs" is plural; the message must read grammatically ("were
    // parked"), not baseline-stage.ts's singular-mass-noun phrasing ("the
    // previous baseline was parked") copied verbatim onto a plural noun.
    expect(aggregate.message).toMatch(/previous (staged )?packs were parked/);

    expect(existsSync(packsDir)).toBe(false);
    const parkedDirs = readdirSync(groundworkDir).filter(
      (name) => name !== "packs",
    );
    expect(parkedDirs.length).toBeGreaterThan(0);
    const parkedFile = join(
      groundworkDir,
      parkedDirs[0] ?? "",
      "previous",
      "first-pack",
      "files",
      firstStagedName,
    );
    expect(readFileSync(parkedFile, "utf8")).toBe("first\n");
  });

  it("rethrows the rename failure directly (wrapped in the standard incomplete/re-run Error, no restore attempted) when the final rename fails and there is NO previous packs/ to restore", () => {
    const packsDir = join(groundworkDir, "packs");
    expect(existsSync(packsDir)).toBe(false);

    const renameFailure = new Error("simulated first-ever swap failure");
    renameSyncMock.mockImplementation(() => {
      throw renameFailure;
    });

    writeFileSync(join(filesRoot, "only.txt"), "same\n");

    let thrown: unknown;
    try {
      stagePacks([makePack("only-pack", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(AggregateError);
    expect((thrown as Error).cause).toBe(renameFailure);
    const message = (thrown as Error).message;
    expect(message).toContain(".groundwork/");
    expect(message).toContain("incomplete");
    expect(message).toContain("re-run");
    expect(message).toContain(renameFailure.message);

    expect(existsSync(packsDir)).toBe(false);
    expect(readdirSync(groundworkDir)).toEqual([]);
  });
});
