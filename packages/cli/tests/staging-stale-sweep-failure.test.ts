// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `staging.ts`'s stale-work-dir sweep (`removeStaleWorkDirs`, called from
 * `prepareStaging` before the first temp directory is ever created) lists
 * `groundworkDir` with a bare `readdirSync(groundworkDir)` call -- no
 * `withFileTypes` option, unlike every other directory walk this module and
 * its callers perform. A permission failure on that specific call (EACCES,
 * say) must not propagate raw and uncaught: both `stageBaselineAdditions`
 * and `stagePacks` must wrap it in the same standard
 * `.groundwork/ is incomplete -- re-run` `Error`, cause chained, that every
 * other staging failure gets. `node:fs`'s `readdirSync` is mocked
 * (importOriginal-preserving) in this file ONLY, matching the isolation
 * pattern every other mocked-`node:fs` sibling file in this directory uses;
 * the mock distinguishes the sweep's own no-options call from every other
 * `readdirSync(dir, { withFileTypes: true })` tree-walk call by arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planConflicts } from "../src/conflicts.js";
import {
  STAGED_BASELINE_DIR,
  stageBaselineAdditions,
} from "../src/baseline-stage.js";
import type { Pack } from "../src/packs.js";

const { readdirSyncMock } = vi.hoisted(() => ({ readdirSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, readdirSync: readdirSyncMock };
});

const { stagePacks } = await import("../src/pack-stage.js");

function makePack(name: string, filesDir: string): Pack {
  return {
    manifest: {
      schemaVersion: 1,
      name,
      description: "a test pack",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      requires: undefined,
      wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      adoptNotes: undefined,
    },
    filesDir,
  };
}

describe("stale .baseline-*/.packs-* work-dir sweep -- readdirSync failure", () => {
  let realReaddirSync: typeof FsModule.readdirSync;
  let groundworkDir: string;
  const sweepFailure = Object.assign(new Error("simulated EACCES"), {
    code: "EACCES",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReaddirSync = actual.readdirSync;
    readdirSyncMock.mockReset();
    groundworkDir = mkdtempSync(join(tmpdir(), "stale-sweep-gw-"));
    readdirSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.readdirSync>) => {
        const [dir, options] = args;
        if (dir === groundworkDir && options === undefined) {
          throw sweepFailure;
        }
        return (
          realReaddirSync as (
            ...callArgs: Parameters<typeof FsModule.readdirSync>
          ) => ReturnType<typeof FsModule.readdirSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    readdirSyncMock.mockReset();
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("wraps the sweep's readdirSync failure in the standard incomplete/re-run Error (cause chained) for stageBaselineAdditions, rather than letting it propagate raw", () => {
    const templateRoot = mkdtempSync(join(tmpdir(), "stale-sweep-template-"));
    const targetDir = mkdtempSync(join(tmpdir(), "stale-sweep-target-"));
    try {
      writeFileSync(join(templateRoot, "only.txt"), "same everywhere\n");
      const conflicts = planConflicts(templateRoot, targetDir, {});

      let thrown: unknown;
      try {
        stageBaselineAdditions(templateRoot, conflicts, groundworkDir, {});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBe(sweepFailure);
      expect((thrown as Error).cause).toBe(sweepFailure);
      const message = (thrown as Error).message;
      expect(message).toContain(".groundwork/");
      expect(message).toContain("incomplete");
      expect(message).toContain("re-run");
      expect(existsSync(join(groundworkDir, STAGED_BASELINE_DIR))).toBe(false);
    } finally {
      rmSync(templateRoot, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("wraps the sweep's readdirSync failure in the standard incomplete/re-run Error (cause chained) for stagePacks, rather than letting it propagate raw", () => {
    const filesRoot = mkdtempSync(join(tmpdir(), "stale-sweep-pack-files-"));
    try {
      writeFileSync(join(filesRoot, "only.txt"), "same everywhere\n");

      let thrown: unknown;
      try {
        stagePacks([makePack("swept", filesRoot)], groundworkDir, {});
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBe(sweepFailure);
      expect((thrown as Error).cause).toBe(sweepFailure);
      const message = (thrown as Error).message;
      expect(message).toContain(".groundwork/");
      expect(message).toContain("incomplete");
      expect(message).toContain("re-run");
      expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });
});
