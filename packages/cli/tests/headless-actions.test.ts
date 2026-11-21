// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The pure `--adopt --apply` planner (src/headless/actions.ts): turns a
 * parsed inventory v7, a validated complete adopt answers document and a
 * hash-only I/O seam into a list of actions and handoff entries, or into
 * usage errors (exit 2) or drift (exit 4). It never writes and never reads a
 * file itself.
 */
import { describe, expect, expectTypeOf, it, test } from "vitest";
import * as fc from "fast-check";
import {
  planAdoptActions,
  type AdoptPlanResult,
  type PlanIo,
  type TargetState,
} from "../src/headless/actions.js";
import { validateAnswers, type AnswersV1 } from "../src/headless/contract.js";
import type { FileConflict } from "../src/conflicts.js";
import type { Inventory } from "../src/inventory.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const STAGED_SHA = "9".repeat(64);
const INV_SHA = "a".repeat(64);

type StagedFile = { path: string; staged: string; sha256: string };

interface InventoryOptions {
  conflicts?: FileConflict[];
  baseline?: string[];
  divergent?: string[];
  packs?: { name: string; fileConflicts: FileConflict[] }[];
}

/** An inventory from before schema 7: no staged divergent copies at all. */
function legacyInventoryWith(options: InventoryOptions = {}): Inventory {
  const { stagedDivergent: _dropped, ...rest } = inventoryWith(
    options,
  ) as unknown as Record<string, unknown>;
  return { ...rest, schemaVersion: 6 } as unknown as Inventory;
}

/** Only the fields the planner may read; the rest of an inventory is irrelevant. */
function inventoryWith(options: InventoryOptions = {}): Inventory {
  const staged = (dir: string, paths: string[]) => ({
    dir,
    suffix: ".staged",
    files: paths.map((path): StagedFile => ({
      path,
      staged: `${path}.staged`,
      sha256: STAGED_SHA,
    })),
  });
  return {
    schemaVersion: 7,
    conflicts: options.conflicts ?? [],
    packs: (options.packs ?? []).map((p) => ({ ...p, modes: [] })),
    stagedBaseline: staged(".groundwork/baseline", options.baseline ?? []),
    stagedDivergent: staged(
      ".groundwork/baseline-divergent",
      options.divergent ?? [],
    ),
    stagedPacks: [],
  } as unknown as Inventory;
}

const absent = (relPath: string): FileConflict => ({
  relPath,
  status: "absent",
  keyDiffs: undefined,
  targetSha256: null,
});
const divergent = (
  relPath: string,
  targetSha256: string | null = H1,
  keyDiffs?: string[],
): FileConflict => ({ relPath, status: "divergent", keyDiffs, targetSha256 });

type Addition = { path: string; action: "add" | "skip" };
type Resolution = "keep" | "take" | "merge-keys" | "delegate";
type ConflictAnswer = {
  path: string;
  resolution: Resolution;
  takeKeys?: string[];
};

function answersWith(
  additions: Addition[] = [],
  conflicts: ConflictAnswer[] = [],
  extra: { missedNotes?: string; install?: string[] } = {},
): AnswersV1 {
  const doc = {
    schema: "groundwork.answers",
    schemaVersion: 1,
    mode: "adopt",
    basis: { inventorySha256: INV_SHA },
    fresh: null,
    interview: {
      kind: "library",
      runtime: "node",
      testsMandatory: true,
      ciDepth: "standard",
      keepAgents: null,
    },
    adopt: { additions, conflicts, missedNotes: extra.missedNotes ?? "" },
    upgrade: null,
    packs: { install: extra.install ?? [], decline: [] },
    plugins: { enabled: [], declined: [] },
    guidance: { enabled: false, domains: [] },
    pending: [],
  };
  const result = validateAnswers(doc, "complete");
  if (!result.ok) {
    throw new Error(`fixture rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/**
 * An io seam over a fixed map of hashes (a file) and optional explicit states;
 * a path in neither is absent.
 */
function ioOf(
  files: Record<string, string> = {},
  states: Record<string, TargetState> = {},
): PlanIo {
  return {
    sha256OfTarget: (path): TargetState => {
      const state = states[path];
      if (state !== undefined) return state;
      const sha256 = files[path];
      return sha256 === undefined
        ? { kind: "absent" }
        : { kind: "file", sha256 };
    },
  };
}

const unreadable: TargetState = { kind: "unreadable", code: "EISDIR" };

function okActions(result: AdoptPlanResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.kind}`);
  return result.actions;
}

describe("planAdoptActions: nothing to do", () => {
  it("returns ok with zero actions and no handoff for an empty inventory and empty answers", () => {
    const result = planAdoptActions(inventoryWith(), answersWith(), ioOf());
    expect(result).toMatchObject({ ok: true, actions: [] });
    expect(result.ok && result.handoff).toEqual([]);
  });

  it("does not touch the io seam when there is nothing to check", () => {
    const calls: string[] = [];
    planAdoptActions(inventoryWith(), answersWith(), {
      sha256OfTarget: (p) => {
        calls.push(p);
        return { kind: "absent" };
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("planAdoptActions: additions", () => {
  const inventory = inventoryWith({
    conflicts: [absent("eslint.config.js")],
    baseline: ["eslint.config.js"],
  });

  it("plans install-staged from the staged baseline bytes when the target is still absent", () => {
    const actions = okActions(
      planAdoptActions(
        inventory,
        answersWith([{ path: "eslint.config.js", action: "add" }]),
        ioOf(),
      ),
    );
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "install-staged",
        path: "eslint.config.js",
        stagedPath: ".groundwork/baseline/eslint.config.js.staged",
        sha256: STAGED_SHA,
      }),
    ]);
  });

  it("records a skipped addition as a skip action and writes nothing", () => {
    const actions = okActions(
      planAdoptActions(
        inventory,
        answersWith([{ path: "eslint.config.js", action: "skip" }]),
        ioOf({ "eslint.config.js": H1 }),
      ),
    );
    expect(actions).toEqual([
      expect.objectContaining({ kind: "skip", path: "eslint.config.js" }),
    ]);
  });

  it("is drift (expected null) when an added path now exists", () => {
    const result = planAdoptActions(
      inventory,
      answersWith([{ path: "eslint.config.js", action: "add" }]),
      ioOf({ "eslint.config.js": H2 }),
    );
    expect(result).toEqual({
      ok: false,
      kind: "drift",
      drift: [{ path: "eslint.config.js", expected: null, actual: H2 }],
    });
  });

  it("is a usage error when an add has no staged bytes", () => {
    const result = planAdoptActions(
      inventoryWith({ conflicts: [absent("a.txt")], baseline: [] }),
      answersWith([{ path: "a.txt", action: "add" }]),
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      !result.ok && result.kind === "usage" && result.errors[0],
    ).toMatchObject({
      pointer: "/adopt/additions/0",
    });
  });
});

describe("planAdoptActions: conflicts", () => {
  const inventory = inventoryWith({
    conflicts: [divergent("tsconfig.json")],
    divergent: ["tsconfig.json"],
  });

  it("plans take-divergent from the staged divergent bytes when the target hash is unchanged", () => {
    const actions = okActions(
      planAdoptActions(
        inventory,
        answersWith([], [{ path: "tsconfig.json", resolution: "take" }]),
        ioOf({ "tsconfig.json": H1 }),
      ),
    );
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "take-divergent",
        path: "tsconfig.json",
        stagedPath: ".groundwork/baseline-divergent/tsconfig.json.staged",
        sha256: STAGED_SHA,
      }),
    ]);
  });

  it("is drift with expected and actual when the target changed since the survey", () => {
    const result = planAdoptActions(
      inventory,
      answersWith([], [{ path: "tsconfig.json", resolution: "take" }]),
      ioOf({ "tsconfig.json": H2 }),
    );
    expect(result).toEqual({
      ok: false,
      kind: "drift",
      drift: [{ path: "tsconfig.json", expected: H1, actual: H2 }],
    });
  });

  it("is drift with actual null when a taken target has since disappeared", () => {
    const result = planAdoptActions(
      inventory,
      answersWith([], [{ path: "tsconfig.json", resolution: "take" }]),
      ioOf(),
    );
    expect(result).toEqual({
      ok: false,
      kind: "drift",
      drift: [{ path: "tsconfig.json", expected: H1, actual: null }],
    });
  });

  it("is a usage error when a take has no staged divergent entry", () => {
    const result = planAdoptActions(
      inventoryWith({ conflicts: [divergent("tsconfig.json")], divergent: [] }),
      answersWith([], [{ path: "tsconfig.json", resolution: "take" }]),
      ioOf({ "tsconfig.json": H1 }),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
  });

  it("never reads bytes staged in the absent-only baseline for a take", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("tsconfig.json")],
        baseline: ["tsconfig.json"],
        divergent: [],
      }),
      answersWith([], [{ path: "tsconfig.json", resolution: "take" }]),
      ioOf({ "tsconfig.json": H1 }),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
  });

  it("keep records a keep action and never checks the target", () => {
    const calls: string[] = [];
    const actions = okActions(
      planAdoptActions(
        inventory,
        answersWith([], [{ path: "tsconfig.json", resolution: "keep" }]),
        {
          sha256OfTarget: (p) => {
            calls.push(p);
            return { kind: "file", sha256: H3 };
          },
        },
      ),
    );
    expect(actions).toEqual([
      expect.objectContaining({ kind: "keep", path: "tsconfig.json" }),
    ]);
    expect(calls).toEqual([]);
  });
});

describe("planAdoptActions: unreadable divergent target (targetSha256 null)", () => {
  const inventory = inventoryWith({
    conflicts: [divergent("tsconfig.json", null)],
    divergent: ["tsconfig.json"],
  });

  it.each([
    ["absent", {}],
    ["now readable", { "tsconfig.json": H1 }],
  ])("take is drift with expected null (target %s)", (_label, files) => {
    const result = planAdoptActions(
      inventory,
      answersWith([], [{ path: "tsconfig.json", resolution: "take" }]),
      ioOf(files),
    );
    expect(result).toMatchObject({ ok: false, kind: "drift" });
    expect(!result.ok && result.kind === "drift" && result.drift).toEqual([
      {
        path: "tsconfig.json",
        expected: null,
        actual: (files as Record<string, string>)["tsconfig.json"] ?? null,
      },
    ]);
  });

  it.each(["keep", "delegate"] as const)(
    "%s still plans fine",
    (resolution) => {
      const result = planAdoptActions(
        inventory,
        answersWith([], [{ path: "tsconfig.json", resolution }]),
        ioOf(),
      );
      expect(result.ok).toBe(true);
    },
  );
});

describe("planAdoptActions: merge-keys", () => {
  const inventory = inventoryWith({
    conflicts: [divergent("package.json", H1, ["scripts", "name"])],
    divergent: ["package.json"],
  });

  it("plans merge-keys carrying the keys to take, bound to the staged bytes and recorded hash", () => {
    const actions = okActions(
      planAdoptActions(
        inventory,
        answersWith(
          [],
          [
            {
              path: "package.json",
              resolution: "merge-keys",
              takeKeys: ["scripts"],
            },
          ],
        ),
        ioOf({ "package.json": H1 }),
      ),
    );
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "merge-keys",
        path: "package.json",
        takeKeys: ["scripts"],
        stagedPath: ".groundwork/baseline-divergent/package.json.staged",
        sha256: STAGED_SHA,
      }),
    ]);
  });

  it("is a usage error at takeKeys when a key is not one the survey found different", () => {
    const result = planAdoptActions(
      inventory,
      answersWith(
        [],
        [
          {
            path: "package.json",
            resolution: "merge-keys",
            takeKeys: ["scripts", "bogus"],
          },
        ],
      ),
      ioOf({ "package.json": H1 }),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      !result.ok && result.kind === "usage" && result.errors,
    ).toContainEqual(
      expect.objectContaining({ pointer: "/adopt/conflicts/0/takeKeys" }),
    );
  });

  it("is a usage error at resolution when the conflict was a whole-file difference", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("package.json", H1)],
        divergent: ["package.json"],
      }),
      answersWith(
        [],
        [
          {
            path: "package.json",
            resolution: "merge-keys",
            takeKeys: ["scripts"],
          },
        ],
      ),
      ioOf({ "package.json": H1 }),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      !result.ok && result.kind === "usage" && result.errors,
    ).toContainEqual(
      expect.objectContaining({ pointer: "/adopt/conflicts/0/resolution" }),
    );
  });

  it("is drift when the target changed since the survey", () => {
    const result = planAdoptActions(
      inventory,
      answersWith(
        [],
        [
          {
            path: "package.json",
            resolution: "merge-keys",
            takeKeys: ["name"],
          },
        ],
      ),
      ioOf({ "package.json": H2 }),
    );
    expect(result).toEqual({
      ok: false,
      kind: "drift",
      drift: [{ path: "package.json", expected: H1, actual: H2 }],
    });
  });
});

describe("planAdoptActions: handoff", () => {
  it("turns a delegate conflict into a delegate action plus a handoff entry naming the path, with no write", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("CLAUDE.md")],
        divergent: ["CLAUDE.md"],
      }),
      answersWith([], [{ path: "CLAUDE.md", resolution: "delegate" }]),
      ioOf(),
    );
    expect(result.ok && result.actions).toEqual([
      expect.objectContaining({ kind: "delegate", path: "CLAUDE.md" }),
    ]);
    expect(result.ok && result.handoff).toEqual([
      expect.objectContaining({ path: "CLAUDE.md" }),
    ]);
  });

  it("carries non-empty missedNotes into a handoff entry with the notes verbatim", () => {
    const notes = "The team keeps CI in a separate repo.";
    const result = planAdoptActions(
      inventoryWith(),
      answersWith([], [], { missedNotes: notes }),
      ioOf(),
    );
    expect(result.ok && result.handoff).toEqual([
      expect.objectContaining({ notes }),
    ]);
  });

  it("adds no missedNotes handoff entry when the notes are empty", () => {
    const result = planAdoptActions(inventoryWith(), answersWith(), ioOf());
    expect(result.ok && result.handoff).toEqual([]);
  });
});

describe("planAdoptActions: usage errors", () => {
  it("rejects an addition for a path the inventory does not list", () => {
    const result = planAdoptActions(
      inventoryWith(),
      answersWith([{ path: "nope.txt", action: "skip" }]),
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      !result.ok && result.kind === "usage" && result.errors,
    ).toContainEqual(
      expect.objectContaining({ pointer: "/adopt/additions/0" }),
    );
  });

  it("rejects a conflict answer for a path the inventory does not list as divergent", () => {
    const result = planAdoptActions(
      inventoryWith({ conflicts: [absent("a.txt")], baseline: ["a.txt"] }),
      answersWith([], [{ path: "a.txt", resolution: "keep" }]),
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      !result.ok && result.kind === "usage" && result.errors,
    ).toContainEqual(
      expect.objectContaining({ pointer: "/adopt/conflicts/0" }),
    );
  });

  it.each([
    ["an absent file", { conflicts: [absent("a.txt")], baseline: ["a.txt"] }],
    [
      "a divergent file",
      { conflicts: [divergent("a.txt")], divergent: ["a.txt"] },
    ],
  ])("rejects %s the answers never decide as an undecided path", (_l, opts) => {
    const result = planAdoptActions(inventoryWith(opts), answersWith(), ioOf());
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      !result.ok && result.kind === "usage" && result.errors,
    ).toContainEqual(
      expect.objectContaining({
        reason: expect.stringMatching(/undecided path/) as string,
      }),
    );
  });

  it("collects every usage error, not just the first", () => {
    const result = planAdoptActions(
      inventoryWith(),
      answersWith([
        { path: "x.txt", action: "skip" },
        { path: "y.txt", action: "skip" },
      ]),
      ioOf(),
    );
    expect(!result.ok && result.kind === "usage" && result.errors.length).toBe(
      2,
    );
  });

  it("reports usage errors before drift when both are present", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("tsconfig.json"), absent("ok.txt")],
        divergent: ["tsconfig.json"],
        baseline: ["ok.txt"],
      }),
      answersWith(
        [
          { path: "ok.txt", action: "add" },
          { path: "ghost.txt", action: "skip" },
        ],
        [{ path: "tsconfig.json", resolution: "take" }],
      ),
      ioOf({ "tsconfig.json": H2, "ok.txt": H3 }),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
  });

  it("every usage error has a pointer and a reason string", () => {
    const result = planAdoptActions(
      inventoryWith(),
      answersWith([{ path: "x.txt", action: "skip" }]),
      ioOf(),
    );
    expect(!result.ok && result.kind === "usage" && result.errors).toEqual([
      {
        pointer: expect.any(String) as string,
        reason: expect.any(String) as string,
      },
    ]);
  });
});

describe("planAdoptActions: a path in more than one collection", () => {
  const both = (additionPath: string, conflictPath: string): AdoptPlanResult =>
    planAdoptActions(
      inventoryWith({
        conflicts: [absent(additionPath), divergent(conflictPath)],
        baseline: [additionPath],
        divergent: [conflictPath],
      }),
      answersWith(
        [{ path: additionPath, action: "add" }],
        [{ path: conflictPath, resolution: "keep" }],
      ),
      ioOf(),
    );

  it.each([
    ["the same spelling", "a/b.txt", "a/b.txt"],
    ["a case variant", "README.md", "readme.md"],
    ["a Unicode-folded variant (Kelvin sign)", "k.txt", "K.txt"],
    ["an NFC/NFD variant", "é.txt", "é.txt"],
  ])("is a usage error naming both pointers (%s)", (_l, a, c) => {
    const result = both(a, c);
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    const errors = !result.ok && result.kind === "usage" ? result.errors : [];
    expect(
      errors.some(
        (e) =>
          `${e.pointer} ${e.reason}`.includes("/adopt/additions/0") &&
          `${e.pointer} ${e.reason}`.includes("/adopt/conflicts/0"),
      ),
    ).toBe(true);
  });

  it("is a usage error when an addition collides with a file of an installed pack", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [absent("pack.txt")],
        baseline: ["pack.txt"],
        packs: [{ name: "quality", fileConflicts: [absent("PACK.txt")] }],
      }),
      answersWith([{ path: "pack.txt", action: "add" }], [], {
        install: ["quality"],
      }),
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    const errors = !result.ok && result.kind === "usage" ? result.errors : [];
    expect(
      errors.some((e) =>
        `${e.pointer} ${e.reason}`.includes("/adopt/additions/0"),
      ),
    ).toBe(true);
  });
});

describe("planAdoptActions: .git segments at any depth", () => {
  it.each([
    "sub/.git/hooks/pre-commit",
    "a/b/.GIT/config",
    "a/.Git",
    "sub/git~1/x",
    "sub/GIT~1/x",
    "deep/er/.git/x",
  ])("is a usage error for the addition %s", (path) => {
    const result = planAdoptActions(
      inventoryWith({ conflicts: [absent(path)], baseline: [path] }),
      answersWith([{ path, action: "add" }]),
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      !result.ok && result.kind === "usage" && result.errors,
    ).toContainEqual(
      expect.objectContaining({ pointer: "/adopt/additions/0" }),
    );
  });

  it("is a usage error for a nested .git path in a conflict answer", () => {
    const path = "sub/.git/hooks/pre-commit";
    const result = planAdoptActions(
      inventoryWith({ conflicts: [divergent(path)], divergent: [path] }),
      answersWith([], [{ path, resolution: "keep" }]),
      ioOf(),
    );
    expect(
      !result.ok && result.kind === "usage" && result.errors,
    ).toContainEqual(
      expect.objectContaining({ pointer: "/adopt/conflicts/0" }),
    );
  });

  it("does not flag a segment that merely contains .git", () => {
    const path = "sub/.github/workflows/ci.yml";
    const result = planAdoptActions(
      inventoryWith({ conflicts: [absent(path)], baseline: [path] }),
      answersWith([{ path, action: "add" }]),
      ioOf(),
    );
    expect(result.ok).toBe(true);
  });
});

describe("planAdoptActions: drift collection", () => {
  it("collects drift for every item, not just the first", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [
          absent("a.txt"),
          divergent("b.json", H1),
          divergent("c.json", null),
        ],
        baseline: ["a.txt"],
        divergent: ["b.json", "c.json"],
      }),
      answersWith(
        [{ path: "a.txt", action: "add" }],
        [
          { path: "b.json", resolution: "take" },
          { path: "c.json", resolution: "take" },
        ],
      ),
      ioOf({ "a.txt": H2, "b.json": H3, "c.json": H1 }),
    );
    expect(!result.ok && result.kind === "drift" && result.drift).toEqual([
      { path: "a.txt", expected: null, actual: H2 },
      { path: "b.json", expected: H1, actual: H3 },
      { path: "c.json", expected: null, actual: H1 },
    ]);
  });
});

describe("planAdoptActions: determinism", () => {
  const inventory = inventoryWith({
    conflicts: [
      absent("b.txt"),
      absent("a.txt"),
      absent("C.txt"),
      divergent("z.json"),
    ],
    baseline: ["b.txt", "a.txt", "C.txt"],
    divergent: ["z.json"],
  });
  const answers = answersWith(
    [
      { path: "b.txt", action: "add" },
      { path: "a.txt", action: "skip" },
      { path: "C.txt", action: "add" },
    ],
    [{ path: "z.json", resolution: "keep" }],
  );

  it("sorts actions by path in code-point order", () => {
    const paths = okActions(planAdoptActions(inventory, answers, ioOf())).map(
      (a) => a.path,
    );
    expect(paths).toEqual(["C.txt", "a.txt", "b.txt", "z.json"]);
  });

  it("returns equal results for equal inputs and does not mutate them", () => {
    const before = JSON.stringify([inventory, answers]);
    const first = planAdoptActions(inventory, answers, ioOf());
    const second = planAdoptActions(inventory, answers, ioOf());
    expect(second).toEqual(first);
    expect(JSON.stringify([inventory, answers])).toBe(before);
  });
});

describe("planAdoptActions: planner decisions", () => {
  const usageErrors = (result: AdoptPlanResult) =>
    !result.ok && result.kind === "usage" ? result.errors : [];

  it("rejects answers whose mode is not adopt as a usage error at /mode", () => {
    const notAdopt: AnswersV1 = { ...answersWith(), mode: "fresh" };
    const result = planAdoptActions(inventoryWith(), notAdopt, ioOf());
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(usageErrors(result)).toEqual([
      { pointer: "/mode", reason: "must be an adopt answers document" },
    ]);
  });

  it("rejects mode adopt with a null adopt section as a single usage error at /adopt", () => {
    const nullAdopt = { ...answersWith(), adopt: null } as unknown as AnswersV1;
    const result = planAdoptActions(inventoryWith(), nullAdopt, ioOf());
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(usageErrors(result)).toEqual([
      { pointer: "/adopt", reason: "must be an adopt answers document" },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
  ])("rejects merge-keys with %s takeKeys at .../takeKeys", (_l, takeKeys) => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("package.json", H1, ["scripts"])],
        divergent: ["package.json"],
      }),
      answersWith(
        [],
        [
          takeKeys === undefined
            ? { path: "package.json", resolution: "merge-keys" }
            : { path: "package.json", resolution: "merge-keys", takeKeys },
        ],
      ),
      ioOf({ "package.json": H1 }),
    );
    expect(usageErrors(result)).toEqual([
      {
        pointer: "/adopt/conflicts/0/takeKeys",
        reason: expect.stringMatching(/must name at least one key/) as string,
      },
    ]);
  });

  it.each([
    ["absent", absent("a.txt")],
    ["divergent", divergent("a.txt")],
    ["absent, case-folded match", absent("A.TXT")],
  ])(
    "rejects an answered path colliding with a pack file (%s)",
    (_l, fileConflict) => {
      const result = planAdoptActions(
        inventoryWith({
          packs: [{ name: "p", fileConflicts: [fileConflict] }],
        }),
        answersWith([{ path: "a.txt", action: "skip" }], [], {
          install: ["p"],
        }),
        ioOf(),
      );
      expect(usageErrors(result)).toContainEqual({
        pointer: "/adopt/additions/0",
        reason: expect.stringContaining("/packs/install/0") as string,
      });
    },
  );

  it("reports an undecided absent path at /adopt/additions", () => {
    const result = planAdoptActions(
      inventoryWith({ conflicts: [absent("a.txt")], baseline: ["a.txt"] }),
      answersWith(),
      ioOf(),
    );
    expect(usageErrors(result).map((e) => e.pointer)).toEqual([
      "/adopt/additions",
    ]);
  });

  it("reports an undecided divergent path at /adopt/conflicts", () => {
    const result = planAdoptActions(
      inventoryWith({ conflicts: [divergent("a.txt")], divergent: ["a.txt"] }),
      answersWith(),
      ioOf(),
    );
    expect(usageErrors(result).map((e) => e.pointer)).toEqual([
      "/adopt/conflicts",
    ]);
  });
});

describe("planAdoptActions: target state", () => {
  const addInventory = inventoryWith({
    conflicts: [absent("a.txt")],
    baseline: ["a.txt"],
  });
  const addAnswers = answersWith([{ path: "a.txt", action: "add" }]);
  const takeInventory = inventoryWith({
    conflicts: [divergent("t.json", H1)],
    divergent: ["t.json"],
  });
  const takeAnswers = answersWith([], [{ path: "t.json", resolution: "take" }]);
  const driftOf = (result: AdoptPlanResult) =>
    !result.ok && result.kind === "drift" ? result.drift : [];

  it("add over an absent target is ok", () => {
    const result = planAdoptActions(
      addInventory,
      addAnswers,
      ioOf({}, { "a.txt": { kind: "absent" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("add over a file is drift with expected null and actual the file hash", () => {
    const result = planAdoptActions(
      addInventory,
      addAnswers,
      ioOf({}, { "a.txt": { kind: "file", sha256: H2 } }),
    );
    expect(driftOf(result)).toEqual([
      { path: "a.txt", expected: null, actual: H2 },
    ]);
  });

  it("add over an unreadable target (directory, dangling symlink, EACCES) is drift with actual null", () => {
    const result = planAdoptActions(
      addInventory,
      addAnswers,
      ioOf({}, { "a.txt": unreadable }),
    );
    expect(driftOf(result)).toEqual([
      { path: "a.txt", expected: null, actual: null },
    ]);
  });

  it("take over an unreadable target is drift with actual null", () => {
    const result = planAdoptActions(
      takeInventory,
      takeAnswers,
      ioOf({}, { "t.json": unreadable }),
    );
    expect(driftOf(result)).toEqual([
      { path: "t.json", expected: H1, actual: null },
    ]);
  });

  it("take over a file with the surveyed hash is ok", () => {
    const result = planAdoptActions(
      takeInventory,
      takeAnswers,
      ioOf({}, { "t.json": { kind: "file", sha256: H1 } }),
    );
    expect(result.ok).toBe(true);
  });

  it("merge-keys over an unreadable target is drift with actual null", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("package.json", H1, ["scripts"])],
        divergent: ["package.json"],
      }),
      answersWith(
        [],
        [
          {
            path: "package.json",
            resolution: "merge-keys",
            takeKeys: ["scripts"],
          },
        ],
      ),
      ioOf({}, { "package.json": unreadable }),
    );
    expect(driftOf(result)).toEqual([
      { path: "package.json", expected: H1, actual: null },
    ]);
  });

  it("take with an undetermined expected hash is drift even when the target is a file", () => {
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("t.json", null)],
        divergent: ["t.json"],
      }),
      takeAnswers,
      ioOf({}, { "t.json": { kind: "file", sha256: H1 } }),
    );
    expect(driftOf(result)).toEqual([
      { path: "t.json", expected: null, actual: H1 },
    ]);
  });
});

describe("planAdoptActions: pack and mode usage errors", () => {
  const usageErrors = (result: AdoptPlanResult) =>
    !result.ok && result.kind === "usage" ? result.errors : [];
  const text = (e: { pointer: string; reason: string }) =>
    `${e.pointer} ${e.reason}`;

  it("rejects a pack named in packs.install but absent from inventory.packs, at its install pointer", () => {
    const result = planAdoptActions(
      inventoryWith(),
      answersWith([], [], { install: ["ghost"] }),
      ioOf(),
    );
    expect(usageErrors(result)).toContainEqual({
      pointer: "/packs/install/0",
      reason: expect.stringContaining("not surveyed") as string,
    });
  });

  it("rejects two installed packs shipping the same path, naming both install pointers", () => {
    const result = planAdoptActions(
      inventoryWith({
        packs: [
          { name: "p", fileConflicts: [absent("shared/x.txt")] },
          { name: "q", fileConflicts: [absent("SHARED/x.txt")] },
        ],
      }),
      answersWith([], [], { install: ["p", "q"] }),
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(
      usageErrors(result).some(
        (e) =>
          text(e).includes("/packs/install/0") &&
          text(e).includes("/packs/install/1"),
      ),
    ).toBe(true);
  });

  it("rejects a real fresh answers document (adopt null) at /mode", () => {
    const fresh = {
      ...answersWith(),
      mode: "fresh",
      adopt: null,
    } as unknown as AnswersV1;
    const result = planAdoptActions(inventoryWith(), fresh, ioOf());
    expect(usageErrors(result)).toEqual([
      { pointer: "/mode", reason: expect.any(String) as string },
    ]);
  });

  it("rejects mode upgrade with a stray adopt block at /mode", () => {
    const upgrade = {
      ...answersWith(),
      mode: "upgrade",
    } as unknown as AnswersV1;
    const result = planAdoptActions(inventoryWith(), upgrade, ioOf());
    expect(usageErrors(result).map((e) => e.pointer)).toEqual(["/mode"]);
  });
});

describe("planAdoptActions: defensive checks past validateAnswers", () => {
  const usageErrors = (result: AdoptPlanResult) =>
    !result.ok && result.kind === "usage" ? result.errors : [];

  it("rejects two additions with exactly the same path instead of planning two actions", () => {
    const base = answersWith([{ path: "a.txt", action: "skip" }]);
    const twice = {
      ...base,
      adopt: {
        ...base.adopt,
        additions: [
          { path: "a.txt", action: "skip" },
          { path: "a.txt", action: "skip" },
        ],
      },
    } as unknown as AnswersV1;
    const result = planAdoptActions(
      inventoryWith({ conflicts: [absent("a.txt")], baseline: ["a.txt"] }),
      twice,
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(usageErrors(result).length).toBeGreaterThan(0);
  });

  it("rejects two conflict answers with exactly the same path instead of planning two actions", () => {
    const base = answersWith([], [{ path: "t.json", resolution: "keep" }]);
    const twice = {
      ...base,
      adopt: {
        ...base.adopt,
        conflicts: [
          { path: "t.json", resolution: "keep" },
          { path: "t.json", resolution: "keep" },
        ],
      },
    } as unknown as AnswersV1;
    const result = planAdoptActions(
      inventoryWith({
        conflicts: [divergent("t.json")],
        divergent: ["t.json"],
      }),
      twice,
      ioOf(),
    );
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(usageErrors(result).length).toBeGreaterThan(0);
  });
});

describe("planAdoptActions: inventory without staged divergent copies", () => {
  const usageErrors = (result: AdoptPlanResult) =>
    !result.ok && result.kind === "usage" ? result.errors : [];
  const versionHint = expect.stringMatching(/schema|version|staged/i) as string;

  it("turns a take into a usage error, never a TypeError", () => {
    const run = () =>
      planAdoptActions(
        legacyInventoryWith({ conflicts: [divergent("t.json")] }),
        answersWith([], [{ path: "t.json", resolution: "take" }]),
        ioOf({ "t.json": H1 }),
      );
    expect(run).not.toThrow();
    expect(usageErrors(run())).toContainEqual({
      pointer: expect.stringContaining("/adopt/conflicts/0") as string,
      reason: versionHint,
    });
  });

  it("turns a merge-keys into a usage error, never a TypeError", () => {
    const run = () =>
      planAdoptActions(
        legacyInventoryWith({
          conflicts: [divergent("package.json", H1, ["scripts"])],
        }),
        answersWith(
          [],
          [
            {
              path: "package.json",
              resolution: "merge-keys",
              takeKeys: ["scripts"],
            },
          ],
        ),
        ioOf({ "package.json": H1 }),
      );
    expect(run).not.toThrow();
    expect(usageErrors(run())).toContainEqual({
      pointer: expect.stringContaining("/adopt/conflicts/0") as string,
      reason: versionHint,
    });
  });

  it("turns an add against an inventory below schema 5 into an old-schema usage error, never a TypeError", () => {
    const { stagedBaseline: _dropped, ...rest } = inventoryWith({
      conflicts: [absent("a.txt")],
    }) as unknown as Record<string, unknown>;
    const preStaged = { ...rest, schemaVersion: 4 } as unknown as Inventory;
    const run = () =>
      planAdoptActions(
        preStaged,
        answersWith([{ path: "a.txt", action: "add" }]),
        ioOf(),
      );
    expect(run).not.toThrow();
    const result = run();
    expect(result).toMatchObject({ ok: false, kind: "usage" });
    expect(usageErrors(result)).toContainEqual({
      pointer: expect.stringContaining("/adopt/additions/0") as string,
      reason: expect.stringMatching(
        /stagedBaseline.*schemaVersion 4.*needs 5/s,
      ) as string,
    });
  });

  it("still plans a keep for such an inventory without throwing", () => {
    const run = () =>
      planAdoptActions(
        legacyInventoryWith({ conflicts: [divergent("t.json")] }),
        answersWith([], [{ path: "t.json", resolution: "keep" }]),
        ioOf(),
      );
    expect(run).not.toThrow();
  });
});

describe("planAdoptActions: types", () => {
  it("returns a discriminated result", () => {
    expectTypeOf(planAdoptActions).returns.toEqualTypeOf<AdoptPlanResult>();
    expectTypeOf<PlanIo["sha256OfTarget"]>().toEqualTypeOf<
      (path: string) => TargetState
    >();
    expectTypeOf<TargetState>().toEqualTypeOf<
      | { readonly kind: "absent" }
      | { readonly kind: "file"; readonly sha256: string }
      | { readonly kind: "unreadable"; readonly code: string }
    >();
    type Failure = Extract<AdoptPlanResult, { ok: false }>;
    expectTypeOf<Failure["kind"]>().toEqualTypeOf<"usage" | "drift">();
  });
});

describe("planAdoptActions: properties", () => {
  const POOL = ["a.txt", "b.json", "sub/c.txt", "d/.git/x", "A.TXT", "e.md"];
  const inventory = inventoryWith({
    conflicts: [
      absent("a.txt"),
      absent("sub/c.txt"),
      absent("d/.git/x"),
      divergent("b.json", H1, ["scripts"]),
      divergent("e.md", null),
    ],
    baseline: ["a.txt", "sub/c.txt"],
    divergent: ["b.json", "e.md"],
  });
  const additionArb = fc.record({
    path: fc.constantFrom(...POOL),
    action: fc.constantFrom("add", "skip"),
  });
  const conflictArb = fc.record(
    {
      path: fc.constantFrom(...POOL),
      resolution: fc.constantFrom("keep", "take", "merge-keys", "delegate"),
      takeKeys: fc.array(fc.constantFrom("scripts", "name", "bogus"), {
        maxLength: 3,
      }),
    },
    { requiredKeys: ["path", "resolution"] },
  );

  test("never throws on validator-accepted answers and always returns a known result kind", () => {
    fc.assert(
      fc.property(
        fc.array(additionArb, { maxLength: 6 }),
        fc.array(conflictArb, { maxLength: 6 }),
        fc.dictionary(fc.constantFrom(...POOL), fc.constantFrom(H1, H2)),
        (additions, conflicts, files) => {
          const doc = {
            schema: "groundwork.answers",
            schemaVersion: 1,
            mode: "adopt",
            basis: { inventorySha256: INV_SHA },
            fresh: null,
            interview: {
              kind: "cli",
              runtime: "node",
              testsMandatory: null,
              ciDepth: null,
              keepAgents: null,
            },
            adopt: { additions, conflicts, missedNotes: "" },
            upgrade: null,
            packs: { install: [], decline: [] },
            plugins: { enabled: [], declined: [] },
            guidance: { enabled: false, domains: [] },
            pending: [],
          };
          const validated = validateAnswers(doc, "complete");
          fc.pre(validated.ok);
          if (!validated.ok) return;
          const result = planAdoptActions(
            inventory,
            validated.value,
            ioOf(files),
          );
          const kind = result.ok ? "ok" : result.kind;
          expect(["ok", "usage", "drift"]).toContain(kind);
        },
      ),
    );
  });
});
