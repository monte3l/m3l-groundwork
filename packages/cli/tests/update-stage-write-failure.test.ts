// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--update`'s write-failure paths, mirroring `add-pack-stage-write-failure`:
 * a write failing mid-staging leaves any previous `.groundwork/update/`
 * byte-identical (or absent), no work dir behind and nothing else in the
 * project changed; `plan.json` is written LAST. `node:fs`'s `writeFileSync`
 * is mocked (importOriginal-preserving) in this file ONLY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { causeChain, snapshotTree, subtreeOf } from "./add-pack-fixtures.js";
import { olderProject, updateDeps } from "./update-fixtures.js";

const { writeFileSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, writeFileSync: writeFileSyncMock };
});

const { runUpdate } = await import("../src/update.js");

const writeFailure = new Error("simulated disk full");
const normalized = (path: string): string => path.split("\\").join("/");

describe("--update write failures", () => {
  let root: string;
  let dir: string;
  let realWriteFileSync: typeof FsModule.writeFileSync;
  let failWhen: (path: string) => boolean;
  let written: string[];

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteFileSync = actual.writeFileSync;
    failWhen = () => false;
    written = [];
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.writeFileSync>) => {
        const [path] = args;
        if (typeof path === "string") {
          const posix = normalized(path);
          // Only the staging area is watched: fixtures write elsewhere.
          if (posix.includes("/.groundwork/.update-")) written.push(posix);
          if (posix.includes("/.groundwork/") && failWhen(posix)) {
            throw writeFailure;
          }
        }
        return realWriteFileSync(...args);
      },
    );
    root = mkdtempSync(join(tmpdir(), "update-write-failure-"));
    dir = join(root, "project");
    olderProject(dir, join(root, "pristine"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    writeFileSyncMock.mockReset();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function attempt(): unknown {
    try {
      runUpdate({ targetDir: dir }, updateDeps());
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const groundworkEntries = (): string[] =>
    readdirSync(join(dir, ".groundwork")).sort();

  it("writes plan.json LAST, exactly once", () => {
    expect(attempt()).toBeUndefined();
    expect(written.length).toBeGreaterThanOrEqual(5);
    expect(written.at(-1)).toMatch(/\/plan\.json$/);
    expect(written.filter((p) => p.endsWith("/plan.json"))).toHaveLength(1);
  });

  it("leaves no update directory and no work dir when plan.json fails, chaining the cause", () => {
    failWhen = (p) => p.endsWith("/plan.json");
    const before = snapshotTree(dir);
    const thrown = attempt();
    expect(thrown).toBeInstanceOf(Error);
    expect(causeChain(thrown)).toContain(writeFailure);
    expect((thrown as Error).message).toContain(writeFailure.message);
    expect(existsSync(join(dir, ".groundwork/update"))).toBe(false);
    expect(groundworkEntries().filter((n) => n.startsWith(".update-"))).toEqual(
      [],
    );
    expect(snapshotTree(dir)).toEqual(before);
  });

  it("leaves a previous update/ byte-identical when a later write fails", () => {
    expect(attempt()).toBeUndefined();
    const previous = subtreeOf(snapshotTree(dir), ".groundwork/update");
    expect(Object.keys(previous).length).toBeGreaterThan(5);

    failWhen = (p) => p.endsWith("lock-next.json");
    const thrown = attempt();
    expect(thrown).toBeInstanceOf(Error);
    expect(causeChain(thrown)).toContain(writeFailure);
    expect(subtreeOf(snapshotTree(dir), ".groundwork/update")).toEqual(
      previous,
    );
    expect(groundworkEntries().filter((n) => n.startsWith(".update-"))).toEqual(
      [],
    );
  });

  it("does not claim adopt's '.groundwork/ is incomplete' re-run advice", () => {
    failWhen = (p) => p.endsWith("/plan.json");
    const thrown = attempt();
    for (const link of [thrown, ...causeChain(thrown)]) {
      const message = link instanceof Error ? link.message : String(link);
      expect(message).not.toContain(".groundwork/ is incomplete");
    }
  });
});
