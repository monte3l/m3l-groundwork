// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `planPackStaging` (round-3 item 2) computes the same plan
 * `plannedPackStagingPaths` already returned, as a reusable `PackStagingPlan`
 * carrying (at least) `paths`; `stagePacks` takes that plan as an optional
 * trailing argument so `runAdopt` can compute every staging plan exactly
 * once, before any `.groundwork/` deletion, and hand the already-computed
 * plan to the stager rather than re-walking the pack's `files/` tree a
 * second time. `plannedPackStagingPaths` keeps working as a thin wrapper
 * over `planPackStaging(...).paths`. This file is isolated from
 * `pack-stage.test.ts`'s existing byte-level coverage, which stays
 * unchanged -- `stagePacks` called with no plan must still compute its own,
 * exactly as it does today.
 *
 * `node:fs`'s `readdirSync` is wrapped (not replaced) so this file can prove
 * a directory LISTING of the pack's source tree is never re-read once a
 * plan is handed to `stagePacks` -- the chosen proof method per the
 * contract's own note, since the staged bytes themselves are still read at
 * write time via `readFileSync(sourcePath)`, which this file does not touch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { CapCounts } from "../src/caps.js";
import type { Pack, PackManifest } from "../src/packs.js";

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

const { planPackStaging, plannedPackStagingPaths, stagePacks } =
  await import("../src/pack-stage.js");

const EMPTY_BUDGET: CapCounts = {
  agents: 0,
  skills: 0,
  hooks: 0,
  workflows: 0,
  scripts: 0,
};

function makeManifest(
  name: string,
  overrides: Partial<PackManifest> = {},
): PackManifest {
  return {
    schemaVersion: 1,
    name,
    description: `the ${name} test pack`,
    modes: ["fresh", "adopt"],
    budget: EMPTY_BUDGET,
    requires: undefined,
    wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
    adoptNotes: undefined,
    ...overrides,
  };
}

function makePack(name: string, filesDir: string): Pack {
  return { manifest: makeManifest(name), filesDir };
}

function sourceReaddirCalls(root: string): number {
  return readdirSyncMock.mock.calls.filter(
    ([dir]) => typeof dir === "string" && dir.startsWith(root),
  ).length;
}

describe("planPackStaging / stagePacks(plan) (round-3 item 2)", () => {
  afterEach(() => {
    readdirSyncMock.mockClear();
  });

  it("planPackStaging's paths equal plannedPackStagingPaths' output for identical inputs (thin-wrapper equivalence)", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-plan-equiv-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-plan-equiv-gw-"));
    try {
      writeFileSync(join(filesRoot, "a.txt"), "a\n");
      const pack = makePack("plan-equiv-pack", filesRoot);

      const plan = planPackStaging([pack], groundworkDir, {});
      const legacy = plannedPackStagingPaths([pack], groundworkDir, {});

      expect(plan.paths.length).toBeGreaterThan(0);
      expect(plan.paths).toEqual(legacy);
      // Planning writes nothing.
      expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("stagePacks given a precomputed plan stages exactly the planned files WITHOUT re-reading the pack's files directory listing a second time", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-plan-reuse-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-plan-reuse-gw-"));
    try {
      mkdirSync(join(filesRoot, "nested"), { recursive: true });
      writeFileSync(join(filesRoot, "a.txt"), "a\n");
      writeFileSync(join(filesRoot, "nested", "b.txt"), "b\n");
      const pack = makePack("plan-reuse-pack", filesRoot);

      const plan = planPackStaging([pack], groundworkDir, {});
      // Sanity: planning itself does walk the pack's files/ tree.
      expect(sourceReaddirCalls(filesRoot)).toBeGreaterThan(0);
      readdirSyncMock.mockClear();

      const staged = stagePacks([pack], groundworkDir, {}, plan);

      // The directory LISTING of the pack's source tree must not be read
      // again during staging -- every readdirSync call from here on targets
      // groundworkDir's own work-directory machinery, never filesRoot.
      expect(sourceReaddirCalls(filesRoot)).toBe(0);

      expect(staged[0]?.files.map((f) => f.path).sort()).toEqual(
        ["a.txt", "nested/b.txt"].sort(),
      );
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "plan-reuse-pack",
            "files",
            "a.txt.staged",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "plan-reuse-pack",
            "files",
            "nested",
            "b.txt.staged",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("stagePacks without a plan still computes its own and stages normally -- the plan argument stays optional", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-plan-optional-files-"));
    const groundworkDir = mkdtempSync(join(tmpdir(), "pack-plan-optional-gw-"));
    try {
      writeFileSync(join(filesRoot, "a.txt"), "a\n");
      const pack = makePack("no-plan-pack", filesRoot);

      const staged = stagePacks([pack], groundworkDir, {});

      expect(staged[0]?.name).toBe("no-plan-pack");
      expect(
        existsSync(
          join(groundworkDir, "packs", "no-plan-pack", "files", "a.txt.staged"),
        ),
      ).toBe(true);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });

  it("stagePacks throws a plain Error naming both directories when given a plan built for a DIFFERENT groundworkDir, writing nothing (item 4: invariant-bound plan)", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "pack-plan-mismatch-files-"));
    const groundworkDirA = mkdtempSync(
      join(tmpdir(), "pack-plan-mismatch-gw-a-"),
    );
    const groundworkDirB = mkdtempSync(
      join(tmpdir(), "pack-plan-mismatch-gw-b-"),
    );
    try {
      writeFileSync(join(filesRoot, "a.txt"), "a\n");
      const pack = makePack("mismatch-pack", filesRoot);
      const plan = planPackStaging([pack], groundworkDirA, {});

      let thrown: unknown;
      try {
        stagePacks([pack], groundworkDirB, {}, plan);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(assert.AssertionError);
      expect((thrown as Error).message).toMatch(/plan was built for/);
      expect((thrown as Error).message).toContain(groundworkDirA);
      expect((thrown as Error).message).toContain(groundworkDirB);

      // Nothing was written under either groundworkDir's packs/, and no
      // temporary work directory was left behind.
      expect(existsSync(join(groundworkDirA, "packs"))).toBe(false);
      expect(existsSync(join(groundworkDirB, "packs"))).toBe(false);
      expect(
        readdirSync(groundworkDirB).some((name) => name.startsWith(".packs-")),
      ).toBe(false);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDirA, { recursive: true, force: true });
      rmSync(groundworkDirB, { recursive: true, force: true });
    }
  });

  it("stagePacks does NOT throw when the plan's groundworkDir resolves to the SAME directory as the one passed, even if the strings differ (path.resolve comparison, not strict string equality)", () => {
    const filesRoot = mkdtempSync(
      join(tmpdir(), "pack-plan-resolve-eq-files-"),
    );
    const groundworkDir = mkdtempSync(
      join(tmpdir(), "pack-plan-resolve-eq-gw-"),
    );
    try {
      writeFileSync(join(filesRoot, "a.txt"), "a\n");
      const pack = makePack("resolve-eq-pack", filesRoot);
      const plan = planPackStaging([pack], groundworkDir, {});

      // Differs as a string (trailing "/.") but resolves to the same
      // directory as groundworkDir.
      const variant = `${groundworkDir}${sep}.`;
      const staged = stagePacks([pack], variant, {}, plan);

      expect(staged[0]?.name).toBe("resolve-eq-pack");
      expect(
        existsSync(
          join(
            groundworkDir,
            "packs",
            "resolve-eq-pack",
            "files",
            "a.txt.staged",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
      rmSync(groundworkDir, { recursive: true, force: true });
    }
  });
});
