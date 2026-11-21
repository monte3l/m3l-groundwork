// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Hardening faults of `applyAdoptActions` (src/headless/apply.ts) that need
 * a pass-through `node:fs` mock: cleanup ordering (the journal goes before
 * `txn/`), a cleanup that fails after a successful recovery or after the
 * commit, `ApplyError.written` when a rollback fails too, and the durability
 * order (backups, journal, `txn/` and `headless/` fsynced before the first
 * project write). Every call runs the real function unless a test arms it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";
import {
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { applyAdoptActions } from "../src/headless/apply.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";
import { failure, makeEnv, replaceStep } from "./headless-apply-fixture.js";
import type { Env } from "./headless-apply-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    rmSync: vi.fn(actual.rmSync),
    rmdirSync: vi.fn(actual.rmdirSync),
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
    writeSync: vi.fn(actual.writeSync),
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
  vi.mocked(rmdirSync).mockReset();
  vi.mocked(openSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  vi.mocked(renameSync).mockReset();
  vi.mocked(writeSync).mockReset();
  env.dispose();
});

const fault = (code: string, message = `${code} fault`): Error =>
  Object.assign(new Error(message), { code });
const endsWith = (value: unknown, suffix: string): boolean =>
  typeof value === "string" && value.endsWith(suffix);

/** Makes removing the `txn` directory itself fail; its files stay removable. */
function failTxnRemoval(): void {
  const real = vi.mocked(rmSync).getMockImplementation();
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (endsWith(path, "/txn")) throw fault("EIO", "rm txn fault");
    return real?.(path, options);
  });
}

describe("removing txn/ deletes the journal first", () => {
  it("leaves no journal behind when removing the directory fails, so the next run recovers nothing and warns about the leftover txn/", async () => {
    env.put("t.txt", "original");
    const actions = [env.take("t.txt", "taken"), env.install("n.txt", "n")];
    const before = snapshotTree(env.root);
    failTxnRemoval();
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
    expect(existsSync(env.headless("txn"))).toBe(true);
    expect(existsSync(env.headless("txn/journal.json"))).toBe(false);

    vi.mocked(rmSync).mockReset();
    const result = await applyAdoptActions({ root: env.root, actions: [] });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("txn");
    expect(result.warnings[0]).not.toMatch(/nothing was written/);
    expect(result.warnings[0]).not.toMatch(/rolled back/);
    expect(snapshotTree(env.root)).toEqual(before);
  });
});

describe("a cleanup failing after a successful recovery", () => {
  it("is reported as only the cleanup failing, not as an unchecked journal", async () => {
    env.put("a.txt", "taken");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    failTxnRemoval();
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [] }),
    );
    expect(error.message).not.toContain("could not check for a leftover");
    expect(error.message).toMatch(/recover|rolled back|restored/i);
    expect(error.message).toMatch(/clean/i);
    expect(error.message).toContain("a.txt");
    expect(env.read("a.txt").toString()).toBe("original");
  });
});

describe("after the commit point", () => {
  it("resolves with a warning, still writing applied.json, when txn/ cannot be removed", async () => {
    failTxnRemoval();
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(result.changes.map((change) => change.path)).toEqual(["n.txt"]);
    expect(result.warnings.join("\n")).toContain("txn");
    expect(env.read("n.txt").toString()).toBe("n");
    const applied = JSON.parse(
      readFileSync(env.headless("applied.json"), "utf8"),
    ) as { changes: { path: string }[] };
    expect(applied.changes.map((change) => change.path)).toEqual(["n.txt"]);
    expect(existsSync(env.headless("lock"))).toBe(false);

    vi.mocked(rmSync).mockReset();
    const next = await applyAdoptActions({ root: env.root, actions: [] });
    expect(next.warnings).toHaveLength(1);
    expect(existsSync(env.headless("txn"))).toBe(false);
  });
});

describe("ApplyError.written when a rollback fails too", () => {
  it("lists an install whose directories were created and whose file write then failed in both written and leftovers", async () => {
    const actions = [env.install("d/e/f.txt", "x")];
    const real = await vi.importActual<typeof FsModule>("node:fs");
    const fdPaths = new Map<number, string>();
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      const fd = real.openSync(path, flags, mode);
      fdPaths.set(fd, String(path));
      return fd;
    });
    vi.mocked(writeSync).mockImplementation(
      (fd: number, ...rest: unknown[]) => {
        if (endsWith(fdPaths.get(fd), "/d/e/f.txt")) {
          throw fault("ENOSPC", "disk full");
        }
        return real.writeSync(fd, ...(rest as [string]));
      },
    );
    const realRmdir = vi.mocked(rmdirSync).getMockImplementation();
    vi.mocked(rmdirSync).mockImplementation((path) => {
      if (endsWith(path, "/d/e") || endsWith(path, "/d")) {
        throw fault("EIO", "rmdir fault");
      }
      realRmdir?.(path);
    });
    const error = await failure(applyAdoptActions({ root: env.root, actions }));
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toContain("d/e/f.txt");
    expect(error.written).toContain("d/e/f.txt");
    expect(error.message).toContain("disk full");
  });
});

describe("durability before the first project write", () => {
  it("fsyncs the backups, the journal, txn/ and headless/ before anything lands in the project", async () => {
    env.put("t.txt", "original");
    const actions = [env.take("t.txt", "taken"), env.install("n.txt", "n")];
    const txn = env.headless("txn");
    const inGroundwork = (path: string): boolean =>
      path.startsWith(join(env.root, ".groundwork"));
    const isProject = (path: unknown): boolean =>
      typeof path === "string" &&
      path.startsWith(env.root) &&
      !inGroundwork(path);

    const events: { kind: "fsync" | "write"; path: string }[] = [];
    const fdPaths = new Map<number, string>();
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    const writeMask = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT;
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      const fd = actual.openSync(path, flags, mode);
      fdPaths.set(fd, String(path));
      const writes =
        typeof flags === "string"
          ? flags !== "r"
          : typeof flags === "number" && (flags & writeMask) !== 0;
      if (writes && isProject(path)) {
        events.push({ kind: "write", path: String(path) });
      }
      return fd;
    });
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      events.push({ kind: "fsync", path: fdPaths.get(fd) ?? `fd ${fd}` });
      actual.fsyncSync(fd);
    });
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      if (isProject(path)) events.push({ kind: "write", path: String(path) });
      actual.writeFileSync(path, data, options);
    });
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (isProject(to)) events.push({ kind: "write", path: String(to) });
      actual.renameSync(from, to);
    });
    vi.mocked(mkdirSync).mockImplementation((path, options) => {
      if (isProject(path)) events.push({ kind: "write", path: String(path) });
      return actual.mkdirSync(path, options);
    });

    await applyAdoptActions({ root: env.root, actions });

    const firstWrite = events.findIndex((event) => event.kind === "write");
    expect(firstWrite).toBeGreaterThan(-1);
    const synced = events
      .slice(0, firstWrite)
      .filter((event) => event.kind === "fsync")
      .map((event) => event.path.replace(/\/$/, ""));
    expect(synced).toContain(join(txn, "backup", "0"));
    // The journal is replaced through a temp file, so its fsynced name may be the temp's.
    expect(
      synced.some(
        (path) =>
          path === join(txn, "journal.json") ||
          (path.startsWith(txn) && basename(path).startsWith(".journal.json.")),
      ),
    ).toBe(true);
    expect(synced).toContain(txn);
    expect(synced).toContain(env.headless("").replace(/\/$/, ""));
  });
});
