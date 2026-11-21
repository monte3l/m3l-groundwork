// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Smaller fault and parser gaps of `headless/apply.ts` and
 * `headless/internal/apply-journal.ts`: a failed commit-point journal delete,
 * a rollback that keeps a created directory someone else filled, a staged
 * copy that is a symlink, the journal's file-versus-directory fsync policy,
 * the generic "undo failed" report and the strict journal parser. Every
 * `node:fs` call runs the real function unless a test arms it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";
import {
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAdoptActions } from "../src/headless/apply.js";
import {
  fsyncPath,
  parseJournal,
  serializeJournal,
  undoStep,
} from "../src/headless/internal/apply-journal.js";
import { sha256Hex } from "../src/manifest.js";
import {
  failure,
  installStep,
  makeEnv,
  replaceStep,
} from "./headless-apply-fixture.js";
import type { Env } from "./headless-apply-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    rmSync: vi.fn(actual.rmSync),
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  vi.mocked(rmSync).mockReset();
  vi.mocked(openSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  env.dispose();
});

const fault = (code: string): Error =>
  Object.assign(new Error(`${code} fault`), { code });

describe("the commit point", () => {
  it("names the commit when deleting the journal fails, and rolls every write back", async () => {
    env.put("t.txt", "original");
    const actions = [env.take("t.txt", "taken"), env.install("n.txt", "n")];
    const real = vi.mocked(rmSync).getMockImplementation();
    vi.mocked(rmSync).mockImplementation((path, options) => {
      // Only the commit point deletes the journal without `force`.
      if (
        typeof path === "string" &&
        path.endsWith("/txn/journal.json") &&
        options?.force !== true
      ) {
        throw fault("EIO");
      }
      return real?.(path, options);
    });
    const error = await failure(applyAdoptActions({ root: env.root, actions }));
    expect(error.message).toContain("the commit");
    expect(error.rolledBack).toBe(true);
    expect(env.read("t.txt").toString()).toBe("original");
    expect(existsSync(env.abs("n.txt"))).toBe(false);
  });
});

describe("an in-process rollback", () => {
  it("keeps a directory it created but someone filled meanwhile, and says so", async () => {
    const actions = [
      env.install("new/dir/f.txt", "fresh"),
      env.install("other.txt", "o"),
    ];
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions,
        io: {
          beforeStep: ({ index }) => {
            if (index === 1) {
              writeFileSync(env.abs("new/dir/stranger.txt"), "not ours");
              throw new Error("injected");
            }
          },
        },
      }),
    );
    expect(error.rolledBack).toBe(true);
    expect(error.message).toContain("kept new/dir");
    expect(error.message).toContain("no longer empty");
    expect(existsSync(env.abs("new/dir/f.txt"))).toBe(false);
    expect(env.read("new/dir/stranger.txt").toString()).toBe("not ours");
  });
});

describe("a staged copy that is a symlink", () => {
  it("is refused with the symlink named as the reason", async () => {
    const outside = env.extraDir();
    env.put("real.txt", "outside", outside);
    const action = env.install("x.txt", "data");
    rmSync(env.abs(action.stagedPath));
    symlinkSync(join(outside, "real.txt"), env.abs(action.stagedPath));
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [action] }),
    );
    expect(error.message).toContain("it is a symlink");
    expect(existsSync(env.abs("x.txt"))).toBe(false);
  });
});

describe("a staged copy that cannot be read", () => {
  it("is refused with the read failure in the reason", async () => {
    const action = env.install("x.txt", "data");
    const staged = env.abs(action.stagedPath);
    const real = vi.mocked(openSync).getMockImplementation();
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (path === staged) throw fault("EIO");
      return (real as typeof openSync)(path, flags, mode);
    });
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [action] }),
    );
    expect(error.message).toContain("it cannot be read (EIO fault)");
    expect(existsSync(env.abs("x.txt"))).toBe(false);
  });
});

describe("fsyncPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hl-fsync-"));
    writeFileSync(join(dir, "f.txt"), "x");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws a file's fsync failure", () => {
    const failure = fault("EIO");
    vi.mocked(fsyncSync).mockImplementation(() => {
      throw failure;
    });
    expect(() => {
      fsyncPath(join(dir, "f.txt"), "file");
    }).toThrow(failure);
  });

  it("ignores a directory's fsync failure", () => {
    vi.mocked(fsyncSync).mockImplementation(() => {
      throw fault("EINVAL");
    });
    expect(() => {
      fsyncPath(dir, "dir");
    }).not.toThrow();
  });
});

describe("undoStep", () => {
  it("reports an unexpected filesystem failure as a leftover with an 'undo failed' reason", () => {
    env.put("a.txt", "taken");
    const target = env.abs("a.txt");
    const real = vi.mocked(openSync).getMockImplementation();
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (path === target) throw fault("EIO");
      return (real as typeof openSync)(path, flags, mode);
    });
    const result = undoStep(
      env.root,
      env.headless("txn/backup"),
      replaceStep("a.txt", "original", "taken"),
      "hash",
    );
    expect(result.status).toBe("leftover");
    expect(result).toMatchObject({
      reason: expect.stringContaining(
        "a.txt: undo failed: EIO fault",
      ) as string,
    });
  });
});

describe("parseJournal", () => {
  const hash = sha256Hex("x");
  const step = (over: Record<string, unknown>): string =>
    JSON.stringify({
      schema: "groundwork.apply-journal",
      schemaVersion: 1,
      steps: [
        {
          kind: "install-staged",
          path: "a/b.txt",
          sha256After: hash,
          before: null,
          createdDirs: [],
          ...over,
        },
      ],
    });

  it("accepts what serializeJournal writes", () => {
    const steps = [installStep("a/b.txt", "x", ["a"])];
    expect(parseJournal(serializeJournal(steps))).toEqual(steps);
  });

  it.each([
    [
      "a step that is not an object",
      '{"schema":"groundwork.apply-journal","schemaVersion":1,"steps":[5]}',
    ],
    ["createdDirs that is not an array", step({ createdDirs: "a" })],
    ["a createdDirs entry that is not a string", step({ createdDirs: [1] })],
    [
      "a createdDirs entry that is not above the file",
      step({ createdDirs: ["c"] }),
    ],
    [
      "a createdDirs entry that is the file itself",
      step({ createdDirs: ["a/b.txt"] }),
    ],
    [
      "a createdDirs entry that is not project-relative",
      step({ createdDirs: ["../a"] }),
    ],
  ])("refuses %s", (_name, text) => {
    expect(parseJournal(text)).toBeUndefined();
  });
});
