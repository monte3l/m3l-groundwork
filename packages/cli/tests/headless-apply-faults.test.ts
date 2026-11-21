// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Filesystem faults the real disk cannot raise on demand, injected through a
 * pass-through `node:fs` mock (every call runs the real function unless a
 * test arms a fault): a journal that cannot be written, a rollback that
 * cannot remove `txn/`, a lock that cannot be removed, a temp file that
 * cannot be cleaned up. Each asserts the documented `ApplyError` and the
 * state the project and `.groundwork/headless/` are left in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { applyAdoptActions } from "../src/headless/apply.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";
import { failure, makeEnv } from "./headless-apply-fixture.js";
import type { Env } from "./headless-apply-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(rmSync).mockReset();
  env.dispose();
});

const fault = (message: string): Error =>
  Object.assign(new Error(message), { code: "EIO" });
const endsWith = (value: unknown, suffix: string): boolean =>
  typeof value === "string" && value.endsWith(suffix);

describe("journal creation failing", () => {
  it.each([
    ["the txn directory", "/txn"],
    ["the backup directory", "/txn/backup"],
  ])(
    "refuses, writes nothing and removes txn/ when %s cannot be created",
    async (_n, suffix) => {
      env.put("t.txt", "target");
      const actions = [env.take("t.txt", "taken")];
      const before = snapshotTree(env.root);
      const real = vi.mocked(mkdirSync).getMockImplementation();
      vi.mocked(mkdirSync).mockImplementation((path, options) => {
        if (endsWith(path, suffix)) throw fault("mkdir fault");
        return real?.(path, options);
      });
      const error = await failure(
        applyAdoptActions({ root: env.root, actions }),
      );
      expect(error.message).toMatch(/could not write the apply journal/);
      expect(error.message).toContain("nothing was written");
      expect(error.written).toEqual([]);
      expect(error.cause).toBeInstanceOf(Error);
      expect(snapshotTree(env.root)).toEqual(before);
    },
  );

  it("removes the half-built txn/ when a backup cannot be written", async () => {
    env.put("t.txt", "target");
    const actions = [env.take("t.txt", "taken")];
    const before = snapshotTree(env.root);
    const real = vi.mocked(writeFileSync).getMockImplementation();
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      if (typeof path === "string" && path.includes("/txn/backup/")) {
        throw fault("backup fault");
      }
      return real?.(path, data, options);
    });
    const error = await failure(applyAdoptActions({ root: env.root, actions }));
    expect(error.message).toMatch(/could not write the apply journal/);
    expect(env.read("t.txt").toString()).toBe("target");
    expect(snapshotTree(env.root)).toEqual(before);
  });

  it("leaves txn/ for the next run, still refusing cleanly, when removing it fails too", async () => {
    env.put("t.txt", "target");
    const actions = [env.take("t.txt", "taken")];
    const realMkdir = vi.mocked(mkdirSync).getMockImplementation();
    vi.mocked(mkdirSync).mockImplementation((path, options) => {
      if (endsWith(path, "/txn/backup")) throw fault("mkdir fault");
      return realMkdir?.(path, options);
    });
    const realRm = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (endsWith(path, "/txn")) throw fault("rm fault");
      return realRm?.(path, options);
    });
    const error = await failure(applyAdoptActions({ root: env.root, actions }));
    expect(error.message).toMatch(/could not write the apply journal/);
    expect(error.cause).toMatchObject({ message: "mkdir fault" });
    expect(env.read("t.txt").toString()).toBe("target");
    expect(existsSync(env.headless("lock"))).toBe(false);

    // A txn/ with no journal is cleaned up, with a warning, by the next run.
    vi.mocked(mkdirSync).mockReset();
    vi.mocked(rmSync).mockReset();
    const result = await applyAdoptActions({ root: env.root, actions });
    expect(result.warnings).toHaveLength(1);
    expect(env.read("t.txt").toString()).toBe("taken");
  });
});

describe("rollback bookkeeping failing", () => {
  it("still reports a completed rollback when txn/ cannot be removed, and the next run only warns about the leftover directory", async () => {
    env.put("t.txt", "target");
    const actions = [env.take("t.txt", "taken"), env.install("n.txt", "n")];
    const before = snapshotTree(env.root);
    const real = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (endsWith(path, "/txn")) throw fault("rm fault");
      return real?.(path, options);
    });
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions,
        io: {
          beforeStep: ({ index }) => {
            if (index === 1) throw new Error("injected");
          },
        },
      }),
    );
    expect(error.rolledBack).toBe(true);
    expect(error.leftovers).toEqual([]);
    expect(env.read("t.txt").toString()).toBe("target");
    expect(existsSync(env.abs("n.txt"))).toBe(false);
    // The journal is deleted before the directory, so it is already gone.
    expect(existsSync(env.headless("txn/journal.json"))).toBe(false);
    expect(existsSync(env.headless("lock"))).toBe(false);

    vi.mocked(rmSync).mockReset();
    const result = await applyAdoptActions({ root: env.root, actions: [] });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("txn");
    expect(snapshotTree(env.root)).toEqual(before);
  });

  it("keeps the write failure as the cause when a replaced file's temp file cannot be removed either", async () => {
    env.put("t.txt", "target");
    const actions = [env.take("t.txt", "taken")];
    const realWrite = vi.mocked(writeFileSync).getMockImplementation();
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      if (endsWith(path, ".tmp")) throw fault("write fault");
      return realWrite?.(path, data, options);
    });
    const realRm = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (endsWith(path, ".tmp")) throw fault("rm temp fault");
      return realRm?.(path, options);
    });
    const error = await failure(applyAdoptActions({ root: env.root, actions }));
    expect(error.rolledBack).toBe(true);
    expect(error.cause).toMatchObject({ message: "write fault" });
    expect(env.read("t.txt").toString()).toBe("target");
  });
});

describe("the lock failing to release", () => {
  it("reports an unremovable lock after a successful run, keeping the writes", async () => {
    const actions = [env.install("n.txt", "n")];
    const real = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (endsWith(path, "/headless/lock")) throw fault("rm lock fault");
      return real?.(path, options);
    });
    const error = await failure(applyAdoptActions({ root: env.root, actions }));
    expect(error.message).toContain("lock");
    expect(error.cause).toMatchObject({ message: "rm lock fault" });
    expect(env.read("n.txt").toString()).toBe("n");
  });
});
