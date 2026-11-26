// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--update`'s atomic-swap restore branch, mirroring
 * `add-pack-stage-swap-restore`: when the rename of a freshly staged
 * `update/` into place fails, the previous one is renamed back and the
 * failure chained as `cause`; if the restore also fails the error is an
 * AggregateError and the previous copy survives parked in the work dir.
 * `node:fs`'s `renameSync` is mocked (importOriginal-preserving) here ONLY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { causeChain, snapshotTree, subtreeOf } from "./add-pack-fixtures.js";
import { olderProject, updateDeps } from "./update-fixtures.js";

const { renameSyncMock } = vi.hoisted(() => ({ renameSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, renameSync: renameSyncMock };
});

const { runUpdate } = await import("../src/update.js");

const posix = (path: string): string => path.split("\\").join("/");

describe("--update atomic swap restore", () => {
  let root: string;
  let dir: string;
  let realRename: typeof FsModule.renameSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRename = actual.renameSync;
    renameSyncMock.mockReset();
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => realRename(...args),
    );
    root = mkdtempSync(join(tmpdir(), "update-swap-restore-"));
    dir = join(root, "project");
    olderProject(dir, join(root, "pristine"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    renameSyncMock.mockReset();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** True for the final move of the staged tree onto `.groundwork/update`. */
  const isFinalSwap = (from: string, to: string): boolean =>
    posix(to).endsWith("/.groundwork/update") &&
    /\/\.update-[^/]+\/update$/.test(posix(from));

  function attempt(): unknown {
    try {
      runUpdate({ targetDir: dir }, updateDeps());
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("restores the previous update/ byte-identically and chains the failure when the final swap fails", () => {
    expect(attempt()).toBeUndefined();
    const previous = subtreeOf(snapshotTree(dir), ".groundwork/update");
    const outside = snapshotTree(dir);

    const renameFailure = new Error("simulated rename failure");
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => {
        if (isFinalSwap(String(args[0]), String(args[1]))) throw renameFailure;
        return realRename(...args);
      },
    );
    const thrown = attempt();

    expect(thrown).toBeInstanceOf(Error);
    expect(causeChain(thrown)).toContain(renameFailure);
    expect(subtreeOf(snapshotTree(dir), ".groundwork/update")).toEqual(
      previous,
    );
    expect(
      readdirSync(join(dir, ".groundwork")).filter((n) =>
        n.startsWith(".update-"),
      ),
    ).toEqual([]);
    expect(snapshotTree(dir)).toEqual(outside);
  });

  it("throws an AggregateError of both failures and parks the previous copy when the restore also fails", () => {
    expect(attempt()).toBeUndefined();
    const swapFailure = new Error("simulated final-swap failure");
    const restoreFailure = new Error("simulated restore failure");
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => {
        const [from, to] = [String(args[0]), String(args[1])];
        if (isFinalSwap(from, to)) throw swapFailure;
        if (
          posix(from).endsWith("/previous") &&
          posix(to).endsWith("/.groundwork/update")
        ) {
          throw restoreFailure;
        }
        return realRename(...args);
      },
    );
    const thrown = attempt();

    expect(thrown).toBeInstanceOf(AggregateError);
    // The advice is --update's own, not the generic "re-run the CLI".
    expect((thrown as AggregateError).message).toMatch(/re-run with --update/);
    expect((thrown as AggregateError).message).not.toMatch(/re-run the CLI/);
    expect((thrown as AggregateError).errors).toEqual([
      swapFailure,
      restoreFailure,
    ]);
    expect(existsSync(join(dir, ".groundwork/update"))).toBe(false);
    const parked = readdirSync(join(dir, ".groundwork")).filter((n) =>
      n.startsWith(".update-"),
    );
    expect(parked).toHaveLength(1);
    expect(
      existsSync(join(dir, ".groundwork", parked[0] ?? "", "previous")),
    ).toBe(true);
  });

  it("wraps the rename failure when there is no previous copy, leaving no update directory", () => {
    const renameFailure = new Error("simulated first-ever swap failure");
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => {
        if (isFinalSwap(String(args[0]), String(args[1]))) throw renameFailure;
        return realRename(...args);
      },
    );
    const thrown = attempt();
    expect(thrown).toBeInstanceOf(Error);
    expect(causeChain(thrown)).toContain(renameFailure);
    expect(existsSync(join(dir, ".groundwork/update"))).toBe(false);
  });
});
