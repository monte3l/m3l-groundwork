// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stagePackFiles`' handling of an `assert.AssertionError` thrown by
 * its copy step (`emitTemplate`'s own CWE-22 path-containment guard, see
 * `emit.ts`): that specific failure must surface UNWRAPPED -- the exact same
 * object, never re-wrapped in `stagePackFiles`' own ".groundwork/ is
 * incomplete -- re-run the CLI" `Error` -- because an assertion failure here
 * means a real security invariant broke, not an ordinary I/O failure a
 * re-run could fix. Any OTHER failure from the same copy step must still
 * wrap, exactly as before. `../src/emit.js`'s `emitTemplate` is mocked
 * (importOriginal-preserving) in this file ONLY, matching the isolation
 * pattern `baseline-stage-write-failure.test.ts` uses for `node:fs`, and
 * `main-pack-errors.test.ts` uses for `packs.js`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as EmitModule from "../src/emit.js";
import type { Pack } from "../src/packs.js";

const { emitTemplateMock } = vi.hoisted(() => ({
  emitTemplateMock: vi.fn(),
}));

vi.mock("../src/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof EmitModule>();
  return { ...actual, emitTemplate: emitTemplateMock };
});

const { loadPack, stagePackFiles } = await import("../src/packs.js");

function writeManifest(packsRoot: string, name: string): void {
  const packDir = join(packsRoot, name);
  mkdirSync(join(packDir, "files"), { recursive: true });
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({
      schemaVersion: 1,
      name,
      description: "a test pack",
      modes: ["fresh", "adopt"],
      budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
      requires: undefined,
      wiring: { settings: {}, packageScripts: {}, verifySteps: [] },
      adoptNotes: undefined,
    }),
  );
}

describe("stagePackFiles -- assert.AssertionError from the copy step", () => {
  let packsRoot: string;
  let groundworkDir: string;
  let pack: Pack;

  beforeEach(() => {
    packsRoot = mkdtempSync(join(tmpdir(), "packs-assertion-root-"));
    groundworkDir = mkdtempSync(join(tmpdir(), "packs-assertion-gw-"));
    writeManifest(packsRoot, "assertion-rethrow");
    pack = loadPack("assertion-rethrow", packsRoot);
  });

  afterEach(() => {
    emitTemplateMock.mockReset();
    rmSync(packsRoot, { recursive: true, force: true });
    rmSync(groundworkDir, { recursive: true, force: true });
  });

  it("surfaces an assert.AssertionError from emitTemplate unwrapped -- the same object, no '.groundwork/ is incomplete' wrapper", () => {
    const assertionError = new assert.AssertionError({
      message: "emitTemplate: target path escapes targetRoot",
    });
    emitTemplateMock.mockImplementationOnce(() => {
      throw assertionError;
    });

    let thrown: unknown;
    try {
      stagePackFiles(pack, groundworkDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(assertionError);
    expect(thrown).toBeInstanceOf(assert.AssertionError);
    expect((thrown as Error).message).not.toContain("is incomplete");
    expect((thrown as Error).message).not.toContain("re-run");
  });

  it("still wraps a non-assertion failure from emitTemplate with the '.groundwork/ is incomplete -- re-run' Error, cause preserved", () => {
    const copyFailure = new Error("simulated copy failure");
    emitTemplateMock.mockImplementationOnce(() => {
      throw copyFailure;
    });

    let thrown: unknown;
    try {
      stagePackFiles(pack, groundworkDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(copyFailure);
    expect((thrown as Error).message).toContain("is incomplete");
    expect((thrown as Error).message).toContain("re-run");
    expect((thrown as Error).cause).toBe(copyFailure);
  });
});
