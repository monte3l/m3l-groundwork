// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The transactional executor behind `--adopt --apply`
 * (src/headless/apply.ts): `applyAdoptActions({ root, actions, dryRun?, io? })`.
 * Every staged source is verified (containment, no symlinks, sha256) before
 * any project write; writes are journaled under
 * `.groundwork/headless/txn/`, rolled back in reverse on failure, and
 * `.groundwork/headless/applied.json` is written last.
 *
 * Chosen contract (this file pins it):
 * - returns `{ changes, warnings }`; `changes` sorted by path, one entry per
 *   written file (`keep`/`skip`/`delegate` produce none);
 * - `ApplyError` (src/headless/errors.ts) carries `written` (target-relative
 *   paths that had landed, in write order), `rolledBack`, `leftovers`
 *   (target-relative paths a failed rollback could not restore) and chains
 *   the original failure as `cause`;
 * - `io.beforeStep({ index, path, kind })` runs right before each project
 *   write (after verification and after the journal exists); the one seam
 *   used for failure injection and for pausing a run;
 * - no `changes` => `applied.json` is not written (the caller maps to noop);
 * - a failed rollback leaves `txn/` (and its journal) in place for recovery.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyAdoptActions } from "../src/headless/apply.js";
import { ApplyError } from "../src/headless/errors.js";
import type { AdoptPlanResult } from "../src/headless/actions.js";
import { sha256Hex } from "../src/manifest.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";

type Action = Extract<AdoptPlanResult, { ok: true }>["actions"][number];

const DIVERGENT = ".groundwork/baseline-divergent";
const BASELINE = ".groundwork/baseline";

let root: string;
const made: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "hl-apply-"));
  made.push(dir);
  mkdirSync(join(dir, ".groundwork", "headless"), { recursive: true });
  // The executor creates this as soon as it holds the lock; pre-creating it
  // keeps before/after tree snapshots about what a run really changed.
  writeFileSync(
    join(dir, ".groundwork", "headless", ".gitignore"),
    "txn/\nlock\n",
  );
  return dir;
}

beforeEach(() => {
  root = makeProject();
});
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const abs = (rel: string, base = root): string => join(base, rel);
const put = (rel: string, data: string | Buffer, base = root): void => {
  mkdirSync(dirname(abs(rel, base)), { recursive: true });
  writeFileSync(abs(rel, base), data);
};
const read = (rel: string, base = root): Buffer => readFileSync(abs(rel, base));
const headless = (name: string, base = root): string =>
  abs(`.groundwork/headless/${name}`, base);

/** Stage `data` as the copy for `rel` and return the action fields that point at it. */
function stage(
  rel: string,
  data: string | Buffer,
  dir = DIVERGENT,
  base = root,
): { stagedPath: string; sha256: string } {
  const stagedPath = `${dir}/${rel}.staged`;
  put(stagedPath, data, base);
  return { stagedPath, sha256: sha256Hex(Buffer.from(data)) };
}

type Install = Extract<Action, { kind: "install-staged" | "take-divergent" }>;
type Take = Install;
type Merge = Extract<Action, { kind: "merge-keys" }>;

const install = (rel: string, data: string | Buffer, base = root): Install => ({
  kind: "install-staged",
  path: rel,
  ...stage(rel, data, BASELINE, base),
});
const take = (rel: string, data: string | Buffer, base = root): Take => ({
  kind: "take-divergent",
  path: rel,
  ...stage(rel, data, DIVERGENT, base),
});
const merge = (
  rel: string,
  data: string,
  takeKeys: string[],
  base = root,
): Merge => ({
  kind: "merge-keys",
  path: rel,
  ...stage(rel, data, DIVERGENT, base),
  takeKeys,
});

async function failure(promise: Promise<unknown>): Promise<ApplyError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApplyError);
  return thrown as ApplyError;
}

function expectNoTransactionResidue(base = root): void {
  expect(existsSync(headless("lock", base))).toBe(false);
  expect(existsSync(headless("txn", base))).toBe(false);
  expect(existsSync(headless("applied.json", base))).toBe(false);
}

describe("applyAdoptActions: writes", () => {
  it("install-staged creates the file with the staged bytes, creating parents, and reports an addition", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x0a, 0x0d]);
    const action = install("nested/deep/tool.bin", bytes);
    const result = await applyAdoptActions({ root, actions: [action] });
    expect(read("nested/deep/tool.bin").equals(bytes)).toBe(true);
    expect(result.changes).toEqual([
      {
        path: "nested/deep/tool.bin",
        action: "install-staged",
        class: "addition",
        sha256Before: null,
        sha256After: sha256Hex(bytes),
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(headless("lock"))).toBe(false);
    expect(existsSync(headless("txn"))).toBe(false);
  });

  it("take-divergent replaces the content byte-exactly (CRLF kept), reports a conflict, leaves no temp file", async () => {
    put("conf/a.txt", "old\r\ncontent\r\n");
    const original = read("conf/a.txt");
    const action = take("conf/a.txt", "new\r\nlines\r\n\r\n");
    const result = await applyAdoptActions({ root, actions: [action] });
    expect(read("conf/a.txt").toString("utf8")).toBe("new\r\nlines\r\n\r\n");
    expect(readdirSync(abs("conf"))).toEqual(["a.txt"]);
    expect(result.changes).toEqual([
      {
        path: "conf/a.txt",
        action: "take-divergent",
        class: "conflict",
        sha256Before: sha256Hex(original),
        sha256After: sha256Hex(Buffer.from("new\r\nlines\r\n\r\n")),
      },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "take-divergent keeps the target's file mode",
    async () => {
      put("run.sh", "#!/bin/sh\necho old\n");
      chmodSync(abs("run.sh"), 0o751);
      await applyAdoptActions({
        root,
        actions: [take("run.sh", "#!/bin/sh\necho new\n")],
      });
      expect(read("run.sh").toString()).toBe("#!/bin/sh\necho new\n");
      expect(statSync(abs("run.sh")).mode & 0o777).toBe(0o751);
    },
  );

  it("merge-keys takes only the named top-level keys from the staged copy", async () => {
    const target = JSON.stringify({ a: 1, b: 1, c: { keep: true } }, null, 2);
    put("package.json", target);
    const staged = JSON.stringify({ a: 2, b: 3, d: [1], c: { other: 1 } });
    const result = await applyAdoptActions({
      root,
      actions: [merge("package.json", staged, ["a", "d"])],
    });
    const merged = JSON.parse(read("package.json").toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(merged).toEqual({ a: 2, b: 1, c: { keep: true }, d: [1] });
    expect(Object.keys(merged)).toEqual(["a", "b", "c", "d"]);
    expect(result.changes).toEqual([
      {
        path: "package.json",
        action: "merge-keys",
        class: "conflict",
        sha256Before: sha256Hex(target),
        sha256After: sha256Hex(read("package.json")),
      },
    ]);
  });

  it("returns changes sorted by path whatever the action order", async () => {
    put("m.txt", "old");
    const result = await applyAdoptActions({
      root,
      actions: [
        install("z.txt", "z"),
        take("m.txt", "new"),
        install("a.txt", "a"),
      ],
    });
    expect(result.changes.map((c: { path: string }) => c.path)).toEqual([
      "a.txt",
      "m.txt",
      "z.txt",
    ]);
  });

  it("keep, skip and delegate write nothing and produce no change", async () => {
    put("k.txt", "keep me");
    const before = snapshotTree(root);
    const result = await applyAdoptActions({
      root,
      actions: [
        { kind: "keep", path: "k.txt" },
        { kind: "skip", path: "s.txt" },
        { kind: "delegate", path: "d.txt" },
      ],
    });
    expect(result.changes).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
    expectNoTransactionResidue();
  });

  it("with no actions leaves no lock or txn and writes no applied.json", async () => {
    const result = await applyAdoptActions({ root, actions: [] });
    expect(result).toEqual({ changes: [], warnings: [] });
    expectNoTransactionResidue();
  });

  it("writes applied.json (schema, schemaVersion 1, changes) once everything landed", async () => {
    const result = await applyAdoptActions({
      root,
      actions: [install("one.txt", "1")],
    });
    const applied = JSON.parse(
      readFileSync(headless("applied.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(applied).toMatchObject({
      schema: "groundwork.applied",
      schemaVersion: 1,
      changes: result.changes,
    });
    expect(existsSync(headless("txn"))).toBe(false);
  });
});

describe("applyAdoptActions: verification before any write", () => {
  const cases: Array<[string, (base: string) => Action]> = [
    [
      "a sha256 that does not match the staged bytes",
      (base) => ({
        ...install("bad.txt", "real bytes", base),
        sha256: sha256Hex("other bytes"),
      }),
    ],
    [
      "a stagedPath that climbs out with ..",
      (base) => {
        put("secret.txt", "outside the staging dirs", base);
        return {
          kind: "install-staged",
          path: "bad.txt",
          stagedPath: ".groundwork/baseline/../../secret.txt",
          sha256: sha256Hex("outside the staging dirs"),
        };
      },
    ],
    [
      "a stagedPath outside .groundwork",
      (base) => {
        put("src/x.staged", "x", base);
        return {
          kind: "install-staged",
          path: "bad.txt",
          stagedPath: "src/x.staged",
          sha256: sha256Hex("x"),
        };
      },
    ],
    [
      "an absolute stagedPath",
      (base) => {
        put("abs.staged", "x", base);
        return {
          kind: "install-staged",
          path: "bad.txt",
          stagedPath: join(base, "abs.staged"),
          sha256: sha256Hex("x"),
        };
      },
    ],
    [
      "a staged file that is a symlink",
      (base) => {
        put("elsewhere.txt", "linked", base);
        mkdirSync(join(base, BASELINE), { recursive: true });
        symlinkSync(
          join(base, "elsewhere.txt"),
          join(base, BASELINE, "bad.txt.staged"),
        );
        return {
          kind: "install-staged",
          path: "bad.txt",
          stagedPath: `${BASELINE}/bad.txt.staged`,
          sha256: sha256Hex("linked"),
        };
      },
    ],
    [
      "a symlinked directory on the staged path",
      (base) => {
        put("real-dir/bad.txt.staged", "viadir", base);
        mkdirSync(join(base, ".groundwork"), { recursive: true });
        symlinkSync(
          join(base, "real-dir"),
          join(base, ".groundwork", "linked"),
        );
        return {
          kind: "install-staged",
          path: "bad.txt",
          stagedPath: ".groundwork/linked/bad.txt.staged",
          sha256: sha256Hex("viadir"),
        };
      },
    ],
    [
      "a staged path that is a directory",
      (base) => {
        mkdirSync(join(base, BASELINE, "bad.txt.staged"), { recursive: true });
        return {
          kind: "install-staged",
          path: "bad.txt",
          stagedPath: `${BASELINE}/bad.txt.staged`,
          sha256: sha256Hex(""),
        };
      },
    ],
    [
      "a staged file that does not exist",
      () => ({
        kind: "install-staged",
        path: "bad.txt",
        stagedPath: `${BASELINE}/missing.staged`,
        sha256: sha256Hex(""),
      }),
    ],
  ];

  it.each(cases)(
    "refuses %s before touching the project, even after a valid action",
    async (_name, build) => {
      put("t.txt", "target");
      const good = take("t.txt", "taken");
      const bad = build(root);
      const before = snapshotTree(root);
      const error = await failure(
        applyAdoptActions({ root, actions: [good, bad] }),
      );
      expect(error.written).toEqual([]);
      expect(snapshotTree(root)).toEqual(before);
      expect(read("t.txt").toString()).toBe("target");
      expectNoTransactionResidue();
    },
  );

  it("verifies the staged sha256 against the raw bytes (CRLF is not normalised)", async () => {
    const action = install("crlf.txt", "a\r\nb\r\n");
    const error = await failure(
      applyAdoptActions({
        root,
        actions: [{ ...action, sha256: sha256Hex("a\nb\n") }],
      }),
    );
    expect(error.written).toEqual([]);
    expect(existsSync(abs("crlf.txt"))).toBe(false);
  });
});

describe("applyAdoptActions: target guards", () => {
  it("install-staged refuses an existing target and never overwrites it", async () => {
    put("exists.txt", "mine");
    const action = install("exists.txt", "theirs");
    const before = snapshotTree(root);
    const error = await failure(applyAdoptActions({ root, actions: [action] }));
    expect(error.written).toEqual([]);
    expect(read("exists.txt").toString()).toBe("mine");
    expect(snapshotTree(root)).toEqual(before);
  });

  it("install-staged refuses a target that appears after verification (exclusive create), keeping its bytes", async () => {
    const error = await failure(
      applyAdoptActions({
        root,
        actions: [install("race.txt", "ours")],
        io: {
          beforeStep: () => {
            put("race.txt", "raced in");
          },
        },
      }),
    );
    expect(read("race.txt").toString()).toBe("raced in");
    expect(error.rolledBack).toBe(true);
    expect(error.written).toEqual([]);
    expectNoTransactionResidue();
  });

  it("install-staged refuses when an existing ancestor is a symlink, writing nothing through it", async () => {
    const outside = makeProject();
    symlinkSync(outside, abs("linked"));
    const actions = [
      install("fine/new.txt", "ok"),
      install("linked/new.txt", "no"),
    ];
    const before = snapshotTree(root);
    const error = await failure(applyAdoptActions({ root, actions }));
    expect(error.written).toEqual([]);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  it("install-staged refuses when an existing ancestor is a regular file", async () => {
    put("file-as-dir", "i am a file");
    const action = install("file-as-dir/x.txt", "x");
    const before = snapshotTree(root);
    await failure(applyAdoptActions({ root, actions: [action] }));
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each([
    [
      "a symlink",
      (): void => {
        put("real.txt", "real");
        symlinkSync(abs("real.txt"), abs("t.txt"));
      },
    ],
    ["a directory", (): void => mkdirSync(abs("t.txt"))],
    ["missing", (): void => undefined],
  ])("take-divergent refuses a target that is %s", async (_name, arrange) => {
    arrange();
    const action = take("t.txt", "taken");
    const before = snapshotTree(root);
    await failure(applyAdoptActions({ root, actions: [action] }));
    expect(snapshotTree(root)).toEqual(before);
    if (existsSync(abs("real.txt"))) {
      expect(read("real.txt").toString()).toBe("real");
    }
  });

  it("take-divergent re-checks the target after verification and refuses one swapped for a symlink", async () => {
    put("t.txt", "original");
    const outside = makeProject();
    put("victim.txt", "victim", outside);
    const error = await failure(
      applyAdoptActions({
        root,
        actions: [take("t.txt", "taken")],
        io: {
          beforeStep: () => {
            rmSync(abs("t.txt"));
            symlinkSync(join(outside, "victim.txt"), abs("t.txt"));
          },
        },
      }),
    );
    expect(read("victim.txt", outside).toString()).toBe("victim");
    expect(error.written).toEqual([]);
  });

  it("merge-keys refuses an unparsable target and leaves it untouched", async () => {
    put("package.json", "{ not json");
    const action = merge("package.json", '{"a":1}', ["a"]);
    const before = snapshotTree(root);
    await failure(applyAdoptActions({ root, actions: [action] }));
    expect(snapshotTree(root)).toEqual(before);
  });

  it("merge-keys refuses a prototype-sensitive key and leaves the target untouched", async () => {
    put("package.json", '{"a":1}');
    const action = merge("package.json", '{"__proto__":{"x":1},"a":2}', [
      "__proto__",
    ]);
    const before = snapshotTree(root);
    await failure(applyAdoptActions({ root, actions: [action] }));
    expect(snapshotTree(root)).toEqual(before);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});

describe("applyAdoptActions: journal, rollback and recovery", () => {
  const original = {
    "a.txt": "A original\r\n",
    "package.json": JSON.stringify({ a: 1, b: 2 }, null, 2),
  };

  function plan(): Action[] {
    put("a.txt", original["a.txt"]);
    put("package.json", original["package.json"]);
    return [
      install("nested/deep/new.txt", "fresh"),
      take("a.txt", "A taken\r\n"),
      merge("package.json", '{"a":9,"b":2}', ["a"]),
      install("z.txt", "never lands"),
    ];
  }

  it("holds the lock, and has the journal and a backup of each taken file on disk, before the first project write", async () => {
    const actions = plan();
    const seen: Record<string, unknown> = {};
    await applyAdoptActions({
      root,
      actions,
      io: {
        beforeStep: ({ index }: { index: number }) => {
          if (index !== 0) return;
          seen["lock"] = existsSync(headless("lock"));
          seen["journal"] = JSON.parse(
            readFileSync(headless("txn/journal.json"), "utf8"),
          ) as unknown;
          const backups: Buffer[] = [];
          const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);
              if (entry.isDirectory()) walk(full);
              else backups.push(readFileSync(full));
            }
          };
          walk(headless("txn/backup"));
          seen["backups"] = backups.map((b) => b.toString("utf8"));
          seen["aStillOriginal"] = read("a.txt").toString("utf8");
          seen["appliedYet"] = existsSync(headless("applied.json"));
        },
      },
    });
    expect(seen["lock"]).toBe(true);
    expect(seen["journal"]).toBeTypeOf("object");
    expect(seen["backups"]).toEqual(
      expect.arrayContaining([original["a.txt"], original["package.json"]]),
    );
    expect(seen["aStillOriginal"]).toBe(original["a.txt"]);
    expect(seen["appliedYet"]).toBe(false);
  });

  it("rolls every earlier step back byte-for-byte when a later step fails, and reports what had landed", async () => {
    const actions = plan();
    const before = snapshotTree(root);
    const modeBefore = statSync(abs("a.txt")).mode & 0o777;
    const injected = new Error("injected failure");
    const error = await failure(
      applyAdoptActions({
        root,
        actions,
        io: {
          beforeStep: ({ index }: { index: number }) => {
            if (index === 3) throw injected;
          },
        },
      }),
    );
    expect([...error.written].sort()).toEqual([
      "a.txt",
      "nested/deep/new.txt",
      "package.json",
    ]);
    expect(error.rolledBack).toBe(true);
    expect(error.leftovers).toEqual([]);
    expect(error.cause).toBe(injected);
    expect(snapshotTree(root)).toEqual(before);
    expect(statSync(abs("a.txt")).mode & 0o777).toBe(modeBefore);
    expectNoTransactionResidue();
  });

  it("a failure on the first step rolls back trivially with nothing written", async () => {
    const actions = plan();
    const before = snapshotTree(root);
    const error = await failure(
      applyAdoptActions({
        root,
        actions,
        io: {
          beforeStep: () => {
            throw new Error("first");
          },
        },
      }),
    );
    expect(error.written).toEqual([]);
    expect(error.rolledBack).toBe(true);
    expect(snapshotTree(root)).toEqual(before);
    expectNoTransactionResidue();
  });

  // Sabotage helper: turn a landed file into a non-empty directory so the
  // rollback of that step (unlink, or rename over it) cannot succeed.
  const sabotage = (rel: string): void => {
    rmSync(abs(rel), { recursive: true, force: true });
    mkdirSync(abs(rel));
    writeFileSync(join(abs(rel), "child"), "x");
  };

  it("reports a failed rollback (rolledBack false, leftovers), still restores what it can, and keeps txn/ for recovery", async () => {
    put("b.txt", "B original");
    const actions = [
      install("a-new.txt", "new"),
      take("b.txt", "B taken"),
      install("c.txt", "c"),
    ];
    const error = await failure(
      applyAdoptActions({
        root,
        actions,
        io: {
          beforeStep: ({ index }: { index: number }) => {
            if (index !== 2) return;
            sabotage("a-new.txt");
            throw new Error("injected");
          },
        },
      }),
    );
    expect(error.written).toEqual(["a-new.txt", "b.txt"]);
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toEqual(["a-new.txt"]);
    expect(read("b.txt").toString()).toBe("B original");
    expect(existsSync(abs("c.txt"))).toBe(false);
    expect(existsSync(headless("txn/journal.json"))).toBe(true);
    expect(existsSync(headless("lock"))).toBe(false);
    expect(existsSync(headless("applied.json"))).toBe(false);
  });

  it("rolls a leftover journal back at the start of the next run, warns, then applies the new plan", async () => {
    put("a.txt", "A original");
    const crashed = [take("a.txt", "A taken"), install("b.txt", "b")];
    await failure(
      applyAdoptActions({
        root,
        actions: crashed,
        io: {
          beforeStep: ({ index }: { index: number }) => {
            if (index !== 1) return;
            sabotage("a.txt");
            throw new Error("injected");
          },
        },
      }),
    );
    // The operator clears the obstruction and leaves the taken bytes in
    // place; the backup is still in txn/.
    rmSync(abs("a.txt"), { recursive: true });
    writeFileSync(abs("a.txt"), "A taken");
    expect(existsSync(headless("txn/journal.json"))).toBe(true);

    const result = await applyAdoptActions({
      root,
      actions: [install("c.txt", "c")],
    });
    expect(read("a.txt").toString()).toBe("A original");
    expect(read("c.txt").toString()).toBe("c");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/journal|recover|roll/i);
    expect(result.changes.map((c: { path: string }) => c.path)).toEqual([
      "c.txt",
    ]);
    expect(existsSync(headless("txn"))).toBe(false);
    expect(existsSync(headless("lock"))).toBe(false);
  });

  it.each([
    ["not JSON", "{ garbled"],
    ["not an object", "[]"],
    ["an empty object", "{}"],
    ["empty", ""],
  ])(
    "refuses a journal that is %s instead of guessing, touching nothing",
    async (_n, content) => {
      put(".groundwork/headless/txn/journal.json", content);
      const action = install("new.txt", "n");
      const before = snapshotTree(root);
      const error = await failure(
        applyAdoptActions({ root, actions: [action] }),
      );
      expect(error.message).toMatch(/journal/i);
      expect(existsSync(abs("new.txt"))).toBe(false);
      expect(snapshotTree(root)).toEqual(before);
      expect(existsSync(headless("lock"))).toBe(false);
    },
  );

  it("refuses to run while another run holds the lock, leaving the lock and the tree alone", async () => {
    put(".groundwork/headless/lock", "pid 1 2020-01-01T00:00:00.000Z");
    const action = install("new.txt", "n");
    const before = snapshotTree(root);
    const error = await failure(applyAdoptActions({ root, actions: [action] }));
    expect(error.message).toContain(headless("lock"));
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each([2, 5, 12])(
    "of %i concurrent applies against one project exactly one proceeds",
    async (n) => {
      const actions = [
        install("only.txt", "once"),
        install("also.txt", "once"),
      ];
      const results = await Promise.allSettled(
        Array.from({ length: n }, () =>
          applyAdoptActions({
            root,
            actions,
            io: {
              beforeStep: async () => {
                await new Promise((resolve) => setImmediate(resolve));
              },
            },
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toBeInstanceOf(ApplyError);
        }
      }
      expect(read("only.txt").toString()).toBe("once");
      expect(read("also.txt").toString()).toBe("once");
      expect(existsSync(headless("lock"))).toBe(false);
      expect(existsSync(headless("txn"))).toBe(false);
    },
  );
});

describe("applyAdoptActions: dryRun", () => {
  function fixture(base: string): Action[] {
    put("a.txt", "old", base);
    put("package.json", '{\n  "a": 1,\n  "b": 2\n}\n', base);
    return [
      install("new/dir/f.txt", "fresh\r\n", base),
      take("a.txt", "new", base),
      merge("package.json", '{"a":5}', ["a"], base),
    ];
  }

  it("creates nothing anywhere (no lock, txn, applied.json, parents) and returns what a real run returns", async () => {
    const dryRoot = mkdtempSync(join(tmpdir(), "hl-apply-dry-"));
    made.push(dryRoot);
    const dryActions = fixture(dryRoot);
    const before = snapshotTree(dryRoot);
    const dry = await applyAdoptActions({
      root: dryRoot,
      actions: dryActions,
      dryRun: true,
    });
    expect(snapshotTree(dryRoot)).toEqual(before);
    expect(existsSync(join(dryRoot, ".groundwork", "headless"))).toBe(false);

    const real = await applyAdoptActions({ root, actions: fixture(root) });
    expect(dry.changes).toEqual(real.changes);
    expect(dry.changes.map((c: { path: string }) => c.path)).toEqual([
      "a.txt",
      "new/dir/f.txt",
      "package.json",
    ]);
  });

  it("does not take the lock: an existing lock is neither refused nor touched", async () => {
    const actions = fixture(root);
    put(".groundwork/headless/lock", "someone else");
    const result = await applyAdoptActions({ root, actions, dryRun: true });
    expect(result.changes).toHaveLength(3);
    expect(read(".groundwork/headless/lock").toString()).toBe("someone else");
  });

  it("still refuses a staged copy whose sha256 does not match", async () => {
    const action = install("x.txt", "bytes");
    await failure(
      applyAdoptActions({
        root,
        actions: [{ ...action, sha256: sha256Hex("different") }],
        dryRun: true,
      }),
    );
  });
});

describe("types", () => {
  it("ApplyError carries the rollback report", () => {
    expectTypeOf<ApplyError["written"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<ApplyError["rolledBack"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ApplyError["leftovers"]>().toEqualTypeOf<readonly string[]>();
  });

  it("applyAdoptActions resolves to changes and warnings", () => {
    type Result = Awaited<ReturnType<typeof applyAdoptActions>>;
    expectTypeOf<Result["warnings"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Result["changes"][number]["class"]>().toEqualTypeOf<
      "addition" | "conflict"
    >();
    expectTypeOf<Result["changes"][number]["sha256Before"]>().toEqualTypeOf<
      string | null
    >();
  });
});
