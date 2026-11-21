// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Second-pass hardening of `applyAdoptActions` (src/headless/apply.ts) and
 * its journal (src/headless/internal/apply-journal.ts): who owns a file at
 * rollback time, outside deletions, commit-point durability, the
 * "journal gone, applied.json missing" warning, the validator's path rules
 * reused for write paths, and a failed recovery naming what it restored.
 * Uses a pass-through `node:fs` mock for the fault and ordering tests.
 */
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import type * as FsModule from "node:fs";
import {
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { applyAdoptActions } from "../src/headless/apply.js";
import {
  parseJournal,
  serializeJournal,
} from "../src/headless/internal/apply-journal.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";
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
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    writeSync: vi.fn(actual.writeSync),
    rmSync: vi.fn(actual.rmSync),
    rmdirSync: vi.fn(actual.rmdirSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(writeSync).mockReset();
  vi.mocked(rmSync).mockReset();
  vi.mocked(rmdirSync).mockReset();
  vi.mocked(unlinkSync).mockReset();
  vi.mocked(openSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  vi.mocked(renameSync).mockReset();
  env.dispose();
});

const fault = (code: string, message = `${code} fault`): Error =>
  Object.assign(new Error(message), { code });
const endsWith = (value: unknown, suffix: string): boolean =>
  typeof value === "string" && value.endsWith(suffix);
const failAt =
  (index: number, message = "injected") =>
  ({ index: at }: { index: number }): void => {
    if (at === index) throw new Error(message);
  };

describe("an installed file is removed by rollback only while it still holds the staged bytes", () => {
  it("leaves a file the user edited during the run alone and reports it as a changed leftover", async () => {
    env.put("t.txt", "original");
    const actions = [env.install("n.txt", "n"), env.take("t.txt", "taken")];
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions,
        io: {
          beforeStep: ({ index }) => {
            if (index === 1) {
              writeFileSync(env.abs("n.txt"), "edited by the user");
              throw new Error("injected");
            }
          },
        },
      }),
    );
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toEqual(["n.txt"]);
    expect(error.leftoverReasons).toHaveLength(1);
    expect(error.leftoverReasons[0]).toContain("n.txt");
    expect(error.leftoverReasons[0]).toMatch(/changed/);
    expect(env.read("n.txt").toString()).toBe("edited by the user");
    expect(env.read("t.txt").toString()).toBe("original");
    expect(existsSync(env.headless("txn"))).toBe(true);
    expect(existsSync(env.headless("lock"))).toBe(false);
  });

  it("still removes an installed file nobody touched, rolling back completely", async () => {
    env.put("t.txt", "original");
    const actions = [env.install("n.txt", "n"), env.take("t.txt", "taken")];
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions,
        io: { beforeStep: failAt(1) },
      }),
    );
    expect(error.rolledBack).toBe(true);
    expect(existsSync(env.abs("n.txt"))).toBe(false);
    expect(env.read("t.txt").toString()).toBe("original");
    env.noResidue();
  });

  it("removes a partially written install (ENOSPC after the file was opened) whatever it holds", async () => {
    const real = await vi.importActual<typeof FsModule>("node:fs");
    const fdPaths = new Map<number, string>();
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      const fd = real.openSync(path, flags, mode);
      fdPaths.set(fd, String(path));
      return fd;
    });
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      if (endsWith(path, "/n.txt")) {
        real.writeFileSync(path, "par", options);
        throw fault("ENOSPC", "disk full");
      }
      real.writeFileSync(path, data, options);
    });
    // An implementation that opens and writes through a descriptor.
    vi.mocked(writeSync).mockImplementation(
      (fd: number, ...rest: unknown[]) => {
        if (endsWith(fdPaths.get(fd), "/n.txt")) {
          real.writeSync(fd, "par");
          throw fault("ENOSPC", "disk full");
        }
        return real.writeSync(fd, ...(rest as [string]));
      },
    );
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.install("n.txt", "n-full-bytes")],
      }),
    );
    expect(error.message).toContain("disk full");
    expect(error.rolledBack).toBe(true);
    expect(error.written).toEqual(["n.txt"]);
    expect(existsSync(env.abs("n.txt"))).toBe(false);
    env.noResidue();
  });

  test.each(["EACCES", "ENOENT", "ENOSPC"])(
    "does not list or unlink a path whose open failed with %s, even when another party created it meanwhile",
    async (code) => {
      const real = await vi.importActual<typeof FsModule>("node:fs");
      let armed = true;
      const opensForWrite = (flags: unknown): boolean =>
        typeof flags === "string"
          ? /[wa]/.test(flags)
          : typeof flags === "number" && (flags & real.constants.O_CREAT) !== 0;
      const theirs = (path: string): void => {
        armed = false;
        real.writeFileSync(path, "theirs");
        throw fault(code);
      };
      vi.mocked(openSync).mockImplementation((path, flags, mode) => {
        if (armed && endsWith(path, "/n.txt") && opensForWrite(flags)) {
          theirs(String(path));
        }
        return real.openSync(path, flags, mode);
      });
      vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
        if (armed && endsWith(path, "/n.txt")) theirs(String(path));
        real.writeFileSync(path, data, options);
      });
      const error = await failure(
        applyAdoptActions({
          root: env.root,
          actions: [env.install("n.txt", "n")],
        }),
      );
      expect(error.written).not.toContain("n.txt");
      expect(error.rolledBack).toBe(true);
      expect(env.read("n.txt").toString()).toBe("theirs");
      expect(existsSync(env.headless("lock"))).toBe(false);
    },
  );
});

describe("undoing a replace whose target was deleted since", () => {
  it("does not recreate it from the backup in an in-process rollback; it is a deleted leftover", async () => {
    env.put("t.txt", "original");
    const actions = [env.take("t.txt", "taken"), env.install("n.txt", "n")];
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions,
        io: {
          beforeStep: ({ index }) => {
            if (index === 1) {
              rmSync(env.abs("t.txt"));
              throw new Error("injected");
            }
          },
        },
      }),
    );
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toEqual(["t.txt"]);
    expect(error.leftoverReasons[0]).toContain("t.txt");
    expect(error.leftoverReasons[0]).toMatch(/deleted/);
    expect(existsSync(env.abs("t.txt"))).toBe(false);
    expect(existsSync(env.headless("txn"))).toBe(true);
  });

  it("does not recreate it when recovering a leftover journal; it is a deleted leftover and txn/ is kept", async () => {
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [] }),
    );
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toEqual(["a.txt"]);
    expect(error.leftoverReasons[0]).toContain("a.txt");
    expect(error.leftoverReasons[0]).toMatch(/deleted/);
    expect(existsSync(env.abs("a.txt"))).toBe(false);
    expect(existsSync(env.headless("txn/journal.json"))).toBe(true);
  });
});

describe("commit-point durability", () => {
  it("fsyncs every written file and created directory before the journal is removed, and txn/ after", async () => {
    env.put("t.txt", "original");
    const actions = [
      env.take("t.txt", "taken"),
      env.install("d/n.txt", "n"),
      env.install("top.txt", "top"),
    ];
    const real = await vi.importActual<typeof FsModule>("node:fs");
    const events: { kind: "fsync" | "journal-rm"; path: string }[] = [];
    const fdPaths = new Map<number, string>();
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      const fd = real.openSync(path, flags, mode);
      fdPaths.set(fd, String(path));
      return fd;
    });
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      events.push({
        kind: "fsync",
        path: (fdPaths.get(fd) ?? `fd ${String(fd)}`).replace(/\/$/, ""),
      });
      real.fsyncSync(fd);
    });
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (endsWith(path, "/txn/journal.json")) {
        events.push({ kind: "journal-rm", path: String(path) });
      }
      real.rmSync(path, options);
    });
    vi.mocked(unlinkSync).mockImplementation((path) => {
      if (endsWith(path, "/txn/journal.json")) {
        events.push({ kind: "journal-rm", path: String(path) });
      }
      real.unlinkSync(path);
    });

    await applyAdoptActions({ root: env.root, actions });

    const commit = events.findIndex((event) => event.kind === "journal-rm");
    expect(commit).toBeGreaterThan(-1);
    const before = events
      .slice(0, commit)
      .filter((event) => event.kind === "fsync")
      .map((event) => event.path);
    const after = events
      .slice(commit + 1)
      .filter((event) => event.kind === "fsync")
      .map((event) => event.path);
    // A replaced file is written through a same-directory temp, so its
    // fsynced name may be the temp's.
    const replaced = env.abs("t.txt");
    expect(
      before.some(
        (path) =>
          path === replaced ||
          (dirname(path) === dirname(replaced) &&
            basename(path).startsWith(".t.txt.groundwork-")),
      ),
    ).toBe(true);
    expect(before).toContain(env.abs("d/n.txt"));
    expect(before).toContain(env.abs("top.txt"));
    expect(before).toContain(env.abs("d"));
    expect(after).toContain(env.headless("txn"));
  });
});

describe("a txn/ left with no journal", () => {
  it("warns that the previous run's changes may have landed without applied.json, to be checked by hand, not that there was nothing to roll back", async () => {
    env.put(".groundwork/headless/txn/backup/0", "orphan backup");
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0] ?? "";
    expect(warning).toMatch(/may have landed/i);
    expect(warning).toContain("applied.json");
    expect(warning).toMatch(/by hand/i);
    expect(warning).not.toMatch(/nothing to roll back/i);
    expect(env.read("n.txt").toString()).toBe("n");
    expect(existsSync(env.headless("txn"))).toBe(false);
  });
});

describe("write paths follow the validator's reserved-name rules", () => {
  // Segments the validator refuses: a trailing dot or space, a colon (NTFS
  // stream / alternate data stream syntax), `.git` or `.groundwork` after
  // NFC + upper + lower case folding (dotless i folds to a plain `i`).
  const bad = [
    ".git./config",
    ".git /config",
    ".git::$INDEX_ALLOCATION/x",
    "a:b/x",
    "sub/a./x",
    "sub/a /x",
    ".gıt/config",
    ".groundwork./x",
    ".groundwork /x",
    ".groundwork::$DATA/x",
  ];

  test.each(bad)(
    "prepareSteps refuses an install of %s before any write, in a real run and a dry run",
    async (path) => {
      const actions = [env.install("ok.txt", "ok"), env.install(path, "bad")];
      const before = snapshotTree(env.root);
      await failure(applyAdoptActions({ root: env.root, actions }));
      await failure(
        applyAdoptActions({ root: env.root, actions, dryRun: true }),
      );
      expect(snapshotTree(env.root)).toEqual(before);
      env.noResidue();
    },
  );

  test.each(bad)(
    "parseJournal refuses a journal step for %s as tampered",
    (path) => {
      expect(
        parseJournal(serializeJournal([installStep(path, "x")])),
      ).toBeUndefined();
      expect(
        parseJournal(serializeJournal([replaceStep(path, "a", "b")])),
      ).toBeUndefined();
    },
  );

  it("refuses a leftover journal naming such a path, touching nothing", async () => {
    env.put(".git./config", "x");
    env.writeJournal([installStep(".git./config", "x")]);
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [] }),
    );
    expect(error.message).toMatch(/journal/);
    expect(env.read(".git./config").toString()).toBe("x");
    expect(existsSync(env.headless("txn/journal.json"))).toBe(true);
  });

  it("still accepts ordinary dotted and spaced names inside a segment", () => {
    expect(
      parseJournal(serializeJournal([installStep("sub/a.b c/x.txt", "x")])),
    ).toHaveLength(1);
  });
});

describe("parseJournal", () => {
  it("rejects a journal that lists one step path twice", () => {
    expect(
      parseJournal(
        serializeJournal([
          installStep("a.txt", "x"),
          installStep("a.txt", "x"),
        ]),
      ),
    ).toBeUndefined();
    expect(
      parseJournal(
        serializeJournal([
          replaceStep("a.txt", "o", "x"),
          replaceStep("a.txt", "o", "x"),
        ]),
      ),
    ).toBeUndefined();
  });

  it("accepts distinct step paths", () => {
    expect(
      parseJournal(
        serializeJournal([
          installStep("a.txt", "x"),
          installStep("b.txt", "x"),
        ]),
      ),
    ).toHaveLength(2);
  });
});

describe("a failed recovery reports what it did restore", () => {
  it("names the restored paths in the error message next to the leftover reasons", async () => {
    env.put("a.txt", "taken a");
    env.put("b.txt", "edited by the owner");
    const second = replaceStep("b.txt", "original b", "taken b");
    env.writeJournal(
      [
        replaceStep("a.txt", "original a", "taken a"),
        {
          ...second,
          before: second.before && { ...second.before, backup: "1" },
        },
      ],
      { "0": "original a", "1": "original b" },
    );
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [] }),
    );
    expect(error.leftovers).toEqual(["b.txt"]);
    expect(env.read("a.txt").toString()).toBe("original a");
    expect(env.read("b.txt").toString()).toBe("edited by the owner");
    expect(error.message).toMatch(/restored[^;]*a\.txt/);
  });
});

describe("a merge target with a UTF-8 byte order mark", () => {
  it("is refused with a BOM-specific message, not the comments-or-trailing-commas one, writing nothing", async () => {
    const target = '\uFEFF{\n  "a": 1\n}\n';
    env.put("p.json", target);
    // Building the action stages .groundwork/baseline-divergent/..., so it
    // happens before the snapshot.
    const action = env.merge("p.json", '{\n  "a": 2\n}\n', ["a"]);
    const before = snapshotTree(env.root);
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [action] }),
    );
    expect(error.message).toMatch(/BOM|byte.order mark/i);
    expect(error.message).not.toMatch(/comments or trailing commas/);
    expect(readFileSync(env.abs("p.json"), "utf8")).toBe(target);
    expect(snapshotTree(env.root)).toEqual(before);
  });
});

// Keep the imported-but-conditionally-used mock handles referenced.
void [mkdirSync, renameSync];
