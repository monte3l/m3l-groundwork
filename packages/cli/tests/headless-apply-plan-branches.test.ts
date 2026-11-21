// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runApplyDryRun` branch coverage: answers-document shapes, malformed
 * inventories, unusable inventory paths and unreadable targets. A real tmp
 * sandbox; the target tree must stay byte-identical after every call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
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

const isRoot = process.getuid?.() === 0;

describe("runApplyDryRun branches", () => {
  let root: string;
  let project: string;
  let answersPath: string;
  const pendingDoc = (): Json =>
    JSON.parse(readFileSync(join(project, PENDING_REL), "utf8")) as Json;
  const writeAnswers = (doc: unknown): void => {
    writeFileSync(answersPath, JSON.stringify(doc));
  };
  const run = () =>
    runApplyDryRun({ targetDir: project, applyPath: answersPath });
  /** Runs `run`, asserts the tree is unchanged, and resolves to what it settled with. */
  const settle = async (
    lockDown?: () => () => void,
  ): Promise<
    { value: Awaited<ReturnType<typeof run>> } | { error: unknown }
  > => {
    const before = snapshotTree(project);
    const restore = lockDown?.();
    try {
      return { value: await run() };
    } catch (error) {
      return { error };
    } finally {
      restore?.();
      expect(snapshotTree(project)).toEqual(before);
    }
  };
  const usageMessage = async (): Promise<string> => {
    const result = await settle();
    expect("error" in result).toBe(true);
    const { error } = result as { error: unknown };
    expect(error).toBeInstanceOf(CliUsageError);
    return (error as CliUsageError).message;
  };
  /** Rewrites inventory.json with `edit` and answers bound to the new bytes. */
  const tamperInventory = (edit: (inventory: Json) => void): void => {
    const path = join(project, INVENTORY_REL);
    const inventory = JSON.parse(readFileSync(path, "utf8")) as Json;
    edit(inventory);
    const text = JSON.stringify(inventory);
    writeFileSync(path, text);
    const answers = completeAnswers(pendingDoc());
    answers["basis"] = { inventorySha256: sha256Of(text) };
    writeAnswers(answers);
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "hl-apply-branches-"));
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

  describe("answers document", () => {
    it("rejects an adopt document whose basis is null", async () => {
      const answers = completeAnswers(pendingDoc());
      answers["basis"] = null;
      writeAnswers(answers);
      expect(await usageMessage()).toContain("basis");
    });

    it("rejects an adopt document bound by a planSha256 basis", async () => {
      const answers = completeAnswers(pendingDoc());
      answers["basis"] = { planSha256: "a".repeat(64) };
      writeAnswers(answers);
      expect(await usageMessage()).toContain("basis");
    });
  });

  describe("malformed inventory", () => {
    it.each([
      ["a non-integer schemaVersion", 7.5, /integer schemaVersion/],
      ["a string schemaVersion", "7", /integer schemaVersion/],
      ["a schemaVersion newer than this CLI", 9999, /newer CLI/],
    ])("rejects %s", async (_name, version, pattern) => {
      tamperInventory((inventory) => {
        inventory["schemaVersion"] = version;
      });
      const message = await usageMessage();
      expect(message).toMatch(pattern);
      expect(message).toContain("--adopt");
    });

    it("rejects an inventory that is not a JSON object", async () => {
      tamperInventory(() => undefined);
      writeFileSync(join(project, INVENTORY_REL), "[]");
      expect(await usageMessage()).toContain("not a JSON object");
    });

    it.each([
      ["conflicts", (i: Json) => (i["conflicts"] = "nope")],
      ["a conflict entry", (i: Json) => (i["conflicts"] = [{ relPath: 1 }])],
      ["packs", (i: Json) => (i["packs"] = [{ name: "x" }])],
      [
        "a pack file conflict",
        (i: Json) => (i["packs"] = [{ name: "x", fileConflicts: [{}] }]),
      ],
      ["stagedBaseline", (i: Json) => (i["stagedBaseline"] = { dir: 1 })],
      [
        "stagedDivergent files",
        (i: Json) =>
          (i["stagedDivergent"] = { dir: "d", files: [{ path: "p" }] }),
      ],
    ])("rejects malformed %s", async (_name, edit) => {
      tamperInventory((inventory) => {
        edit(inventory);
      });
      expect(await usageMessage()).toContain("malformed");
    });
  });

  describe("inventory path", () => {
    beforeEach(() => {
      writeAnswers(completeAnswers(pendingDoc()));
    });

    it("tells the caller to survey first when .groundwork is not a directory", async () => {
      const dir = join(project, ".groundwork");
      rmSync(dir, { recursive: true });
      writeFileSync(dir, "not a directory");
      expect(await usageMessage()).toContain("--adopt");
    });

    it("rejects an inventory that is a directory", async () => {
      const path = join(project, INVENTORY_REL);
      rmSync(path);
      mkdirSync(path);
      expect(await usageMessage()).toContain("not a regular file");
    });

    it("rejects an inventory that is a symlink", async () => {
      const path = join(project, INVENTORY_REL);
      renameSync(path, join(root, "real-inventory.json"));
      symlinkSync(join(root, "real-inventory.json"), path);
      expect(await usageMessage()).toContain("not a regular file");
    });

    it.skipIf(isRoot)(
      "throws a plain runtime error when the inventory cannot be read",
      async () => {
        const path = join(project, INVENTORY_REL);
        const result = await settle(() => {
          chmodSync(path, 0o000);
          return () => {
            chmodSync(path, 0o644);
          };
        });

        expect("error" in result).toBe(true);
        const { error } = result as { error: unknown };
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain("could not read");
        expect((error as Error).cause).toBeDefined();
      },
    );
  });

  describe("completeness", () => {
    it("is a usage error when a non-decision problem remains", async () => {
      const answers = completeAnswers(pendingDoc());
      answers["upgrade"] = { applySafe: null, removals: null, conflicts: [] };
      writeAnswers(answers);
      const message = await usageMessage();
      expect(message).toContain("not complete enough to apply");
      expect(message).toContain("/upgrade");
    });

    it("is a usage error when /pending is non-empty but every decision is made", async () => {
      const answers = completeAnswers(pendingDoc());
      answers["pending"] = [
        {
          pointer: "/interview/kind",
          reason: "left over",
          choices: null,
          evidence: null,
        },
      ];
      writeAnswers(answers);
      const message = await usageMessage();
      expect(message).toContain("not complete enough to apply");
      expect(message).toContain("/pending");
    });
  });

  describe("targets the planner cannot read", () => {
    beforeEach(() => {
      writeAnswers(completeAnswers(pendingDoc()));
    });

    it("is drift when a target is no longer a regular file", async () => {
      const path = join(project, "tsconfig.json");
      rmSync(path);
      mkdirSync(path);
      const result = await settle();
      expect(result).toHaveProperty("value");
      const { value } = result as { value: Awaited<ReturnType<typeof run>> };
      expect(value).toMatchObject({ status: "drift", exitCode: 4 });
      expect(value.drift.map((d) => d.path)).toContain("tsconfig.json");
    });

    it.skipIf(isRoot)("is drift when a target is unreadable", async () => {
      const path = join(project, "tsconfig.json");
      const result = await settle(() => {
        chmodSync(path, 0o000);
        return () => {
          chmodSync(path, 0o644);
        };
      });

      expect(result).toHaveProperty("value");
      const { value } = result as { value: Awaited<ReturnType<typeof run>> };
      expect(value).toMatchObject({ status: "drift", exitCode: 4 });
      expect(value.drift.map((d) => d.path)).toContain("tsconfig.json");
    });
  });
});
