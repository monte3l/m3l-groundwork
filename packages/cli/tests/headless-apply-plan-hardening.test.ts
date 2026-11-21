// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Review-driven hardening of `runApplyDryRun` (`headless/apply-plan.ts`): the
 * pending list is walked from the partial-validated answers (not the capped
 * validator error list), only environmental answers-read errnos are usage
 * errors, the inventory read is bounded and refuses a symlinked
 * `.groundwork`, and a malformed inventory names its first failing field.
 * The `node:fs` wrapper only intercepts `openSync` of the answers file.
 */
import type * as Fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  openFail: undefined as undefined | { path: string; error: () => unknown },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      if (seam.openFail !== undefined && args[0] === seam.openFail.path) {
        throw seam.openFail.error();
      }
      return actual.openSync(...args);
    }) as typeof actual.openSync,
  };
});

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError, main } from "../src/main.js";
import { runApplyDryRun } from "../src/headless/apply-plan.js";
import type { Out } from "../src/output.js";
import {
  INVENTORY_REL,
  PENDING_REL,
  completeAnswers,
  sha256Of,
  snapshotTree,
  writeProject,
} from "./headless-apply-plan-fixture.js";

const out = {
  info: vi.fn(),
  notice: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
} satisfies Out;

type Json = Record<string, unknown>;

describe("runApplyDryRun hardening", () => {
  let root: string;
  let project: string;
  let answersPath: string;
  const writeAnswers = (doc: unknown): void => {
    writeFileSync(answersPath, JSON.stringify(doc));
  };
  const pendingDoc = (): Json =>
    JSON.parse(readFileSync(join(project, PENDING_REL), "utf8")) as Json;
  const run = () =>
    runApplyDryRun({ targetDir: project, applyPath: answersPath });
  const failure = async (): Promise<unknown> => {
    let thrown: unknown;
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
    return thrown;
  };
  const usageError = async (): Promise<CliUsageError> => {
    const thrown = await failure();
    expect(thrown).toBeInstanceOf(CliUsageError);
    return thrown as CliUsageError;
  };
  /** Rewrites the inventory through `mutate`, then binds a complete answers file to the new bytes. */
  const rewriteInventory = (mutate: (inventory: Json) => void): void => {
    const path = join(project, INVENTORY_REL);
    const inventory = JSON.parse(readFileSync(path, "utf8")) as Json;
    mutate(inventory);
    const text = JSON.stringify(inventory);
    writeFileSync(path, text);
    const answers = completeAnswers(pendingDoc());
    answers["basis"] = { inventorySha256: sha256Of(text) };
    writeAnswers(answers);
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "hl-apply-hard-"));
    project = join(root, "project");
    mkdirSync(project);
    writeProject(project);
    main([project, "--adopt", "--json"], "linux", out);
    answersPath = join(root, "answers.json");
  });

  afterEach(() => {
    seam.openFail = undefined;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  describe("pending completeness (exit 3)", () => {
    it("lists every null decision of a document with more than 100, not the validator's capped list", async () => {
      const answers = pendingDoc();
      const adopt = answers["adopt"] as {
        conflicts: Json[];
        additions: Json[];
      };
      for (let i = 0; i < 80; i++) {
        adopt.conflicts.push({
          path: `gen/c${String(i)}.txt`,
          resolution: null,
        });
        adopt.additions.push({ path: `gen/a${String(i)}.txt`, action: null });
      }
      const expected: string[] = [];
      const interview = answers["interview"] as Json;
      for (const key of ["kind", "runtime"]) {
        if (interview[key] === null) expected.push(`/interview/${key}`);
      }
      adopt.conflicts.forEach((c, i) => {
        if (c["resolution"] === null)
          expected.push(`/adopt/conflicts/${String(i)}/resolution`);
      });
      adopt.additions.forEach((a, i) => {
        if (a["action"] === null)
          expected.push(`/adopt/additions/${String(i)}/action`);
      });
      expect(expected.length).toBeGreaterThan(100);
      writeAnswers(answers);

      const before = snapshotTree(project);
      const outcome = await run();
      expect(snapshotTree(project)).toEqual(before);

      expect(outcome).toMatchObject({ status: "pending", exitCode: 3 });
      const pointers = outcome.pending.map((p) => p.pointer);
      expect(pointers).toContain("/interview/kind");
      expect(pointers).toContain("/interview/runtime");
      expect(pointers.length).toBe(expected.length);
      expect([...pointers].sort()).toEqual([...expected].sort());
    });

    it("reuses the answers file's own pending entry at the same pointer", async () => {
      const answers = pendingDoc();
      const own = {
        pointer: "/interview/kind",
        reason: "the survey's own reason",
        choices: ["library"],
        evidence: "own evidence",
      };
      answers["pending"] = [own];
      writeAnswers(answers);
      const outcome = await run();
      expect(outcome.status).toBe("pending");
      expect(
        outcome.pending.find((p) => p.pointer === "/interview/kind"),
      ).toEqual(own);
    });
  });

  describe("answers file read errors", () => {
    const withErrno = (code: string) => () =>
      Object.assign(new Error(`${code}: simulated`), { code });

    it.each(["ENOENT", "EACCES", "EISDIR", "ENOTDIR", "ELOOP"])(
      "treats %s as a usage error naming the path",
      async (code) => {
        seam.openFail = { path: answersPath, error: withErrno(code) };
        const error = await usageError();
        expect(error.message).toContain(answersPath);
      },
    );

    it("treats a directory (not a regular file) as a usage error naming the path", async () => {
      mkdirSync(answersPath);
      const error = await usageError();
      expect(error.message).toContain(answersPath);
    });

    it.each(["EIO", "EMFILE", "ENOMEM"])(
      "treats %s as a runtime error with the cause chained, not a usage error",
      async (code) => {
        const cause = withErrno(code)();
        seam.openFail = { path: answersPath, error: () => cause };
        const thrown = await failure();
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(CliUsageError);
        expect((thrown as Error).cause).toBe(cause);
      },
    );

    it("treats a throw without an errno as a runtime error with the cause chained", async () => {
      const cause = new Error("no errno here");
      seam.openFail = { path: answersPath, error: () => cause };
      const thrown = await failure();
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      expect((thrown as Error).cause).toBe(cause);
    });

    it("treats a thrown non-Error value as a runtime error with the cause chained", async () => {
      seam.openFail = { path: answersPath, error: () => "boom" };
      const thrown = await failure();
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      expect((thrown as Error).cause).toBe("boom");
    });
  });

  describe("inventory read bounds", () => {
    it("refuses an inventory over 8 MiB with a usage error saying to run --adopt first", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      writeFileSync(
        join(project, INVENTORY_REL),
        Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
      );
      const error = await usageError();
      expect(error.message).toMatch(/--adopt/);
      expect(error.message).toContain("8 MiB");
    });

    it("refuses a symlinked .groundwork directory for the inventory read", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      const real = join(root, "real-groundwork");
      renameSync(join(project, ".groundwork"), real);
      symlinkSync(real, join(project, ".groundwork"));
      const error = await usageError();
      expect(error.message).toMatch(/--adopt/);
    });
  });

  describe("malformed inventory names the failing field", () => {
    it("names stagedDivergent.files", async () => {
      rewriteInventory((inv) => {
        (inv["stagedDivergent"] as Json)["files"] = "nope";
      });
      const error = await usageError();
      expect(error.message).toContain("stagedDivergent.files");
      expect(error.message).toMatch(/--adopt/);
    });

    it("names stagedBaseline.dir", async () => {
      rewriteInventory((inv) => {
        (inv["stagedBaseline"] as Json)["dir"] = 7;
      });
      expect((await usageError()).message).toContain("stagedBaseline.dir");
    });

    it("names conflicts[2].targetSha256 for the third conflict only", async () => {
      rewriteInventory((inv) => {
        const conflicts = inv["conflicts"] as Json[];
        const first = conflicts[0] as Json;
        // Exactly three entries, so the bad one is index 2 whatever the baseline size.
        conflicts.splice(
          0,
          conflicts.length,
          first,
          { ...first, relPath: "x1.txt" },
          { ...first, relPath: "x2.txt", targetSha256: 12 },
        );
      });
      expect((await usageError()).message).toContain(
        "conflicts[2].targetSha256",
      );
    });

    it.each([
      ["missing", undefined],
      ["numeric", 5],
    ])("rejects a %s targetSha256 naming conflicts[0]", async (_n, value) => {
      rewriteInventory((inv) => {
        const conflict = (inv["conflicts"] as Json[])[0] as Json;
        if (value === undefined) delete conflict["targetSha256"];
        else conflict["targetSha256"] = value;
      });
      expect((await usageError()).message).toContain(
        "conflicts[0].targetSha256",
      );
    });

    it.each([
      ["stagedBaseline", "stagedBaseline is not an object"],
      ["stagedDivergent", "stagedDivergent is not an object"],
    ])("rejects a non-object %s", async (key, message) => {
      rewriteInventory((inv) => {
        inv[key] = 7;
      });
      expect((await usageError()).message).toContain(message);
    });

    it.each(["stagedBaseline", "stagedDivergent"])(
      "rejects a non-object %s.files[0]",
      async (key) => {
        rewriteInventory((inv) => {
          (inv[key] as Json)["files"] = ["nope"];
        });
        expect((await usageError()).message).toContain(
          `${key}.files[0] is not an object`,
        );
      },
    );

    it("rejects a non-object conflicts[0]", async () => {
      rewriteInventory((inv) => {
        (inv["conflicts"] as unknown[])[0] = "nope";
      });
      expect((await usageError()).message).toContain(
        "conflicts[0] is not an object",
      );
    });

    it("rejects a non-object packs[0]", async () => {
      rewriteInventory((inv) => {
        inv["packs"] = ["nope"];
      });
      expect((await usageError()).message).toContain(
        "packs[0] is not an object",
      );
    });

    it("still accepts a null targetSha256 in the shape check", async () => {
      rewriteInventory((inv) => {
        const conflict = (inv["conflicts"] as Json[])[0] as Json;
        conflict["targetSha256"] = null;
      });
      // Past the shape check the planner may drift or plan, but never a usage error about the shape.
      const thrown = await failure();
      if (thrown instanceof CliUsageError) {
        expect(thrown.message).not.toContain("targetSha256");
      }
    });
  });

  describe("edge cases", () => {
    it("ends exit 2 naming /adopt when an adopt document has adopt: null", async () => {
      const answers = pendingDoc();
      answers["adopt"] = null;
      writeAnswers(answers);
      const error = await usageError();
      expect(error.message).toContain("/adopt");
    });

    // KNOWN LIMIT, deliberate and documented (headless-mode.md): the validator's
    // error list stops at a fixed cap, so with more than 100 open decisions plus
    // a non-decision problem the problem can be cut off the list; the pending
    // list is then reported (exit 3) instead of the usage error (exit 2).
    it("pins the documented limit: over 100 open decisions plus a non-decision problem still exits 3", async () => {
      const answers = pendingDoc();
      const adopt = answers["adopt"] as { additions: Json[] };
      for (let i = 0; i < 120; i++) {
        adopt.additions.push({ path: `gen/a${String(i)}.txt`, action: null });
      }
      // A non-decision problem reported after the decisions (checkComplete runs last).
      answers["upgrade"] = { applySafe: null, removals: null, conflicts: [] };
      writeAnswers(answers);
      const outcome = await run();
      expect(outcome).toMatchObject({ status: "pending", exitCode: 3 });
    });

    it("treats a target read failing without an errno as an unreadable target (drift), not a crash", async () => {
      const inv = JSON.parse(
        readFileSync(join(project, INVENTORY_REL), "utf8"),
      ) as { conflicts: { relPath: string }[] };
      const relPath = (inv.conflicts[0] as { relPath: string }).relPath;
      writeAnswers(completeAnswers(pendingDoc()));
      seam.openFail = {
        path: join(project, relPath),
        error: () => new Error("no errno here"),
      };
      const outcome = await run();
      expect(outcome.status).toBe("drift");
      expect(outcome.drift.map((d) => d.path)).toEqual([relPath]);
    });
  });
});
