// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--add-pack`'s write-failure paths, mirroring `pack-stage-write-failure`:
 * a write that fails mid-pack must leave any previous `add-pack/<name>/`
 * intact and no work dir behind; `plan.json` is written LAST, so a pack
 * directory has a `plan.json` iff its staging completed; and a failure on
 * pack k leaves packs 1..k-1 fully staged, with the error naming which packs
 * were staged and which were not. `node:fs`'s `writeFileSync` is mocked
 * (importOriginal-preserving) in this file ONLY; the real one runs unless a
 * test arms `failWhen`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssertionError } from "node:assert/strict";
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

const { writeFileSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, writeFileSync: writeFileSyncMock };
});

const { main } = await import("../src/main.js");

const writeFailure = new Error("simulated disk full");
const normalized = (path: string): string => path.split("\\").join("/");

describe("--add-pack write failures", () => {
  let root: string;
  let dir: string;
  let realWriteFileSync: typeof FsModule.writeFileSync;
  let failWhen: (path: string) => boolean;
  let failWith: unknown;
  let written: string[];

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteFileSync = actual.writeFileSync;
    failWhen = () => false;
    failWith = writeFailure;
    written = [];
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.writeFileSync>) => {
        const [path] = args;
        if (typeof path === "string") {
          const posix = normalized(path);
          if (posix.includes("/.groundwork/add-pack/")) written.push(posix);
          if (failWhen(posix)) throw failWith;
        }
        return realWriteFileSync(...args);
      },
    );
    root = mkdtempSync(join(tmpdir(), "add-pack-write-failure-"));
    dir = join(root, "project");
    bootstrapInto(dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    writeFileSyncMock.mockReset();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function attempt(argv: string[]): unknown {
    try {
      main([dir, ...argv]);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const addPackEntries = (): string[] =>
    existsSync(join(dir, ".groundwork/add-pack"))
      ? readdirSync(join(dir, ".groundwork/add-pack")).sort()
      : [];

  it("writes plan.json LAST: every other staged file of a pack is written before it", () => {
    expect(attempt(["--add-pack", "quality"])).toBeUndefined();
    const writes = written.filter((p) => p.includes("/.quality-"));
    expect(writes.length).toBeGreaterThanOrEqual(5); // manifest + 3 files + plan.json
    expect(writes.at(-1)).toMatch(/\/plan\.json$/);
    expect(writes.filter((p) => p.endsWith("/plan.json"))).toHaveLength(1);
  });

  it("leaves no pack directory and no work dir when plan.json itself fails to write, and wraps the cause", () => {
    failWhen = (p) =>
      p.includes("/.groundwork/add-pack/") && p.endsWith("/plan.json");
    const before = snapshotTree(dir);
    const thrown = attempt(["--add-pack", "quality"]);

    expect(thrown).toBeInstanceOf(Error);
    expect(causeChain(thrown)).toContain(writeFailure);
    expect((thrown as Error).message).toContain(writeFailure.message);
    expect(addPackEntries().filter((n) => !n.startsWith("."))).toEqual([]);
    expect(addPackEntries()).toEqual([]);
    // Nothing outside .groundwork/add-pack changed.
    const after = snapshotTree(dir);
    for (const [key, value] of Object.entries(before)) {
      expect(after[key], key).toBe(value);
    }
  });

  it("leaves a previous add-pack/<name>/ byte-identical when a file write fails mid-pack, with no work dir left", () => {
    expect(attempt(["--add-pack", "quality"])).toBeUndefined();
    const previous = subtreeOf(
      snapshotTree(dir),
      ".groundwork/add-pack/quality",
    );
    expect(Object.keys(previous).length).toBeGreaterThan(5);

    failWhen = (p) =>
      p.includes("/.groundwork/add-pack/") &&
      p.endsWith("file-budget-baseline.json.staged");
    const thrown = attempt(["--add-pack", "quality"]);

    expect(thrown).toBeInstanceOf(Error);
    expect(causeChain(thrown)).toContain(writeFailure);
    expect(
      subtreeOf(snapshotTree(dir), ".groundwork/add-pack/quality"),
    ).toEqual(previous);
    expect(addPackEntries()).toEqual(["quality"]);
  });

  it("a failure on pack k leaves packs 1..k-1 fully staged (plan.json present) and names staged vs not staged packs", () => {
    failWhen = (p) =>
      p.includes("/.groundwork/add-pack/") &&
      p.endsWith("statusline.mjs.staged");
    const before = snapshotTree(dir);
    const thrown = attempt([
      "--add-pack",
      "quality",
      "--add-pack",
      "statusline",
    ]);

    expect(thrown).toBeInstanceOf(Error);
    expect(causeChain(thrown)).toContain(writeFailure);
    const message = (thrown as Error).message;
    expect(message).toContain("quality");
    expect(message).toContain("statusline");
    expect(message).toMatch(/not staged/);
    expect(message).toMatch(/staged/);

    // quality is complete, statusline left nothing.
    expect(
      existsSync(join(dir, ".groundwork/add-pack/quality/plan.json")),
    ).toBe(true);
    expect(
      existsSync(
        join(
          dir,
          ".groundwork/add-pack/quality/files/bin/check-file-budget.mjs.staged",
        ),
      ),
    ).toBe(true);
    expect(addPackEntries()).toEqual(["quality"]);
    const after = snapshotTree(dir);
    for (const [key, value] of Object.entries(before)) {
      expect(after[key], key).toBe(value);
    }
  });

  it("keeps an AssertionError (a bug) an AssertionError, but as a new error naming staged vs not staged, with the original as cause", () => {
    const bug = new AssertionError({ message: "simulated invariant breach" });
    failWith = bug;
    failWhen = (p) =>
      p.includes("/.groundwork/add-pack/") && p.endsWith("/plan.json");
    const thrown = attempt(["--add-pack", "quality"]);
    expect(thrown).toBeInstanceOf(AssertionError);
    expect(thrown).not.toBe(bug);
    expect((thrown as Error).message).toContain("simulated invariant breach");
    expect((thrown as Error).message).toContain("no pack was staged");
    expect((thrown as Error).message).toContain("not staged: quality");
    expect((thrown as Error).cause).toBe(bug);
    expect(addPackEntries()).toEqual([]);
  });

  it("a generic staging failure does not carry adopt's '.groundwork/ is incomplete' text, says the rest of .groundwork was not touched and how to re-run, and keeps the original failure in the cause chain", () => {
    failWhen = (p) =>
      p.includes("/.groundwork/add-pack/") && p.endsWith("/plan.json");
    const thrown = attempt(["--add-pack", "quality"]);
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(".groundwork/ is incomplete");
    expect(message).toContain("the rest of .groundwork/ was not touched");
    expect(message).toContain("--add-pack quality");
    expect(causeChain(thrown)).toContain(writeFailure);
    for (const link of causeChain(thrown)) {
      if (link instanceof Error) {
        expect(link.message).not.toContain(".groundwork/ is incomplete");
      }
    }
  });

  it("gives a non-Error rejection a message naming it and the unstaged pack, with it as cause", () => {
    failWith = "disk exploded";
    failWhen = (p) =>
      p.includes("/.groundwork/add-pack/") && p.endsWith("/plan.json");
    const thrown = attempt(["--add-pack", "quality"]);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("disk exploded");
    expect((thrown as Error).message).toContain("no pack was staged");
    expect((thrown as Error).message).toContain("not staged: quality");
    expect(causeChain(thrown)).toContain("disk exploded");
  });

  it("a failure on the FIRST pack stages nothing and reports that no pack was staged", () => {
    failWhen = (p) =>
      p.includes("/.groundwork/add-pack/") &&
      p.endsWith("check-file-budget.mjs.staged");
    const thrown = attempt([
      "--add-pack",
      "quality",
      "--add-pack",
      "statusline",
    ]);
    expect(thrown).toBeInstanceOf(Error);
    expect(addPackEntries()).toEqual([]);
    expect((thrown as Error).message).toContain("quality");
    expect((thrown as Error).message).toContain("statusline");
  });
});
