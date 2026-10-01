// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stagePacks`' failure branch AFTER the temporary staging work dir
 * already exists (one file already copied, a later one fails to write): the
 * thrown error must wrap the real cause (`.groundwork/` + "incomplete" +
 * "re-run" + the cause's own message), and no `.packs-*` temp dir may survive
 * under `groundworkDir` while any previous `packs/` stays intact. `node:fs`'s
 * `writeFileSync` is mocked (importOriginal-preserving) in this file ONLY,
 * matching the isolation `baseline-stage-write-failure.test.ts` uses for the
 * same export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pack } from "../src/packs.js";

const { writeFileSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, writeFileSync: writeFileSyncMock };
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

describe("stagePacks -- write failure after the temp dir exists", () => {
  let filesRoot: string;
  let groundworkDir: string;
  let realWriteFileSync: typeof FsModule.writeFileSync;
  const writeFailure = new Error("simulated disk full");

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteFileSync = actual.writeFileSync;
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.writeFileSync>) => {
        const [path] = args;
        if (typeof path === "string" && path.endsWith("b.txt.staged")) {
          throw writeFailure;
        }
        return realWriteFileSync(...args);
      },
    );
    filesRoot = mkdtempSync(join(tmpdir(), "pack-write-failure-files-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "pack-write-failure-gw-"));
  });

  afterEach(() => {
    writeFileSyncMock.mockReset();
    rmSync(filesRoot, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("wraps the write failure as cause, naming '.groundwork/', 'incomplete', 're-run' and the cause's own message, leaving no .packs-* temp dir and the previous packs/ intact", async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    actual.writeFileSync(join(filesRoot, "a.txt"), "a\n");
    actual.writeFileSync(join(filesRoot, "b.txt"), "b\n");

    let thrown: unknown;
    try {
      stagePacks([makePack("two-files", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(".groundwork/");
    expect(message).toContain("incomplete");
    expect(message).toContain("re-run");
    expect(message).toContain(writeFailure.message);
    expect((thrown as Error).cause).toBe(writeFailure);

    expect(existsSync(join(groundworkDir, "packs"))).toBe(false);
    expect(
      readdirSync(groundworkDir).filter((name) => name.startsWith(".")),
    ).toEqual([]);
  });

  it("embeds String(cause) in the wrapped message (not cause.message) when the underlying failure is a non-Error throw", async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    actual.writeFileSync(join(filesRoot, "a.txt"), "a\n");
    actual.writeFileSync(join(filesRoot, "b.txt"), "b\n");

    const stringFailure = "simulated-non-error-disk-full";
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.writeFileSync>) => {
        const [path] = args;
        if (typeof path === "string" && path.endsWith("b.txt.staged")) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to exercise incompleteStagingError's String(cause) fallback
          throw stringFailure;
        }
        return realWriteFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      stagePacks([makePack("two-files-string", filesRoot)], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(stringFailure);
    expect((thrown as Error).cause).toBe(stringFailure);
  });
});
