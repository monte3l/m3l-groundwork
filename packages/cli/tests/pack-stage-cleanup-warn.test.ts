// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stagePacks`' `finally` cleanup branch: when removing the
 * temporary `.packs-*` staging work directory itself fails (best-effort
 * today, but must not fail silently), it must warn naming the work
 * directory path. `node:fs`'s `rmSync` is mocked (importOriginal-preserving)
 * in this file ONLY, matching the isolation
 * `baseline-stage-cleanup-warn.test.ts` uses for the same export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pack } from "../src/packs.js";

const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, rmSync: rmSyncMock };
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

describe("stagePacks -- work dir cleanup failure", () => {
  let filesRoot: string;
  let groundworkDir: string;
  let realRmSync: typeof FsModule.rmSync;
  const cleanupFailure = new Error("simulated rmSync failure");

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRmSync = actual.rmSync;
    rmSyncMock.mockReset();
    filesRoot = mkdtempSync(join(tmpdir(), "pack-cleanup-warn-files-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "pack-cleanup-warn-gw-"));
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    vi.restoreAllMocks();
    realRmSync(filesRoot, { recursive: true, force: true });
    realRmSync(groundworkDir, { recursive: true, force: true });
  });

  it("calls console.warn with the work dir path when removing the temp staging work dir fails", () => {
    writeFileSync(join(filesRoot, "only.txt"), "same\n");

    let capturedWorkDir = "";
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => {
        const [path] = args;
        if (
          typeof path === "string" &&
          path.includes(join(groundworkDir, ".packs-"))
        ) {
          capturedWorkDir = path;
          throw cleanupFailure;
        }
        return realRmSync(...args);
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    stagePacks([makePack("only", filesRoot)], groundworkDir, {});

    expect(warnSpy).toHaveBeenCalled();
    const sawWorkDir = warnSpy.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes(capturedWorkDir),
      ),
    );
    expect(capturedWorkDir).not.toBe("");
    expect(sawWorkDir).toBe(true);

    expect(
      readdirSync(groundworkDir).some((name) => name.startsWith(".packs-")),
    ).toBe(true);
  });

  it("warns with String(error) (not error.message) when the removal failure itself is a non-Error throw", () => {
    writeFileSync(join(filesRoot, "only.txt"), "same\n");

    const stringFailure = "simulated-non-error-rmSync-failure";
    let capturedWorkDir = "";
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => {
        const [path] = args;
        if (
          typeof path === "string" &&
          path.includes(join(groundworkDir, ".packs-"))
        ) {
          capturedWorkDir = path;
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to exercise removeBestEffort's String(error) fallback
          throw stringFailure;
        }
        return realRmSync(...args);
      },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    stagePacks([makePack("only-string", filesRoot)], groundworkDir, {});

    expect(capturedWorkDir).not.toBe("");
    const sawStringMessage = warnSpy.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes(stringFailure),
      ),
    );
    expect(sawStringMessage).toBe(true);
  });
});
