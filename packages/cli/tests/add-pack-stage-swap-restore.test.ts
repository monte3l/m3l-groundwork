// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--add-pack`'s atomic-swap restore branch, mirroring
 * `pack-stage-swap-restore`: when the rename of a freshly staged
 * `add-pack/<name>/` into place fails, the previous one is renamed back and
 * the rename failure is chained as `cause`; if the restore ALSO fails the
 * error is an AggregateError and the previous copy survives parked in the
 * work dir. Only the final move of `<work>/<name>` onto
 * `.groundwork/add-pack/<name>` is failed, by path, never by call count.
 * `node:fs`'s `renameSync` is mocked (importOriginal-preserving) here ONLY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapInto,
  causeChain,
  snapshotTree,
  subtreeOf,
} from "./add-pack-fixtures.js";

const { renameSyncMock } = vi.hoisted(() => ({ renameSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, renameSync: renameSyncMock };
});

const { main } = await import("../src/main.js");

const posix = (path: string): string => path.split("\\").join("/");

describe("--add-pack atomic swap restore", () => {
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
    root = mkdtempSync(join(tmpdir(), "add-pack-swap-restore-"));
    dir = join(root, "project");
    bootstrapInto(dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    renameSyncMock.mockReset();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** True for the final move of a staged pack onto its destination. */
  const isFinalSwap = (from: string, to: string): boolean =>
    posix(to).endsWith("/.groundwork/add-pack/quality") &&
    /\/\.quality-[^/]+\/quality$/.test(posix(from));

  function attempt(): unknown {
    try {
      main([dir, "--add-pack", "quality"]);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("restores the previous add-pack/<name>/ byte-identically and chains the rename failure as cause when the final swap fails", () => {
    expect(attempt()).toBeUndefined();
    const previous = subtreeOf(
      snapshotTree(dir),
      ".groundwork/add-pack/quality",
    );
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
    expect(
      subtreeOf(snapshotTree(dir), ".groundwork/add-pack/quality"),
    ).toEqual(previous);
    // No work dir is left behind and nothing else moved.
    expect(
      readdirSync(join(dir, ".groundwork/add-pack")).filter((n) =>
        n.startsWith("."),
      ),
    ).toEqual([]);
    const after = snapshotTree(dir);
    for (const [key, value] of Object.entries(outside)) {
      expect(after[key], key).toBe(value);
    }
  });

  it("throws an AggregateError of both failures, naming the parked copy, when the restore also fails; the previous copy survives in the work dir", () => {
    expect(attempt()).toBeUndefined();
    const previousFiles = Object.keys(
      subtreeOf(snapshotTree(dir), ".groundwork/add-pack/quality"),
    ).length;

    const swapFailure = new Error("simulated final-swap failure");
    const restoreFailure = new Error("simulated restore failure");
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.renameSync>) => {
        const [from, to] = [String(args[0]), String(args[1])];
        if (isFinalSwap(from, to)) throw swapFailure;
        if (
          posix(from).endsWith("/previous") &&
          posix(to).endsWith("/.groundwork/add-pack/quality")
        ) {
          throw restoreFailure;
        }
        return realRename(...args);
      },
    );
    const thrown = attempt();

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      swapFailure,
      restoreFailure,
    ]);
    expect(existsSync(join(dir, ".groundwork/add-pack/quality"))).toBe(false);
    expect((thrown as Error).message).not.toContain(
      ".groundwork/ is incomplete",
    );
    const parked = readdirSync(join(dir, ".groundwork/add-pack")).filter((n) =>
      n.startsWith(".quality-"),
    );
    expect(parked).toHaveLength(1);
    const parkedTree = snapshotTree(
      join(dir, ".groundwork/add-pack", parked[0] ?? "", "previous"),
    );
    // The parked copy's location stays visible in the message or the cause chain.
    const visible = [
      (thrown as Error).message,
      ...causeChain(thrown).map((link) =>
        link instanceof Error ? link.message : String(link),
      ),
      ...(thrown as AggregateError).errors.map((link: unknown) =>
        link instanceof Error ? link.message : String(link),
      ),
    ]
      .join("\n")
      .split("\\")
      .join("/");
    expect(visible).toContain(`.groundwork/add-pack/${parked[0] ?? ""}`);
    expect(Object.keys(parkedTree).length).toBe(previousFiles - 1); // the root itself is not an entry
  });

  it("wraps the rename failure when there is NO previous copy to restore, leaving no pack directory", () => {
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
    expect(existsSync(join(dir, ".groundwork/add-pack/quality"))).toBe(false);
  });
});
