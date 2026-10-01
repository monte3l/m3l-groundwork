// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt`'s handling of a `writeInventory` failure (round-2 nit F):
 * `inventory.json`'s presence is the signal that the whole adopt run
 * completed (see `main.ts`'s own header comment), so a `writeInventory`
 * failure must not leave a now-orphaned `adoption-report.md` behind that
 * implies a complete run -- the just-written report is removed, best
 * effort, and the original `writeInventory` failure still propagates
 * unchanged even when that removal itself fails. `../src/inventory.js`'s
 * `writeInventory` export is replaced outright (not `importOriginal`-wrapped
 * by default) so each test controls exactly when it fails, isolated from
 * `main-run.test.ts`'s own `inventory.js` mock (which always delegates to
 * the real implementation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type * as FsModule from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as InventoryModule from "../src/inventory.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn(() => ({ filesWritten: [] }));
const installCustomizeSkillGuardedMock = vi.fn(() => ({
  filesWritten: [],
  location: "claude" as const,
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
  installCustomizeSkillGuarded: installCustomizeSkillGuardedMock,
}));

const { writeInventoryMock, rmSyncMock } = vi.hoisted(() => ({
  writeInventoryMock: vi.fn(),
  rmSyncMock: vi.fn(),
}));

vi.mock("../src/inventory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof InventoryModule>();
  return {
    ...actual,
    writeInventory: (...args: Parameters<typeof actual.writeInventory>) =>
      writeInventoryMock(...args) as ReturnType<typeof actual.writeInventory>,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, rmSync: rmSyncMock };
});

const { main } = await import("../src/main.js");

describe("runAdopt -- writeInventory failure", () => {
  let targetDir: string;
  let realWriteInventory: typeof InventoryModule.writeInventory;
  let realRmSync: typeof FsModule.rmSync;

  beforeEach(async () => {
    const inventoryActual = await vi.importActual<typeof InventoryModule>(
      "../src/inventory.js",
    );
    const fsActual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteInventory = inventoryActual.writeInventory;
    realRmSync = fsActual.rmSync;

    writeInventoryMock.mockReset();
    writeInventoryMock.mockImplementation(
      (...args: Parameters<typeof realWriteInventory>) =>
        realWriteInventory(...args),
    );
    rmSyncMock.mockReset();
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) =>
      realRmSync(...args),
    );

    targetDir = mkdtempSync(join(tmpdir(), "main-write-inventory-fail-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
  });

  afterEach(() => {
    writeInventoryMock.mockReset();
    rmSyncMock.mockReset();
    realRmSync(targetDir, { recursive: true, force: true });
  });

  it("removes the just-written adoption-report.md (best effort) and propagates writeInventory's own failure unchanged, rather than leaving a report that implies a completed run", () => {
    const projectDir = join(targetDir, "project-write-inventory-fails");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const reportPath = join(projectDir, ".groundwork", "adoption-report.md");

    const writeFailure = new Error("simulated writeInventory failure");
    writeInventoryMock.mockImplementationOnce(() => {
      // The report has already been written by the time writeInventory runs
      // (main.ts writes it immediately before calling writeInventory) --
      // confirm that precondition before simulating the failure, so this
      // test can't pass by accident against a run that never got this far.
      expect(existsSync(reportPath)).toBe(true);
      throw writeFailure;
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    // writeInventory's own failure is now rethrown wrapped as
    // removedStaleFilesError (item 1): the original failure is chained as
    // `cause`, not surfaced bare.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(writeFailure);
    expect((thrown as Error).cause).toBe(writeFailure);
    expect((thrown as Error).message).toMatch(/re-run/);
    // Nothing under .groundwork/ pre-existed before this (first) run, so the
    // message must not claim adoption-decisions.json "was removed" -- there
    // was nothing to remove (item 6).
    expect((thrown as Error).message).not.toContain("adoption-decisions.json");
    expect(existsSync(reportPath)).toBe(false);
  });

  it("still propagates writeInventory's own failure, unmasked, when removing the report ALSO fails", () => {
    const projectDir = join(targetDir, "project-write-inventory-and-rm-fail");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const reportPath = join(projectDir, ".groundwork", "adoption-report.md");

    const writeFailure = new Error("simulated writeInventory failure");
    writeInventoryMock.mockImplementationOnce(() => {
      throw writeFailure;
    });
    const rmFailure = new Error("simulated rmSync failure removing report");
    // rmSync(reportPath) is also called up front, before this run's own
    // report ever exists (clearing a stale one from an earlier run) -- with
    // force:true that no-ops harmlessly against a missing file. Only the
    // SECOND call against reportPath -- the best-effort cleanup attempted
    // after writeInventory's failure above -- is made to fail here.
    let reportRmCalls = 0;
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) => {
      const [path] = args;
      if (path === reportPath) {
        reportRmCalls += 1;
        if (reportRmCalls > 1) {
          throw rmFailure;
        }
      }
      return realRmSync(...args);
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    // rmSync(reportPath) must have been called a SECOND time -- the
    // best-effort cleanup attempted after writeInventory's failure, on top
    // of the up-front stale-file clear every run already does. A main.ts
    // that never attempts this cleanup at all only ever calls it once and
    // would fail this specific assertion, discriminating the fix from a
    // trivial "an attempt was made at some point" check.
    expect(reportRmCalls).toBeGreaterThan(1);
    // The ORIGINAL writeInventory failure is still what's chained -- a
    // failed best-effort cleanup must never replace or mask it -- but it is
    // now wrapped as removedStaleFilesError (item 1), not surfaced bare.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(writeFailure);
    expect((thrown as Error).cause).toBe(writeFailure);
    expect((thrown as Error).message).toMatch(/re-run/);
  });

  it("still propagates writeInventory's own failure, unmasked, and still warns, when the report cleanup rmSync throws a non-Error value", () => {
    const projectDir = join(
      targetDir,
      "project-write-inventory-and-rm-nonerror",
    );
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const reportPath = join(projectDir, ".groundwork", "adoption-report.md");

    const writeFailure = new Error("simulated writeInventory failure");
    writeInventoryMock.mockImplementationOnce(() => {
      throw writeFailure;
    });

    const nonErrorCleanupFailure = "simulated-non-error-rm-failure";
    // Same discrimination as the Error-cleanup-failure test above: only the
    // SECOND rmSync(reportPath) call -- the best-effort cleanup attempted
    // after writeInventory's failure -- is made to fail, and this time with
    // a non-Error value, to exercise the `String(cleanupError)` fallback a
    // bare `cleanupError.message` read would silently turn into the literal
    // text "undefined" for.
    let reportRmCalls = 0;
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) => {
      const [path] = args;
      if (path === reportPath) {
        reportRmCalls += 1;
        if (reportRmCalls > 1) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to exercise the String(cleanupError) fallback the warning message uses
          throw nonErrorCleanupFailure;
        }
      }
      return realRmSync(...args);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    // Assert on the spy's recorded calls BEFORE restoring it --
    // mockRestore() also resets call history (it composes mockReset()), so
    // restoring first would silently empty warnSpy.mock.calls and make the
    // "was it called" assertions below pass vacuously against an empty array.
    expect(reportRmCalls).toBeGreaterThan(1);
    // The ORIGINAL writeInventory failure is still what's chained, not the
    // non-Error cleanup failure -- wrapped as removedStaleFilesError (item 1).
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(writeFailure);
    expect((thrown as Error).cause).toBe(writeFailure);
    expect(warnSpy).toHaveBeenCalled();
    const sawCleanupWarning = warnSpy.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" && arg.includes(nonErrorCleanupFailure),
      ),
    );
    expect(sawCleanupWarning).toBe(true);
    warnSpy.mockRestore();
  });

  it("propagates an AssertionError thrown by writeInventory itself UNWRAPPED (never happens in practice, but the passthrough must still hold)", () => {
    const projectDir = join(targetDir, "project-write-inventory-assertion");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );

    const assertionFailure = new assert.AssertionError({
      message: "simulated broken invariant inside writeInventory",
    });
    writeInventoryMock.mockImplementationOnce(() => {
      throw assertionFailure;
    });

    let thrown: unknown;
    try {
      main([projectDir]);
    } catch (error) {
      thrown = error;
    }

    // A broken invariant is a bug, not something removedStaleFilesError's
    // "fix the cause and re-run" wrapping would help with -- it propagates
    // as the exact same instance, never wrapped.
    expect(thrown).toBe(assertionFailure);
  });
});
