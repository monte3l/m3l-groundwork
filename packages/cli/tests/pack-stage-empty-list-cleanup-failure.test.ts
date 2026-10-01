// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Isolates `stagePacks`' empty-list branch (no packs passed): removing any
 * previous `packs/` staging there is wrapped in the same standard
 * ".groundwork/ ... incomplete ... re-run" `Error` with `cause` every other
 * staging failure gets -- this file pins that the empty-list branch
 * specifically gets the same treatment, rather than letting a raw, unwrapped
 * `rmSync` error propagate instead. `node:fs`'s `rmSync` is mocked
 * (importOriginal-preserving) in this file ONLY, matching the isolation
 * pattern `baseline-stage-empty-plan-cleanup-failure.test.ts` uses for the
 * same export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import type * as FsModule from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, rmSync: rmSyncMock };
});

const { stagePacks } = await import("../src/pack-stage.js");

describe("stagePacks -- empty-list cleanup failure", () => {
  let groundworkDir: string;
  let realRmSync: typeof FsModule.rmSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realRmSync = actual.rmSync;
    rmSyncMock.mockReset();
    rmSyncMock.mockImplementation(
      (...args: Parameters<typeof FsModule.rmSync>) => realRmSync(...args),
    );
    groundworkDir = mkdtempSync(join(tmpdir(), "pack-empty-list-gw-"));
  });

  afterEach(() => {
    rmSyncMock.mockReset();
    realRmSync(groundworkDir, { recursive: true, force: true });
  });

  it("wraps a failure removing the previous packs/ (when the pack list is empty) in the standard incomplete/re-run Error with cause, instead of letting it propagate raw", () => {
    const cleanupFailure = new Error(
      "simulated rmSync failure removing packs/",
    );
    rmSyncMock.mockImplementation(() => {
      throw cleanupFailure;
    });

    let thrown: unknown;
    try {
      stagePacks([], groundworkDir, {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(cleanupFailure);
    expect((thrown as Error).cause).toBe(cleanupFailure);
    const message = (thrown as Error).message;
    expect(message).toContain(".groundwork/");
    expect(message).toContain("incomplete");
    expect(message).toContain("re-run");
  });
});
