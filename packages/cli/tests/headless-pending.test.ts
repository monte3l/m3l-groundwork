// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The pure adopt pending-document builder (src/headless/pending.ts): an
 * answers v1 partial profile with safe defaults prefilled and every decision
 * nobody made (kind, runtime, each divergent conflict's resolution) null and
 * listed in `pending`.
 */
import { describe, expect, expectTypeOf, it, test } from "vitest";
import * as fc from "fast-check";
import { buildAdoptPending } from "../src/headless/pending.js";
import {
  BASELINE_AGENTS,
  PROJECT_KINDS,
  RUNTIME_TARGETS,
  validateAnswers,
  type AnswersV1,
} from "../src/headless/contract.js";
import type { FileConflict } from "../src/conflicts.js";
import type { Inventory } from "../src/inventory.js";

const SHA = "a".repeat(64);

/** Only `conflicts` is read by the builder; the rest of an inventory is irrelevant to it. */
function inventoryWith(conflicts: FileConflict[]): Inventory {
  return { schemaVersion: 6, conflicts, packs: [] } as unknown as Inventory;
}

function build(conflicts: FileConflict[]): AnswersV1 {
  return buildAdoptPending(inventoryWith(conflicts), { inventorySha256: SHA });
}

const absent = (relPath: string): FileConflict => ({
  relPath,
  status: "absent",
  keyDiffs: undefined,
  targetSha256: null,
});
const identical = (relPath: string): FileConflict => ({
  relPath,
  status: "identical",
  keyDiffs: undefined,
  targetSha256: null,
});
const divergent = (relPath: string, keyDiffs?: string[]): FileConflict => ({
  relPath,
  status: "divergent",
  keyDiffs,
  targetSha256: null,
});

describe("buildAdoptPending", () => {
  it("has the adopt envelope: mode adopt, fresh/upgrade null, basis bound to the inventory hash", () => {
    const doc = build([]);
    expect(doc).toMatchObject({
      schema: "groundwork.answers",
      schemaVersion: 1,
      mode: "adopt",
      fresh: null,
      upgrade: null,
      basis: { inventorySha256: SHA },
    });
  });

  it("prefills the safe defaults and leaves kind/runtime null", () => {
    const doc = build([]);
    expect(doc.interview).toEqual({
      kind: null,
      runtime: null,
      testsMandatory: true,
      ciDepth: "standard",
      keepAgents: [...BASELINE_AGENTS],
    });
    expect(doc.packs).toEqual({ install: [], decline: [] });
    expect(doc.plugins).toEqual({ enabled: [], declined: [] });
    expect(doc.guidance).toEqual({ enabled: false, domains: [] });
    expect(doc.adopt?.missedNotes).toBe("");
  });

  it("an inventory with no conflicts still yields the kind and runtime pending entries", () => {
    const doc = build([]);
    expect(doc.adopt).toEqual({
      additions: [],
      conflicts: [],
      missedNotes: "",
    });
    expect(doc.pending).toEqual([
      {
        pointer: "/interview/kind",
        reason: expect.any(String) as string,
        choices: [...PROJECT_KINDS],
        evidence: null,
      },
      {
        pointer: "/interview/runtime",
        reason: expect.any(String) as string,
        choices: [...RUNTIME_TARGETS],
        evidence: null,
      },
    ]);
    expect(doc.pending[0]?.reason.length).toBeGreaterThan(0);
    expect(doc.pending[0]?.reason).not.toBe(doc.pending[1]?.reason);
  });

  it("turns absent conflicts into add additions and omits identical ones from both lists", () => {
    const doc = build([
      absent("eslint.config.js"),
      identical("LICENSE"),
      absent(".prettierrc"),
    ]);
    expect(doc.adopt?.additions).toEqual([
      { path: "eslint.config.js", action: "add" },
      { path: ".prettierrc", action: "add" },
    ]);
    expect(doc.adopt?.conflicts).toEqual([]);
    expect(doc.pending.map((p) => p.pointer)).toEqual([
      "/interview/kind",
      "/interview/runtime",
    ]);
  });

  it("lists each divergent conflict with a null resolution, in inventory order, with a pending entry per conflict index", () => {
    const doc = build([
      divergent("tsconfig.json", ["compilerOptions", "include"]),
      absent("a.txt"),
      divergent("CLAUDE.md"),
      identical("x"),
      divergent("package.json", ["scripts"]),
    ]);
    expect(doc.adopt?.conflicts).toEqual([
      { path: "tsconfig.json", resolution: null },
      { path: "CLAUDE.md", resolution: null },
      { path: "package.json", resolution: null },
    ]);
    expect(doc.pending.map((p) => p.pointer)).toEqual([
      "/interview/kind",
      "/interview/runtime",
      "/adopt/conflicts/0/resolution",
      "/adopt/conflicts/1/resolution",
      "/adopt/conflicts/2/resolution",
    ]);
  });

  it("offers merge-keys (and names the keys) only for a key-level conflict; a whole-file conflict says so", () => {
    const doc = build([
      divergent("tsconfig.json", ["compilerOptions", "include"]),
      divergent("CLAUDE.md"),
    ]);
    const [, , keyLevel, whole] = doc.pending;
    expect(keyLevel).toMatchObject({
      pointer: "/adopt/conflicts/0/resolution",
      choices: ["keep", "take", "delegate", "merge-keys"],
      evidence: "differs in keys: compilerOptions, include",
    });
    expect(whole).toMatchObject({
      pointer: "/adopt/conflicts/1/resolution",
      choices: ["keep", "take", "delegate"],
      evidence: "whole file differs",
    });
    expect(keyLevel?.reason.length).toBeGreaterThan(0);
    expect(whole?.reason).toBe(keyLevel?.reason);
  });

  it("is always valid as partial and never valid as complete", () => {
    for (const conflicts of [
      [],
      [absent("a")],
      [divergent("package.json", ["name"]), divergent("b.md")],
    ]) {
      const doc = build(conflicts);
      expect(validateAnswers(doc, "partial").ok).toBe(true);
      expect(validateAnswers(doc, "complete").ok).toBe(false);
    }
  });

  it("is deterministic: the same inventory gives a deep-equal result with no timestamps", () => {
    const inv = inventoryWith([absent("a"), divergent("b", ["k"])]);
    const first = buildAdoptPending(inv, { inventorySha256: SHA });
    const second = buildAdoptPending(inv, { inventorySha256: SHA });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("does not mutate the inventory", () => {
    const conflicts = [absent("a"), divergent("b", ["k"])];
    const before = structuredClone(conflicts);
    build(conflicts);
    expect(conflicts).toEqual(before);
  });

  it("returns an AnswersV1", () => {
    expectTypeOf(buildAdoptPending).returns.toEqualTypeOf<AnswersV1>();
  });
});

const pathArb = fc
  .stringMatching(/^[a-z][a-z0-9]{0,8}(\/[a-z][a-z0-9]{0,8}){0,2}\.[a-z]{1,3}$/)
  .filter((p) => !p.startsWith("git"));
const conflictArb = fc.oneof(
  pathArb.map(absent),
  pathArb.map(identical),
  fc
    .tuple(
      pathArb,
      fc.option(
        fc.array(fc.constantFrom("a", "b", "c"), {
          minLength: 1,
          maxLength: 3,
        }),
        { nil: undefined },
      ),
    )
    .map(([p, k]) => divergent(p, k)),
);
const conflictsArb = fc.uniqueArray(conflictArb, {
  selector: (c) => c.relPath,
  maxLength: 20,
});

describe("buildAdoptPending properties", () => {
  test("partial-valid, never complete, counts and order follow the conflicts", () => {
    fc.assert(
      fc.property(conflictsArb, (conflicts) => {
        const doc = build(conflicts);
        const divergents = conflicts.filter((c) => c.status === "divergent");
        const absents = conflicts.filter((c) => c.status === "absent");
        expect(validateAnswers(doc, "partial").ok).toBe(true);
        expect(validateAnswers(doc, "complete").ok).toBe(false);
        expect(doc.pending).toHaveLength(2 + divergents.length);
        expect(doc.adopt?.additions).toEqual(
          absents.map((c) => ({ path: c.relPath, action: "add" })),
        );
        expect(doc.adopt?.conflicts.map((c) => c.path)).toEqual(
          divergents.map((c) => c.relPath),
        );
        expect(doc.adopt?.conflicts.every((c) => c.resolution === null)).toBe(
          true,
        );
        expect(build(conflicts)).toEqual(doc);
      }),
    );
  });
});
