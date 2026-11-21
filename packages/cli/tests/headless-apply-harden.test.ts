// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Hardening of `applyAdoptActions` (src/headless/apply.ts), real filesystem:
 * the `headless/.gitignore` guard, journal trust on recovery, the recovery
 * note kept in a later plan failure, and the dry run beside a pending
 * `txn/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { applyAdoptActions } from "../src/headless/apply.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";
import {
  failure,
  installStep,
  makeEnv,
  replaceStep,
} from "./headless-apply-fixture.js";
import type { Env } from "./headless-apply-fixture.js";

let env: Env;
beforeEach(() => {
  env = makeEnv({ gitignore: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.dispose();
});

const GITIGNORE = ".groundwork/headless/.gitignore";
const lines = (text: string): string[] =>
  text.split(/\r?\n/).filter((line) => line.trim() !== "");

describe("headless/.gitignore guard", () => {
  it("is created holding exactly the lines txn/ and lock, and is not listed in changes", async () => {
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(lines(readFileSync(env.abs(GITIGNORE), "utf8"))).toEqual([
      "txn/",
      "lock",
    ]);
    expect(result.changes.map((change) => change.path)).toEqual(["n.txt"]);
    expect(result.warnings).toEqual([]);
    const applied = JSON.parse(
      readFileSync(env.headless("applied.json"), "utf8"),
    ) as { changes: { path: string }[] };
    expect(applied.changes.map((change) => change.path)).toEqual(["n.txt"]);
  });

  it("is created even when the run fails after taking the lock", async () => {
    env.put("n.txt", "already here");
    await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.install("n.txt", "n")],
      }),
    );
    expect(lines(readFileSync(env.abs(GITIGNORE), "utf8"))).toEqual([
      "txn/",
      "lock",
    ]);
  });

  it("leaves an identical file alone, without a warning", async () => {
    env.put(GITIGNORE, "txn/\nlock\n");
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(readFileSync(env.abs(GITIGNORE), "utf8")).toBe("txn/\nlock\n");
    expect(result.warnings).toEqual([]);
  });

  it("never overwrites a different file: it stays as the user left it and the run warns", async () => {
    env.put(GITIGNORE, "# mine\nsomething-else\n");
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
    });
    expect(readFileSync(env.abs(GITIGNORE), "utf8")).toBe(
      "# mine\nsomething-else\n",
    );
    expect(result.warnings.some((w) => w.includes(".gitignore"))).toBe(true);
    expect(env.read("n.txt").toString()).toBe("n");
  });

  it("is not created by a dry run", async () => {
    const actions = [env.install("n.txt", "n")];
    const before = snapshotTree(env.root);
    await applyAdoptActions({ root: env.root, actions, dryRun: true });
    expect(existsSync(env.abs(GITIGNORE))).toBe(false);
    expect(snapshotTree(env.root)).toEqual(before);
  });
});

describe.skipIf(process.platform === "win32")(
  "journal trust on recovery",
  () => {
    /** A leftover journal replacing a.txt (now holding the step's bytes). */
    function leftover(): Record<string, string> {
      env.put("a.txt", "taken");
      env.put(GITIGNORE, "txn/\nlock\n");
      env.writeJournal([replaceStep("a.txt", "original", "taken")], {
        "0": "original",
      });
      return snapshotTree(env.root);
    }

    it.each([0o600, 0o644, 0o640])(
      "still recovers a journal this executor could have written (mode %o)",
      async (mode) => {
        leftover();
        chmodSync(env.headless("txn/journal.json"), mode);
        const result = await applyAdoptActions({
          root: env.root,
          actions: [],
        });
        expect(result.warnings).toHaveLength(1);
        expect(env.read("a.txt").toString()).toBe("original");
        expect(existsSync(env.headless("txn"))).toBe(false);
      },
    );

    it.each([0o660, 0o666, 0o602, 0o620])(
      "refuses a journal with mode %o (group or world writable), touching nothing",
      async (mode) => {
        leftover();
        chmodSync(env.headless("txn/journal.json"), mode);
        const before = snapshotTree(env.root);
        const error = await failure(
          applyAdoptActions({ root: env.root, actions: [] }),
        );
        expect(error.message).toContain("journal.json");
        expect(env.read("a.txt").toString()).toBe("taken");
        expect(snapshotTree(env.root)).toEqual(before);
      },
    );

    it("refuses a journal that is a symlink to a real journal, touching nothing", async () => {
      leftover();
      const real = env.headless("txn/journal-real.json");
      renameSync(env.headless("txn/journal.json"), real);
      symlinkSync(real, env.headless("txn/journal.json"));
      const before = snapshotTree(env.root);
      const error = await failure(
        applyAdoptActions({ root: env.root, actions: [] }),
      );
      expect(error.message).toContain("journal.json");
      expect(env.read("a.txt").toString()).toBe("taken");
      expect(snapshotTree(env.root)).toEqual(before);
    });

    it("refuses a journal not owned by the current uid, touching nothing", async () => {
      leftover();
      const before = snapshotTree(env.root);
      const uid = process.getuid?.() ?? 0;
      vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      const error = await failure(
        applyAdoptActions({ root: env.root, actions: [] }),
      );
      expect(error.message).toContain("journal.json");
      expect(env.read("a.txt").toString()).toBe("taken");
      expect(snapshotTree(env.root)).toEqual(before);
    });

    it.each([0o660, 0o666, 0o602])(
      "refuses a backup with mode %o, naming it and touching nothing",
      async (mode) => {
        leftover();
        chmodSync(env.headless("txn/backup/0"), mode);
        const before = snapshotTree(env.root);
        const error = await failure(
          applyAdoptActions({ root: env.root, actions: [] }),
        );
        expect(error.message).toMatch(/backup/);
        expect(env.read("a.txt").toString()).toBe("taken");
        expect(snapshotTree(env.root)).toEqual(before);
      },
    );

    it("still recovers with a backup of mode 0600", async () => {
      leftover();
      chmodSync(env.headless("txn/backup/0"), 0o600);
      await applyAdoptActions({ root: env.root, actions: [] });
      expect(env.read("a.txt").toString()).toBe("original");
    });
  },
);

describe("replaced flag after a completed rename", () => {
  it("still reports a target edited after its rename as a leftover (hash-decided undo)", async () => {
    env.put("t.txt", "original");
    const error = await failure(
      applyAdoptActions({
        root: env.root,
        actions: [env.take("t.txt", "taken"), env.install("n.txt", "n")],
        io: {
          beforeStep: ({ index }) => {
            if (index === 1) {
              writeFileSync(env.abs("t.txt"), "user edit");
              throw new Error("injected");
            }
          },
        },
      }),
    );
    expect(error.rolledBack).toBe(false);
    expect(error.leftovers).toContain("t.txt");
    expect(env.read("t.txt").toString()).toBe("user edit");
  });
});

describe("the recovery note survives a plan failure in the same run", () => {
  const clash = (): ReturnType<Env["install"]> => {
    env.put("exists.txt", "already here");
    return env.install("exists.txt", "x");
  };

  it("names the removal of a journal-less txn/ when the plan is then refused", async () => {
    env.put(".groundwork/headless/txn/backup/0", "orphan");
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [clash()] }),
    );
    expect(error.message).toContain("exists.txt");
    expect(error.message).toContain("no journal");
    expect(error.message).toContain("txn");
    expect(existsSync(env.headless("txn"))).toBe(false);
  });

  it("names a recovery that restored nothing (target already original) when the plan is then refused", async () => {
    env.put("a.txt", "original");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [clash()] }),
    );
    expect(error.message).toContain("exists.txt");
    expect(error.message).toMatch(/rolled back/i);
    expect(env.read("a.txt").toString()).toBe("original");
  });

  it("names a recovery that removed an install-only journal's file when the plan is then refused", async () => {
    env.put("n.txt", "n");
    env.writeJournal([installStep("n.txt", "n")]);
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [clash()] }),
    );
    expect(error.message).toContain("exists.txt");
    expect(error.message).toContain("n.txt");
    expect(existsSync(env.abs("n.txt"))).toBe(false);
  });

  it("adds no recovery note when there was nothing to recover", async () => {
    const error = await failure(
      applyAdoptActions({ root: env.root, actions: [clash()] }),
    );
    expect(error.message).not.toMatch(/no journal|rolled back|leftover/i);
  });
});

describe("a dry run beside a pending txn/", () => {
  const unfinished = (warnings: readonly string[]): boolean =>
    warnings.some((w) => /unfinished/i.test(w) && /half-applied/i.test(w));

  it("warns, without recovering or writing, when a journal is present", async () => {
    env.put("a.txt", "taken");
    env.writeJournal([replaceStep("a.txt", "original", "taken")], {
      "0": "original",
    });
    const actions = [env.install("n.txt", "n")];
    const before = snapshotTree(env.root);
    const result = await applyAdoptActions({
      root: env.root,
      actions,
      dryRun: true,
    });
    expect(result.changes.map((change) => change.path)).toEqual(["n.txt"]);
    expect(unfinished(result.warnings)).toBe(true);
    expect(existsSync(env.headless("txn/journal.json"))).toBe(true);
    expect(env.read("a.txt").toString()).toBe("taken");
    expect(existsSync(env.headless("lock"))).toBe(false);
    expect(snapshotTree(env.root)).toEqual(before);
  });

  it("warns, without recovering or writing, when txn/ holds no journal", async () => {
    env.put(".groundwork/headless/txn/backup/0", "orphan");
    const actions = [env.install("n.txt", "n")];
    const before = snapshotTree(env.root);
    const result = await applyAdoptActions({
      root: env.root,
      actions,
      dryRun: true,
    });
    expect(unfinished(result.warnings)).toBe(true);
    expect(snapshotTree(env.root)).toEqual(before);
  });

  it("returns no warning when there is no txn/", async () => {
    const result = await applyAdoptActions({
      root: env.root,
      actions: [env.install("n.txt", "n")],
      dryRun: true,
    });
    expect(result.warnings).toEqual([]);
  });
});
