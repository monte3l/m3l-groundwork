// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runApplyDryRun` (`headless/apply-plan.ts`): the read-only pipeline behind
 * `--adopt --apply <answers.json> --dry-run`. Order: usage (answers file,
 * validate, mode) -> load the inventory (>= 7) -> basis drift -> completeness
 * -> planAdoptActions with a real PlanIo -> applyAdoptActions({dryRun:true}).
 * Resolves to an outcome for statuses ok/noop (exit 0), pending (exit 3) and
 * drift (exit 4); throws `CliUsageError` for exit 2 and lets an `ApplyError`
 * through for exit 1. It never writes: the tree is byte-identical after every
 * call. The survey fixture comes from a real in-process adopt run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError, main } from "../src/main.js";
import { ApplyError } from "../src/headless/errors.js";
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

describe("runApplyDryRun", () => {
  let root: string;
  let project: string;
  let answersPath: string;
  const writeAnswers = (doc: unknown): void => {
    writeFileSync(answersPath, JSON.stringify(doc));
  };
  const pendingDoc = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(project, PENDING_REL), "utf8")) as Record<
      string,
      unknown
    >;
  const run = () =>
    runApplyDryRun({ targetDir: project, applyPath: answersPath });
  /** Runs the pipeline and asserts the target tree is byte-identical afterwards. */
  const runUnchanged = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = snapshotTree(project);
    try {
      return await fn();
    } finally {
      expect(snapshotTree(project)).toEqual(before);
      expect(existsSync(join(project, ".groundwork", "headless", "lock"))).toBe(
        false,
      );
      expect(existsSync(join(project, ".groundwork", "headless", "txn"))).toBe(
        false,
      );
    }
  };
  const usageError = async (): Promise<CliUsageError> => {
    let thrown: unknown;
    await runUnchanged(async () => {
      try {
        await run();
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(CliUsageError);
    return thrown as CliUsageError;
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "hl-apply-plan-"));
    project = join(root, "project");
    mkdirSync(project);
    writeProject(project);
    main([project, "--adopt", "--json"], "linux", out);
    answersPath = join(root, "answers.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  describe("success", () => {
    it("plans every write as a change with its hashes, status ok, exit 0", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      const outcome = await runUnchanged(run);

      expect(outcome).toMatchObject({
        status: "ok",
        exitCode: 0,
        target: project,
        pending: [],
        drift: [],
      });
      const eslint = outcome.changes.find((c) => c.path === "eslint.config.js");
      expect(eslint).toMatchObject({
        action: "install-staged",
        class: "addition",
        sha256Before: null,
      });
      expect(eslint?.sha256After).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.changes.find((c) => c.path === "tsconfig.json")).toEqual({
        path: "tsconfig.json",
        action: "take-divergent",
        class: "conflict",
        sha256Before: sha256Of(readFileSync(join(project, "tsconfig.json"))),
        sha256After: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      });
      const paths = outcome.changes.map((c) => c.path);
      expect(paths).toEqual([...paths].sort());
    });

    it("is status noop with no changes when nothing is written", async () => {
      writeAnswers(
        completeAnswers(pendingDoc(), { resolution: "keep", addition: "skip" }),
      );
      const outcome = await runUnchanged(run);
      expect(outcome).toMatchObject({
        status: "noop",
        exitCode: 0,
        changes: [],
      });
    });

    it("hands off a delegated conflict and the missed notes, from the planner", async () => {
      const answers = completeAnswers(pendingDoc(), {
        resolution: "delegate",
        addition: "skip",
      });
      (answers["adopt"] as { missedNotes: string }).missedNotes = "mind CI";
      writeAnswers(answers);
      const outcome = await runUnchanged(run);
      expect(outcome.handoff).toContainEqual({
        kind: "delegate",
        path: "tsconfig.json",
      });
      expect(outcome.handoff).toContainEqual({
        kind: "missed-notes",
        notes: "mind CI",
      });
      expect(outcome.status).toBe("noop");
    });
  });

  describe("usage errors (exit 2)", () => {
    it("names a missing answers file", async () => {
      const error = await usageError();
      expect(error.message).toContain(answersPath);
    });

    it("rejects an unreadable answers file (a directory)", async () => {
      mkdirSync(answersPath);
      await usageError();
    });

    it("rejects an oversized answers file", async () => {
      // Assumed cap: at most 64 MiB (a document at every cap is far smaller).
      writeFileSync(answersPath, Buffer.alloc(128 * 1024 * 1024, 0x20));
      await usageError();
    });

    it.each([
      ["not JSON", "{ nope"],
      ["empty", ""],
      ["a JSON array", "[]"],
      ["a JSON string", '"x"'],
      ["null", "null"],
    ])("rejects an answers file that is %s", async (_name, text) => {
      writeFileSync(answersPath, text);
      await usageError();
    });

    it("lists the validator's issues for a schema mismatch", async () => {
      const answers = completeAnswers(pendingDoc());
      answers["schemaVersion"] = 2;
      writeAnswers(answers);
      expect((await usageError()).message).toContain("/schemaVersion");
    });

    it("lists the issue pointer of an unknown path", async () => {
      const answers = completeAnswers(pendingDoc());
      const adopt = answers["adopt"] as { additions: { path: string }[] };
      adopt.additions.push({
        path: "no/such/file.txt",
        action: "add",
      } as never);
      writeAnswers(answers);
      expect((await usageError()).message).toContain("no/such/file.txt");
    });

    it("requires mode adopt", async () => {
      const answers = completeAnswers(pendingDoc());
      answers["mode"] = "fresh";
      writeAnswers(answers);
      expect((await usageError()).message).toMatch(/adopt/);
    });

    it("tells the caller to run --adopt first when there is no inventory", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      rmSync(join(project, INVENTORY_REL));
      expect((await usageError()).message).toMatch(/--adopt/);
    });

    it("tells the caller to run --adopt first for a garbled inventory", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      writeFileSync(join(project, INVENTORY_REL), "{ garbled");
      expect((await usageError()).message).toMatch(/--adopt/);
    });

    it("tells the caller to run --adopt first for an inventory below schema 7", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      const inventory = JSON.parse(
        readFileSync(join(project, INVENTORY_REL), "utf8"),
      ) as Record<string, unknown>;
      inventory["schemaVersion"] = 6;
      const text = JSON.stringify(inventory);
      writeFileSync(join(project, INVENTORY_REL), text);
      const answers = completeAnswers(pendingDoc());
      answers["basis"] = { inventorySha256: sha256Of(text) };
      writeAnswers(answers);
      expect((await usageError()).message).toMatch(/--adopt/);
    });

    it("rejects an answers path the inventory does not list, via the planner", async () => {
      const answers = completeAnswers(pendingDoc());
      const adopt = answers["adopt"] as {
        conflicts: { path: string; resolution: string }[];
      };
      adopt.conflicts.push({ path: "ghost.txt", resolution: "keep" });
      writeAnswers(answers);
      expect((await usageError()).message).toContain("ghost.txt");
    });
  });

  describe("drift (exit 4)", () => {
    it("reports a stale basis when inventory.json changed after the answers were written", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      const path = join(project, INVENTORY_REL);
      const text = readFileSync(path, "utf8");
      // Raw bytes count, not parsed content: a whitespace-only edit drifts.
      writeFileSync(path, `${text}\n`);
      const outcome = await runUnchanged(run);
      expect(outcome).toMatchObject({
        status: "drift",
        exitCode: 4,
        changes: [],
      });
      expect(outcome.drift).toEqual([
        {
          path: INVENTORY_REL,
          expected: (pendingDoc()["basis"] as { inventorySha256: string })
            .inventorySha256,
          actual: sha256Of(`${text}\n`),
        },
      ]);
    });

    it("checks basis drift before completeness: stale and incomplete is drift", async () => {
      writeAnswers(pendingDoc());
      const path = join(project, INVENTORY_REL);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
      const outcome = await runUnchanged(run);
      expect(outcome.status).toBe("drift");
      expect(outcome.exitCode).toBe(4);
    });

    it("reports a project file that changed after the survey", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      const original = sha256Of(readFileSync(join(project, "tsconfig.json")));
      writeFileSync(
        join(project, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      const outcome = await runUnchanged(run);
      expect(outcome).toMatchObject({
        status: "drift",
        exitCode: 4,
        changes: [],
      });
      expect(outcome.drift).toEqual([
        {
          path: "tsconfig.json",
          expected: original,
          actual: sha256Of(readFileSync(join(project, "tsconfig.json"))),
        },
      ]);
    });

    it("reports an absent addition that appeared after the survey", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      writeFileSync(join(project, "eslint.config.js"), "export default [];\n");
      const outcome = await runUnchanged(run);
      expect(outcome.status).toBe("drift");
      expect(outcome.drift.map((d) => d.path)).toContain("eslint.config.js");
    });
  });

  describe("pending (exit 3)", () => {
    it("reports every undecided decision as a PendingEntry and writes nothing", async () => {
      // The survey's own pending document is partial: kind, runtime and the
      // conflict resolution are all still null.
      writeAnswers(pendingDoc());
      const outcome = await runUnchanged(run);
      expect(outcome).toMatchObject({
        status: "pending",
        exitCode: 3,
        changes: [],
        drift: [],
      });
      const pointers = outcome.pending.map((p) => p.pointer);
      expect(pointers).toContain("/interview/kind");
      expect(pointers).toContain("/interview/runtime");
      expect(
        pointers.some((p) => /^\/adopt\/conflicts\/\d+\/resolution$/.test(p)),
      ).toBe(true);
      for (const entry of outcome.pending) {
        expect(entry).toEqual({
          pointer: expect.any(String) as string,
          reason: expect.any(String) as string,
          choices: expect.toSatisfy(
            (v: unknown) => v === null || Array.isArray(v),
          ) as unknown,
          evidence: expect.toSatisfy(
            (v: unknown) => v === null || typeof v === "string",
          ) as unknown,
        });
      }
    });

    it("is pending when a single decision is still null", async () => {
      const answers = completeAnswers(pendingDoc());
      (answers["interview"] as { runtime: unknown }).runtime = null;
      writeAnswers(answers);
      const outcome = await runUnchanged(run);
      expect(outcome.status).toBe("pending");
      expect(outcome.pending.map((p) => p.pointer)).toEqual([
        "/interview/runtime",
      ]);
    });

    it("does not write a new pending.json (a survey's own is absent here and stays absent)", async () => {
      const partial = pendingDoc();
      rmSync(join(project, PENDING_REL));
      writeAnswers(partial);
      const outcome = await runUnchanged(run);
      expect(outcome.status).toBe("pending");
      expect(existsSync(join(project, PENDING_REL))).toBe(false);
    });
  });

  describe("apply refusal (exit 1)", () => {
    it("lets the executor's ApplyError through when a staged copy was tampered with", async () => {
      writeAnswers(completeAnswers(pendingDoc()));
      const { stagedBaseline } = JSON.parse(
        readFileSync(join(project, INVENTORY_REL), "utf8"),
      ) as { stagedBaseline: { dir: string; files: { staged: string }[] } };
      const staged = stagedBaseline.files[0];
      expect(staged).toBeDefined();
      writeFileSync(
        join(project, stagedBaseline.dir, staged?.staged ?? ""),
        "tampered\n",
      );
      let thrown: unknown;
      await runUnchanged(async () => {
        try {
          await run();
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toBeInstanceOf(ApplyError);
    });
  });
});
