// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `planBaselineStaging` (round-3 item 2) computes the same plan
 * `plannedBaselineStagingPaths` already returned, as a reusable
 * `BaselineStagingPlan` carrying (at least) `paths`; `stageBaselineAdditions`
 * takes that plan as an optional trailing argument so `runAdopt` can compute
 * every staging plan exactly once, before any `.groundwork/` deletion, and
 * hand the already-computed plan to the stager rather than re-walking the
 * template tree a second time. `plannedBaselineStagingPaths` keeps working
 * as a thin wrapper over `planBaselineStaging(...).paths`. Mirrors
 * `pack-stage-plan.test.ts`'s structure and proof method one-to-one, applied
 * to the baseline stager.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type * as FsModule from "node:fs";

const { readdirSyncMock } = vi.hoisted(() => ({ readdirSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      readdirSyncMock(...args);
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

const { planConflicts } = await import("../src/conflicts.js");
const {
  planBaselineStaging,
  plannedBaselineStagingPaths,
  stageBaselineAdditions,
} = await import("../src/baseline-stage.js");

function sourceReaddirCalls(root: string): number {
  return readdirSyncMock.mock.calls.filter(
    ([dir]) => typeof dir === "string" && dir.startsWith(root),
  ).length;
}

describe("planBaselineStaging / stageBaselineAdditions(plan) (round-3 item 2)", () => {
  let templateRoot: string;
  let targetDir: string;
  let groundworkDir: string;

  beforeEach(() => {
    templateRoot = mkdtempSync(join(tmpdir(), "baseline-plan-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "baseline-plan-target-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "baseline-plan-groundwork-"));
    readdirSyncMock.mockClear();
  });

  afterEach(() => {
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("planBaselineStaging's paths equal plannedBaselineStagingPaths' output for identical inputs (thin-wrapper equivalence)", () => {
    writeFileSync(join(templateRoot, "new.txt"), "x\n");
    const conflicts = planConflicts(templateRoot, targetDir, {});

    const plan = planBaselineStaging(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );
    const legacy = plannedBaselineStagingPaths(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );

    expect(plan.paths.length).toBeGreaterThan(0);
    expect(plan.paths).toEqual(legacy);
    // Planning writes nothing.
    expect(existsSync(join(groundworkDir, "baseline"))).toBe(false);
  });

  it("stageBaselineAdditions given a precomputed plan stages exactly the planned files WITHOUT re-reading templateRoot's directory listing a second time", () => {
    mkdirSync(join(templateRoot, "nested"), { recursive: true });
    writeFileSync(join(templateRoot, "a.txt"), "a\n");
    writeFileSync(join(templateRoot, "nested", "b.txt"), "b\n");
    const conflicts = planConflicts(templateRoot, targetDir, {});

    const plan = planBaselineStaging(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );
    // Sanity: planning itself does walk templateRoot.
    expect(sourceReaddirCalls(templateRoot)).toBeGreaterThan(0);
    readdirSyncMock.mockClear();

    const staged = stageBaselineAdditions(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
      plan,
    );

    // templateRoot's directory LISTING must not be read again during
    // staging -- every readdirSync call from here on targets groundworkDir's
    // own work-directory machinery, never templateRoot.
    expect(sourceReaddirCalls(templateRoot)).toBe(0);

    expect(staged.map((f) => f.path).sort()).toEqual(
      ["a.txt", "nested/b.txt"].sort(),
    );
    expect(existsSync(join(groundworkDir, "baseline", "a.txt.staged"))).toBe(
      true,
    );
    expect(
      existsSync(join(groundworkDir, "baseline", "nested", "b.txt.staged")),
    ).toBe(true);
  });

  it("stageBaselineAdditions without a plan still computes its own and stages normally -- the plan argument stays optional", () => {
    writeFileSync(join(templateRoot, "solo.txt"), "s\n");
    const conflicts = planConflicts(templateRoot, targetDir, {});

    const staged = stageBaselineAdditions(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );

    expect(staged.map((f) => f.path)).toEqual(["solo.txt"]);
    expect(existsSync(join(groundworkDir, "baseline", "solo.txt.staged"))).toBe(
      true,
    );
  });

  it("stageBaselineAdditions throws a plain Error naming both directories when given a plan built for a DIFFERENT groundworkDir, writing nothing (item 4: invariant-bound plan)", () => {
    const groundworkDirB = mkdtempSync(
      join(tmpdir(), "baseline-plan-mismatch-gw-b-"),
    );
    try {
      writeFileSync(join(templateRoot, "mismatch.txt"), "x\n");
      const conflicts = planConflicts(templateRoot, targetDir, {});
      const plan = planBaselineStaging(
        templateRoot,
        conflicts,
        groundworkDir,
        {},
      );

      let thrown: unknown;
      try {
        stageBaselineAdditions(
          templateRoot,
          conflicts,
          groundworkDirB,
          {},
          plan,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(assert.AssertionError);
      expect((thrown as Error).message).toMatch(/plan was built for/);
      expect((thrown as Error).message).toContain(groundworkDir);
      expect((thrown as Error).message).toContain(groundworkDirB);

      expect(existsSync(join(groundworkDir, "baseline"))).toBe(false);
      expect(existsSync(join(groundworkDirB, "baseline"))).toBe(false);
      expect(
        readdirSync(groundworkDirB).some((name) =>
          name.startsWith(".baseline-"),
        ),
      ).toBe(false);
    } finally {
      rmSync(groundworkDirB, { recursive: true, force: true });
    }
  });

  it("stageBaselineAdditions does NOT throw when the plan's groundworkDir resolves to the SAME directory as the one passed (path.resolve comparison, not strict string equality)", () => {
    writeFileSync(join(templateRoot, "resolve-eq.txt"), "y\n");
    const conflicts = planConflicts(templateRoot, targetDir, {});
    const plan = planBaselineStaging(
      templateRoot,
      conflicts,
      groundworkDir,
      {},
    );

    // Differs as a string (trailing "/.") but resolves to the same
    // directory as groundworkDir.
    const variant = `${groundworkDir}${sep}.`;
    const staged = stageBaselineAdditions(
      templateRoot,
      conflicts,
      variant,
      {},
      plan,
    );

    expect(staged.map((f) => f.path)).toContain("resolve-eq.txt");
    expect(
      existsSync(join(groundworkDir, "baseline", "resolve-eq.txt.staged")),
    ).toBe(true);
  });
});
