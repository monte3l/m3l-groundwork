// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `planPacks` (`pack-stage.ts`) calls `statSync(filesDir, { throwIfNoEntry:
 * false })` to check a pack's `files/` tree exists; `throwIfNoEntry: false`
 * only suppresses `ENOENT` -- any OTHER `statSync` failure (a permission
 * error, say) propagates raw and uncaught today. It must instead surface as
 * a plan-time `Error` naming the pack and the path, with the real failure
 * chained as `cause`, leaving `.groundwork/` untouched. `node:fs`'s
 * `statSync` is mocked (importOriginal-preserving) in this file ONLY,
 * matching the isolation pattern every other mocked-`node:fs` sibling file
 * in this directory uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pack } from "../src/packs.js";

const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, statSync: statSyncMock };
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

describe("planPacks -- non-ENOENT statSync failure", () => {
  let filesRoot: string;
  let groundworkDir: string;
  let realStatSync: typeof FsModule.statSync;
  const statFailure = Object.assign(new Error("simulated EACCES"), {
    code: "EACCES",
  });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realStatSync = actual.statSync;
    statSyncMock.mockReset();
    filesRoot = mkdtempSync(join(tmpdir(), "pack-statsync-files-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "pack-statsync-gw-"));
    statSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.statSync>) => {
        const [path] = args;
        if (path === filesRoot) {
          throw statFailure;
        }
        return (
          realStatSync as (
            ...callArgs: Parameters<typeof FsModule.statSync>
          ) => ReturnType<typeof FsModule.statSync>
        )(...args);
      },
    );
  });

  afterEach(() => {
    statSyncMock.mockReset();
    rmSync(filesRoot, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("surfaces a non-ENOENT statSync failure as a plan-time Error naming the pack and the path, with the real failure chained as cause, writing nothing", () => {
    let thrown: unknown;
    try {
      stagePacks([makePack("acme", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(statFailure);
    const message = (thrown as Error).message;
    expect(message).toContain("acme");
    expect(message).toContain(filesRoot);
    expect((thrown as Error).cause).toBe(statFailure);
    expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
  });
});
