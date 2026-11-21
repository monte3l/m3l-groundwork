// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Edge cases of `applyAdoptActions` (src/headless/apply.ts) beyond
 * `headless-apply.test.ts`: refusals found while verifying the plan, the
 * merge-keys rewrite rules, a failure between verification and write, and
 * the recovery of a leftover journal (`.groundwork/headless/txn/`), which
 * is set up by writing the journal by hand so each undo decision (restore,
 * already fine, edited since, tampered) is exercised deterministically.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { applyAdoptActions } from "../src/headless/apply.js";
import { ApplyError } from "../src/headless/errors.js";
import { parseJournal } from "../src/headless/internal/apply-journal.js";
import { sha256Hex } from "../src/manifest.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";
import {
  failure,
  installStep,
  makeEnv,
  replaceStep,
} from "./headless-apply-fixture.js";
import type { Action, Env } from "./headless-apply-fixture.js";

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  env.dispose();
});

const run = (actions: readonly Action[] = []) =>
  applyAdoptActions({ root: env.root, actions });

const cannotUsePermissions =
  process.platform === "win32" || process.getuid?.() === 0;

describe("applyAdoptActions: plan refusals before any write", () => {
  it("refuses a path listed twice, writing nothing", async () => {
    env.put("t.txt", "target");
    const actions = [env.take("t.txt", "one"), env.take("t.txt", "two")];
    const before = snapshotTree(env.root);
    const error = await failure(run(actions));
    expect(error.written).toEqual([]);
    expect(snapshotTree(env.root)).toEqual(before);
    env.noResidue();
  });

  it.each(["/abs/x.txt", "../escape.txt", "a/../b.txt", ""])(
    "refuses the action path %j, writing nothing",
    async (path) => {
      env.put("t.txt", "target");
      const good = env.take("t.txt", "taken");
      const bad = { ...env.install("x.txt", "x"), path };
      const before = snapshotTree(env.root);
      const error = await failure(run([good, bad]));
      expect(error.written).toEqual([]);
      expect(snapshotTree(env.root)).toEqual(before);
      env.noResidue();
    },
  );

  it.each([
    ["the file first", ["a", "a/b.txt"]],
    ["the file last", ["a/b.txt", "a"]],
  ])(
    "refuses a write path another install needs as a directory (%s)",
    async (_n, order) => {
      const actions = order.map((p) => env.install(p, `bytes of ${p}`));
      const before = snapshotTree(env.root);
      const error = await failure(run(actions));
      expect(error.message).toContain("directory");
      expect(error.written).toEqual([]);
      expect(snapshotTree(env.root)).toEqual(before);
      env.noResidue();
    },
  );

  it("refuses a staged copy read through a symlinked staging root", async () => {
    // .groundwork/baseline itself is a symlink: a read through it must be refused.
    const outside = env.extraDir();
    env.put("x.txt.staged", "outside", outside);
    symlinkSync(outside, env.abs(".groundwork/baseline"));
    const action = {
      kind: "install-staged" as const,
      path: "x.txt",
      stagedPath: ".groundwork/baseline/x.txt.staged",
      sha256: sha256Hex("outside"),
    };
    const before = snapshotTree(env.root);
    await failure(run([action]));
    expect(snapshotTree(env.root)).toEqual(before);
    expect(existsSync(env.abs("x.txt"))).toBe(false);
  });

  it("take-divergent refuses a target below a symlinked ancestor, sparing the file behind it", async () => {
    const outside = env.extraDir();
    env.put("t.txt", "victim", outside);
    symlinkSync(outside, env.abs("linked"));
    const action = env.take("linked/t.txt", "taken");
    const before = snapshotTree(env.root);
    await failure(run([action]));
    expect(snapshotTree(env.root)).toEqual(before);
    expect(readFileSync(join(outside, "t.txt"), "utf8")).toBe("victim");
  });
});

describe("applyAdoptActions: merge-keys", () => {
  it("refuses a key the staged copy does not hold (fail closed), leaving the target untouched", async () => {
    env.put("package.json", '{"a":1}');
    const action = env.merge("package.json", '{"b":2}', ["a"]);
    const before = snapshotTree(env.root);
    const error = await failure(run([action]));
    expect(error.message).toContain('"a"');
    expect(error.written).toEqual([]);
    expect(snapshotTree(env.root)).toEqual(before);
    env.noResidue();
  });

  it("refuses when only one of several takeKeys is missing from the staged copy", async () => {
    env.put("package.json", '{"a":1}');
    const action = env.merge("package.json", '{"a":2}', ["a", "gone"]);
    const before = snapshotTree(env.root);
    await failure(run([action]));
    expect(snapshotTree(env.root)).toEqual(before);
  });

  it.each([
    ["a line comment", '{\n  // keep me\n  "a": 1\n}\n'],
    ["a block comment", '{ /* c */ "a": 1 }'],
    ["a trailing comma", '{\n  "a": 1,\n}\n'],
  ])(
    "refuses a JSONC target with %s, telling the caller to delegate it",
    async (_n, target) => {
      env.put("tsconfig.json", target);
      const action = env.merge("tsconfig.json", '{"a":2}', ["a"]);
      const before = snapshotTree(env.root);
      const error = await failure(run([action]));
      expect(error.message).toContain("delegate it instead");
      expect(snapshotTree(env.root)).toEqual(before);
      expect(readFileSync(env.abs("tsconfig.json"), "utf8")).toBe(target);
    },
  );

  it.each([
    ["the target is not JSON at all", "{ nope", '{"a":1}'],
    ["the target is a JSON array", "[1]", '{"a":1}'],
    ["the staged copy is a JSON array", '{"a":0}', "[1,2]"],
    ["the staged copy is not JSON", '{"a":0}', "not json"],
    ["the staged copy is a bare string", '{"a":0}', '"a"'],
  ])("refuses when %s", async (_n, target, staged) => {
    env.put("package.json", target);
    const action = env.merge("package.json", staged, ["a"]);
    const before = snapshotTree(env.root);
    await failure(run([action]));
    expect(snapshotTree(env.root)).toEqual(before);
    env.noResidue();
  });

  it.each([
    [
      "CRLF line endings and a trailing newline",
      '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n',
      '{\r\n  "a": 5,\r\n  "b": 2\r\n}\r\n',
    ],
    [
      "CRLF line endings and no trailing newline",
      '{\r\n  "a": 1,\r\n  "b": 2\r\n}',
      '{\r\n  "a": 5,\r\n  "b": 2\r\n}',
    ],
    [
      "LF endings, 4-space indentation and a trailing newline",
      '{\n    "a": 1,\n    "b": 2\n}\n',
      '{\n    "a": 5,\n    "b": 2\n}\n',
    ],
    [
      "LF endings, tab indentation and no trailing newline",
      '{\n\t"a": 1,\n\t"b": 2\n}',
      '{\n\t"a": 5,\n\t"b": 2\n}',
    ],
  ])("keeps the target's style: %s", async (_n, target, expected) => {
    env.put("package.json", target);
    await run([env.merge("package.json", '{"a":5}', ["a"])]);
    expect(readFileSync(env.abs("package.json"), "utf8")).toBe(expected);
  });
});

describe("applyAdoptActions: a change between verification and write", () => {
  it("refuses an install whose parent directory appeared meanwhile, keeping that directory", async () => {
    const action = env.install("newdir/f.txt", "ours");
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [action],
        io: { beforeStep: () => mkdirSync(env.abs("newdir")) },
      }),
    );
    expect(error.rolledBack).toBe(true);
    expect(error.written).toEqual([]);
    expect(existsSync(env.abs("newdir/f.txt"))).toBe(false);
    expect(statSync(env.abs("newdir")).isDirectory()).toBe(true);
    env.noResidue();
  });

  it("refuses an install whose missing parent became a symlink meanwhile, writing nothing through it", async () => {
    const outside = env.extraDir();
    const action = env.install("newdir/f.txt", "ours");
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [action],
        io: { beforeStep: () => symlinkSync(outside, env.abs("newdir")) },
      }),
    );
    expect(error.written).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a take whose target was edited meanwhile, keeping the edit and rolling earlier writes back", async () => {
    env.put("t.txt", "original");
    env.put("u.txt", "u original");
    const actions = [env.take("t.txt", "taken"), env.take("u.txt", "u taken")];
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions,
        io: {
          beforeStep: ({ path }) => {
            if (path === "u.txt") writeFileSync(env.abs("u.txt"), "edited");
          },
        },
      }),
    );
    expect(error.written).toEqual(["t.txt"]);
    expect(error.rolledBack).toBe(true);
    expect(env.read("t.txt").toString()).toBe("original");
    expect(env.read("u.txt").toString()).toBe("edited");
    env.noResidue();
  });

  it("refuses a take whose target was removed meanwhile", async () => {
    env.put("t.txt", "original");
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.take("t.txt", "taken")],
        io: { beforeStep: () => rmSync(env.abs("t.txt")) },
      }),
    );
    expect(error.written).toEqual([]);
    expect(existsSync(env.abs("t.txt"))).toBe(false);
  });

  it.skipIf(cannotUsePermissions)(
    "undoes a take whose replace failed (read-only directory), leaving the tree as it was",
    async () => {
      env.put("ro/t.txt", "original");
      env.put("other.txt", "other");
      const actions = [
        env.take("other.txt", "taken"),
        env.take("ro/t.txt", "taken"),
      ];
      const before = snapshotTree(env.root);
      try {
        const error = await failure(
          applyAdoptActions({
            root: env.root,
            actions,
            io: {
              beforeStep: ({ path }) => {
                if (path === "ro/t.txt") chmodSync(env.abs("ro"), 0o500);
              },
            },
          }),
        );
        expect(error.rolledBack).toBe(true);
        expect(error.written).toEqual(["other.txt"]);
        expect(error.cause).toBeInstanceOf(Error);
      } finally {
        chmodSync(env.abs("ro"), 0o700);
      }
      expect(readdirSync(env.abs("ro"))).toEqual(["t.txt"]);
      expect(snapshotTree(env.root)).toEqual(before);
      env.noResidue();
    },
  );

  it("reports a post-commit applied.json failure as not rolled back, with every write landed and no leftovers", async () => {
    env.put("t.txt", "original");
    const actions = [env.take("t.txt", "taken"), env.install("n.txt", "new")];
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions,
        io: {
          beforeStep: ({ index }) => {
            if (index === 1) {
              // A non-empty directory where applied.json must land.
              mkdirSync(env.headless("applied.json"));
              writeFileSync(env.headless("applied.json/x"), "x");
            }
          },
        },
      }),
    );
    expect(error.message).toContain("applied.json");
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toEqual([]);
    expect([...error.written].sort()).toEqual(["n.txt", "t.txt"]);
    expect(env.read("t.txt").toString()).toBe("taken");
    expect(env.read("n.txt").toString()).toBe("new");
    expect(existsSync(env.headless("txn"))).toBe(false);
    expect(existsSync(env.headless("lock"))).toBe(false);
  });
});

describe("applyAdoptActions: txn/ handling", () => {
  it("refuses a txn that is not a directory, touching nothing", async () => {
    env.put(".groundwork/headless/txn", "i am a file");
    const action = env.install("n.txt", "n");
    const before = snapshotTree(env.root);
    const error = await failure(run([action]));
    expect(error.message).toContain("not a directory");
    expect(snapshotTree(env.root)).toEqual(before);
    expect(existsSync(env.headless("lock"))).toBe(false);
  });

  it("removes a txn/ that holds no journal, with one warning, then applies", async () => {
    env.put(".groundwork/headless/txn/backup/0", "orphan backup");
    const result = await run([env.install("n.txt", "n")]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no journal/);
    expect(env.read("n.txt").toString()).toBe("n");
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it.each([
    [
      "a journal that is a symlink",
      (): void => {
        const outside = env.extraDir();
        env.put("j.json", "{}", outside);
        env.put(".groundwork/headless/txn/x", "x");
        symlinkSync(join(outside, "j.json"), env.headless("txn/journal.json"));
      },
    ],
    [
      "a journal that is a directory",
      (): void => {
        mkdirSync(env.headless("txn/journal.json"), { recursive: true });
      },
    ],
  ])("refuses %s as unreadable, touching nothing", async (_n, arrange) => {
    arrange();
    const action = env.install("n.txt", "n");
    const before = snapshotTree(env.root);
    const error = await failure(run([action]));
    expect(error.message).toMatch(/could not read the leftover apply journal/);
    expect(error.cause).toBeDefined();
    expect(snapshotTree(env.root)).toEqual(before);
    expect(existsSync(env.headless("lock"))).toBe(false);
  });
});

describe("applyAdoptActions: tampered leftover journal", () => {
  const sha = (text: string): string => sha256Hex(text);
  const replace = () => ({
    kind: "take-divergent",
    path: "a.txt",
    sha256After: sha("new"),
    before: { sha256: sha("old"), mode: 0o644, backup: "0" },
    createdDirs: [],
  });
  const create = () => ({
    kind: "install-staged",
    path: "d/f.txt",
    sha256After: sha("new"),
    before: null,
    createdDirs: ["d"],
  });
  const withBefore = (patch: Record<string, unknown>) => ({
    ...replace(),
    before: { ...replace().before, ...patch },
  });
  const doc = (steps: unknown) => ({
    schema: "groundwork.apply-journal",
    schemaVersion: 1,
    steps,
  });

  const tampered: Array<[string, unknown]> = [
    ["another schema", { ...doc([]), schema: "groundwork.other" }],
    ["another schemaVersion", { ...doc([]), schemaVersion: 2 }],
    ["a string schemaVersion", { ...doc([]), schemaVersion: "1" }],
    ["steps that are not an array", doc({ 0: replace() })],
    ["a null step", doc([null])],
    [
      "a sha256After that is not hex",
      doc([{ ...replace(), sha256After: "abc" }]),
    ],
    [
      "an upper-case sha256After",
      doc([{ ...replace(), sha256After: sha("new").toUpperCase() }]),
    ],
    ["a before.sha256 that is not hex", doc([withBefore({ sha256: "zz" })])],
    ["a negative mode", doc([withBefore({ mode: -1 })])],
    ["a mode above 0o7777", doc([withBefore({ mode: 0o10000 })])],
    ["a fractional mode", doc([withBefore({ mode: 1.5 })])],
    ["a string mode", doc([withBefore({ mode: "420" })])],
    [
      "a backup name that climbs out",
      doc([withBefore({ backup: "../outside" })]),
    ],
    ["a backup name with a separator", doc([withBefore({ backup: "a/b" })])],
    ["an empty backup name", doc([withBefore({ backup: "" })])],
    [
      "an install carrying a before",
      doc([{ ...create(), before: replace().before }]),
    ],
    ["a take without a before", doc([{ ...replace(), before: null }])],
    ["an unknown kind", doc([{ ...replace(), kind: "delete" }])],
    ["an inherited-property kind", doc([{ ...replace(), kind: "toString" }])],
    [
      "a createdDirs that is not an array",
      doc([{ ...create(), createdDirs: "d" }]),
    ],
    ["a missing createdDirs", doc([{ ...create(), createdDirs: undefined }])],
    [
      "a createdDirs entry that is not a string",
      doc([{ ...create(), createdDirs: [5] }]),
    ],
    [
      "a createdDirs entry that is not an ancestor",
      doc([{ ...create(), createdDirs: ["other"] }]),
    ],
    [
      "a createdDirs entry that is the file itself",
      doc([{ ...create(), createdDirs: ["d/f.txt"] }]),
    ],
    [
      "a createdDirs entry below the file",
      doc([{ ...create(), createdDirs: ["d/f.txt/x"] }]),
    ],
    [
      "an absolute step path",
      doc([{ ...create(), path: "/etc/x.txt", createdDirs: [] }]),
    ],
    [
      "a step path that climbs out",
      doc([{ ...create(), path: "../x.txt", createdDirs: [] }]),
    ],
    [
      "a valid step followed by a tampered one",
      doc([replace(), { ...replace(), kind: "delete" }]),
    ],
  ];

  it.each(tampered)(
    "refuses a journal with %s, touching nothing",
    async (_n, journal) => {
      env.put("a.txt", "new");
      env.put(".groundwork/headless/txn/journal.json", JSON.stringify(journal));
      env.put(".groundwork/headless/txn/backup/0", "old");
      const action = env.install("fresh.txt", "n");
      const before = snapshotTree(env.root);
      const error = await failure(run([action]));
      expect(error.message).toContain("not one this CLI wrote");
      expect(snapshotTree(env.root)).toEqual(before);
      expect(env.read("a.txt").toString()).toBe("new");
      expect(existsSync(env.headless("lock"))).toBe(false);
    },
  );

  it("accepts a well-formed journal, with no steps, and removes it with a warning", async () => {
    env.writeJournal([]);
    const result = await run([]);
    expect(result.warnings).toHaveLength(1);
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it("parseJournal round-trips what a run wrote", () => {
    expect(parseJournal(JSON.stringify(doc([replace(), create()])))).toEqual([
      { ...replace() },
      { ...create() },
    ]);
  });
});

describe("applyAdoptActions: recovering a leftover journal", () => {
  it("restores a replaced file from its backup, including its mode, and warns once", async () => {
    env.put("a.txt", "taken");
    chmodSync(env.abs("a.txt"), 0o600);
    env.writeJournal([replaceStep("a.txt", "original", "taken", 0o640)], {
      "0": "original",
    });
    const result = await run([]);
    expect(env.read("a.txt").toString()).toBe("original");
    if (process.platform !== "win32") {
      expect(statSync(env.abs("a.txt")).mode & 0o777).toBe(0o640);
    }
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/rolled back/);
    expect(existsSync(env.headless("txn"))).toBe(false);
    expect(existsSync(env.headless("lock"))).toBe(false);
  });

  it("leaves alone a replaced file that still holds the original (the step never ran)", async () => {
    env.put("a.txt", "original");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const result = await run([]);
    expect(env.read("a.txt").toString()).toBe("original");
    expect(result.warnings).toHaveLength(1);
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it("removes an installed file that holds the step's bytes, then the directories it created, innermost first", async () => {
    env.put("d/e/f.txt", "installed");
    env.writeJournal([installStep("d/e/f.txt", "installed", ["d", "d/e"])]);
    await run([]);
    expect(existsSync(env.abs("d"))).toBe(false);
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it("treats an install that never created its file as already undone", async () => {
    env.writeJournal([installStep("d/f.txt", "installed", ["d"])]);
    const result = await run([]);
    expect(result.warnings).toHaveLength(1);
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it("reports an installed file edited since as a leftover, keeps it and txn/, and releases the lock", async () => {
    env.put("n.txt", "edited by the owner");
    env.writeJournal([installStep("n.txt", "installed")]);
    const error = await failure(run([]));
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toEqual(["n.txt"]);
    expect(error.written).toEqual([]);
    expect(env.read("n.txt").toString()).toBe("edited by the owner");
    expect(existsSync(env.headless("txn/journal.json"))).toBe(true);
    expect(existsSync(env.headless("lock"))).toBe(false);
  });

  it("reports a replaced file edited since (neither original nor written) as a leftover and keeps the edit", async () => {
    env.put("a.txt", "edited by the owner");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["a.txt"]);
    expect(env.read("a.txt").toString()).toBe("edited by the owner");
    expect(existsSync(env.headless("txn/journal.json"))).toBe(true);
  });

  it("reports a replaced file whose backup no longer matches its hash, leaving the target as it is", async () => {
    env.put("a.txt", "taken");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "someone rewrote the backup",
    });
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["a.txt"]);
    expect(env.read("a.txt").toString()).toBe("taken");
    expect(existsSync(env.headless("txn"))).toBe(true);
  });

  it("reports a replaced file whose backup is missing as a leftover", async () => {
    env.put("a.txt", "taken");
    env.writeJournal([replaceStep("a.txt", "original", "taken")]);
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["a.txt"]);
    expect(env.read("a.txt").toString()).toBe("taken");
  });

  it("reports a replaced target that is now a directory as a leftover", async () => {
    mkdirSync(env.abs("a.txt"));
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["a.txt"]);
    expect(statSync(env.abs("a.txt")).isDirectory()).toBe(true);
  });

  it("does not follow a symlinked ancestor while rolling back, reporting the path and sparing the file behind it", async () => {
    const outside = env.extraDir();
    env.put("f.txt", "installed", outside);
    symlinkSync(outside, env.abs("d"));
    env.writeJournal([installStep("d/f.txt", "installed", [])]);
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["d/f.txt"]);
    expect(readFileSync(join(outside, "f.txt"), "utf8")).toBe("installed");
  });

  it("keeps a created directory that is no longer empty, with a warning, and does not leave the step as a leftover", async () => {
    env.put("d/f.txt", "installed");
    env.put("d/foreign.txt", "not ours");
    env.writeJournal([installStep("d/f.txt", "installed", ["d"])]);
    const result = await run([]);
    expect(existsSync(env.abs("d/f.txt"))).toBe(false);
    expect(env.read("d/foreign.txt").toString()).toBe("not ours");
    expect(result.warnings.join("\n")).toContain("d");
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it("reports a created directory that became a file as a leftover", async () => {
    env.put("d", "a file now");
    env.writeJournal([installStep("d/f.txt", "installed", ["d"])]);
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["d/f.txt"]);
    expect(env.read("d").toString()).toBe("a file now");
  });

  it("undoes what it can: a clean step is restored while a blocked one is the only leftover, listed in write order", async () => {
    env.put("a.txt", "taken");
    env.put("b.txt", "edited b");
    env.put("c.txt", "edited c");
    env.writeJournal(
      [
        replaceStep("a.txt", "original", "taken"),
        {
          ...replaceStep("b.txt", "b original", "b taken"),
          before: { sha256: sha256Hex("b original"), mode: 0o644, backup: "1" },
        },
        {
          ...replaceStep("c.txt", "c original", "c taken"),
          before: { sha256: sha256Hex("c original"), mode: 0o644, backup: "2" },
        },
      ],
      { "0": "original", "1": "b original", "2": "c original" },
    );
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["b.txt", "c.txt"]);
    expect(error.rolledBack).toBe(false);
    expect(env.read("a.txt").toString()).toBe("original");
    expect(env.read("b.txt").toString()).toBe("edited b");
  });

  it("recovers, then still runs the new plan, in one call", async () => {
    env.put("a.txt", "taken");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const result = await run([env.install("new.txt", "n")]);
    expect(env.read("a.txt").toString()).toBe("original");
    expect(env.read("new.txt").toString()).toBe("n");
    expect(result.warnings).toHaveLength(1);
    expect(result.changes.map((c) => c.path)).toEqual(["new.txt"]);
  });

  it("does not run the new plan when the leftover cannot be rolled back", async () => {
    env.put("n.txt", "edited");
    env.writeJournal([installStep("n.txt", "installed")]);
    await failure(run([env.install("new.txt", "n")]));
    expect(existsSync(env.abs("new.txt"))).toBe(false);
  });
});

describe("applyAdoptActions: dryRun beside a leftover journal", () => {
  it("neither recovers nor warns: the journal, the backup and the tree stay as they are", async () => {
    env.put("a.txt", "taken");
    env.put("b.txt", "target");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const actions = [env.take("b.txt", "b taken")];
    const before = snapshotTree(env.root);
    const result = await applyAdoptActions({
      root: env.root,
      actions,
      dryRun: true,
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes.map((c) => c.path)).toEqual(["b.txt"]);
    expect(snapshotTree(env.root)).toEqual(before);
    expect(existsSync(env.headless("txn/journal.json"))).toBe(true);
  });

  it("does not even look at a journal that is garbled", async () => {
    env.put(".groundwork/headless/txn/journal.json", "{ garbled");
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
      dryRun: true,
    });
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });
});

describe("ApplyError from the executor", () => {
  it("is the class the library throws for a refusal", async () => {
    const error = await failure(
      run([
        {
          kind: "install-staged",
          path: "x.txt",
          stagedPath: `${".groundwork/baseline"}/none.staged`,
          sha256: sha256Hex(""),
        },
      ]),
    );
    expect(error).toBeInstanceOf(ApplyError);
    expect(error.name).toBe("ApplyError");
  });
});
