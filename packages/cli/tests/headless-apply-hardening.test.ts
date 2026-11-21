// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The hardening contract of `applyAdoptActions` (src/headless/apply.ts) that
 * real-filesystem tests can prove: owner-only backups, what a recovery
 * reports when the same run's plan then fails, the order undo checks the
 * target and backup in, rollback reasons, the merge-keys byte-exact round
 * trip rule, the executor's `.groundwork/` and `.git` refusals and a created
 * directory that is no longer empty at recovery time. Faults a real disk
 * cannot raise live in `headless-apply-hardening-faults.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { applyAdoptActions } from "../src/headless/apply.js";
import {
  parseJournal,
  serializeJournal,
} from "../src/headless/internal/apply-journal.js";
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

/** The reasons an error's `cause` carries: an AggregateError's errors or an array, as strings. */
function reasonsOf(cause: unknown): string[] {
  const items: unknown[] =
    cause instanceof AggregateError
      ? cause.errors
      : Array.isArray(cause)
        ? (cause as unknown[])
        : [];
  return items.map((item) =>
    item instanceof Error ? item.message : String(item),
  );
}

describe.skipIf(process.platform === "win32")("backups are owner-only", () => {
  it.each([0o644, 0o600, 0o755])(
    "writes the backup of a %o original with no group or other permission bits, and still restores the original mode",
    async (mode) => {
      env.put("t.txt", "original");
      chmodSync(env.abs("t.txt"), mode);
      const backupModes: number[] = [];
      const backupBytes: string[] = [];
      const actions = [env.take("t.txt", "taken"), env.install("n.txt", "n")];
      await failure(
        applyAdoptActions({
          root: env.root,
          actions,
          io: {
            beforeStep: ({ index }) => {
              if (index === 0) {
                for (const name of readdirSync(env.headless("txn/backup"))) {
                  const file = env.headless(`txn/backup/${name}`);
                  backupModes.push(statSync(file).mode & 0o777);
                  backupBytes.push(readFileSync(file, "utf8"));
                }
              }
              if (index === 1) throw new Error("injected");
            },
          },
        }),
      );
      expect(backupModes).toHaveLength(1);
      expect((backupModes[0] ?? 0o777) & 0o077).toBe(0);
      expect(backupBytes).toEqual(["original"]);
      expect(env.read("t.txt").toString()).toBe("original");
      expect(statSync(env.abs("t.txt")).mode & 0o777).toBe(mode);
    },
  );
});

describe("what a recovery reports when the same run's plan then fails", () => {
  const leftoverJournal = (): void => {
    env.put("a.txt", "taken");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
  };

  it("names the restored files, and no longer claims nothing was written, when the plan is refused", async () => {
    leftoverJournal();
    const error = await failure(run([env.take("gone.txt", "x")]));
    expect(error.message).toContain("a.txt");
    expect(error.message).not.toContain("nothing was written");
    expect(env.read("a.txt").toString()).toBe("original");
  });

  it("names the restored files when the plan's own transaction fails", async () => {
    leftoverJournal();
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.install("n.txt", "n")],
        io: {
          beforeStep: () => {
            throw new Error("injected");
          },
        },
      }),
    );
    expect(error.message).toContain("a.txt");
    expect(error.message).toContain("injected");
    expect(env.read("a.txt").toString()).toBe("original");
    expect(existsSync(env.abs("n.txt"))).toBe(false);
  });

  it("still says nothing was written for a plain refusal with no recovery", async () => {
    const error = await failure(run([env.take("gone.txt", "x")]));
    expect(error.message).toContain("nothing was written");
  });
});

describe("recovery undo and report", () => {
  it("treats a replaced file whose target already holds the original as restored even when its backup is missing", async () => {
    env.put("a.txt", "original");
    env.writeJournal([replaceStep("a.txt", "original", "taken")]);
    const result = await run([]);
    expect(env.read("a.txt").toString()).toBe("original");
    expect(existsSync(env.headless("txn"))).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it("lists the restored and the already-original paths in the recovery warning", async () => {
    env.put("a.txt", "taken");
    env.put("b.txt", "b original");
    env.writeJournal(
      [
        replaceStep("a.txt", "original", "taken"),
        {
          ...replaceStep("b.txt", "b original", "b taken"),
          before: {
            sha256: sha256Hex("b original"),
            mode: 0o644,
            backup: "1",
          },
        },
      ],
      { "0": "original", "1": "b original" },
    );
    const result = await run([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("a.txt");
    expect(result.warnings[0]).toContain("b.txt");
  });

  it("carries the reason for each leftover a failed recovery cannot restore", async () => {
    env.put("a.txt", "edited a");
    env.put("b.txt", "edited b");
    env.writeJournal(
      [
        replaceStep("a.txt", "original", "taken"),
        {
          ...replaceStep("b.txt", "b original", "b taken"),
          before: {
            sha256: sha256Hex("b original"),
            mode: 0o644,
            backup: "1",
          },
        },
      ],
      { "0": "original" },
    );
    const error = await failure(run([]));
    expect(error.leftovers).toEqual(["a.txt", "b.txt"]);
    const reasons = reasonsOf(error.cause);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("a.txt");
    expect(reasons[0]).toMatch(/hash|changed|edited|differ/i);
    expect(reasons[1]).toContain("b.txt");
    expect(reasons[1]).toMatch(/backup/i);
  });

  it("keeps a created directory that is no longer empty, warning about it, and lets later runs proceed", async () => {
    env.put("d/f.txt", "installed");
    env.put("d/foreign.txt", "not ours");
    env.writeJournal([installStep("d/f.txt", "installed", ["d"])]);
    const result = await run([]);
    expect(existsSync(env.abs("d/f.txt"))).toBe(false);
    expect(env.read("d/foreign.txt").toString()).toBe("not ours");
    expect(result.warnings.join("\n")).toContain("d");
    expect(existsSync(env.headless("txn"))).toBe(false);
    const again = await run([env.install("n.txt", "n")]);
    expect(again.warnings).toEqual([]);
    expect(env.read("n.txt").toString()).toBe("n");
  });
});

describe("ApplyError.written", () => {
  it("lists a replaced file that landed before a later step failed", async () => {
    env.put("t.txt", "original");
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.take("t.txt", "taken"), env.install("n.txt", "n")],
        io: {
          beforeStep: ({ index }) => {
            if (index === 1) throw new Error("injected");
          },
        },
      }),
    );
    expect(error.written).toEqual(["t.txt"]);
    expect(error.rolledBack).toBe(true);
    expect(env.read("t.txt").toString()).toBe("original");
  });
});

describe("a post-commit applied.json failure", () => {
  it("says the changes landed and to record them by hand, not to re-run the CLI", async () => {
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.install("n.txt", "new")],
        io: {
          beforeStep: () => {
            mkdirSync(env.headless("applied.json"));
            writeFileSync(env.headless("applied.json/x"), "x");
          },
        },
      }),
    );
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toEqual([]);
    expect(error.written).toEqual(["n.txt"]);
    expect(error.message).toMatch(/landed/);
    expect(error.message).toMatch(/manual|report|commit|record/i);
    expect(error.message).not.toMatch(/re-run/i);
    expect(env.read("n.txt").toString()).toBe("new");
  });
});

describe("merge-keys only rewrites a file it can reproduce exactly", () => {
  const staged = '{\n  "a": 2\n}\n';

  it.each([
    [
      "an inline array stringify would expand",
      '{\n  "files": ["dist"],\n  "a": 1\n}\n',
    ],
    ["a number above 2^53", '{\n  "a": 1,\n  "big": 9007199254740993\n}\n'],
    ["duplicate keys", '{\n  "a": 1,\n  "a": 3\n}\n'],
    ["a number written non-canonically", '{\n  "a": 1,\n  "n": 1.0\n}\n'],
    [
      "a unicode escape stringify would fold",
      '{\n  "a": 1,\n  "s": "\\u0041"\n}\n',
    ],
    ["a single-line document", '{"a":1}\n'],
  ])(
    "refuses a target with %s, delegating it and writing nothing",
    async (_n, text) => {
      env.put("p.json", text);
      const actions = [
        env.install("n.txt", "n"),
        env.merge("p.json", staged, ["a"]),
      ];
      const before = snapshotTree(env.root);
      const error = await failure(run(actions));
      expect(error.message).toMatch(/delegate/);
      expect(error.written).toEqual([]);
      expect(snapshotTree(env.root)).toEqual(before);
      env.noResidue();
    },
  );

  it.each([
    [
      "two-space LF with a trailing newline",
      '{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n',
      '{\n  "a": 2,\n  "b": [\n    "x"\n  ]\n}\n',
    ],
    [
      "four-space CRLF with a trailing newline",
      '{\r\n    "a": 1,\r\n    "b": true\r\n}\r\n',
      '{\r\n    "a": 2,\r\n    "b": true\r\n}\r\n',
    ],
    [
      "tab indent and no trailing newline",
      '{\n\t"a": 1,\n\t"b": null\n}',
      '{\n\t"a": 2,\n\t"b": null\n}',
    ],
  ])(
    "still merges a target that round-trips exactly: %s",
    async (_n, text, expected) => {
      env.put("p.json", text);
      await run([env.merge("p.json", staged, ["a"])]);
      expect(env.read("p.json").toString()).toBe(expected);
    },
  );
});

describe("the executor never writes under .groundwork/ or into .git", () => {
  const paths = [
    ".groundwork/x.txt",
    ".groundwork/headless/applied.json",
    ".groundwork/deep/er/x.txt",
    ".GroundWork/x.txt",
    ".git/config",
    "sub/.git/config",
    ".Git/hooks/pre-commit",
    ".git~1/config",
    "sub/.GIT~1/config",
  ];

  test.each(paths)(
    "refuses an install of %s before any write, in a real run and a dry run",
    async (path) => {
      const actions = [env.install("ok.txt", "ok"), env.install(path, "bad")];
      const before = snapshotTree(env.root);
      await failure(run(actions));
      await failure(
        applyAdoptActions({ root: env.root, actions, dryRun: true }),
      );
      expect(snapshotTree(env.root)).toEqual(before);
      env.noResidue();
    },
  );

  test.each([
    ".groundwork/headless/applied.json",
    ".git/config",
    ".git~1/config",
  ])(
    "refuses a take-divergent of the existing %s before any write",
    async (path) => {
      env.put(path, "existing");
      const actions = [env.install("ok.txt", "ok"), env.take(path, "bad")];
      const before = snapshotTree(env.root);
      await failure(run(actions));
      expect(snapshotTree(env.root)).toEqual(before);
    },
  );

  test.each([
    ".groundwork/x.txt",
    ".GroundWork/x.txt",
    ".git/config",
    "a/.git~1/config",
  ])("parseJournal refuses a journal step for %s as tampered", (path) => {
    expect(
      parseJournal(serializeJournal([installStep(path, "x")])),
    ).toBeUndefined();
    expect(
      parseJournal(serializeJournal([replaceStep(path, "a", "b")])),
    ).toBeUndefined();
  });

  it("refuses a leftover journal that points into .git, touching nothing", async () => {
    env.put(".git/config", "x");
    env.writeJournal([installStep(".git/config", "x")]);
    const error = await failure(run([]));
    expect(error.message).toMatch(/journal/);
    expect(env.read(".git/config").toString()).toBe("x");
    expect(existsSync(env.headless("txn/journal.json"))).toBe(true);
  });
});
