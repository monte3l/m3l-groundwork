// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `fetchBase`'s temp-directory failure branches: `mkdtempSync` failing, and
 * `rmSync` failing on cleanup. `node:fs` is mocked (importOriginal-preserving)
 * in this file ONLY, as `inventory-write-failure.test.ts` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsModule from "node:fs";
import { rmSync as realRmSync } from "node:fs";
import { fetchBase } from "../src/fetch-base.js";
import { CliUsageError } from "../src/usage.js";
import { buildTgz, fakeNpmPack, packageFiles } from "./tarball-fixtures.js";

const { mkdtempSyncMock, rmSyncMock } = vi.hoisted(() => ({
  mkdtempSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  mkdtempSyncMock.mockImplementation(actual.mkdtempSync);
  return { ...actual, mkdtempSync: mkdtempSyncMock, rmSync: rmSyncMock };
});

const TGZ = buildTgz(packageFiles({ "templates/core/package.json": "{}" }));

const created: string[] = [];

beforeEach(() => {
  rmSyncMock.mockImplementation(realRmSync);
});

afterEach(async () => {
  const actual = await vi.importActual<typeof FsModule>("node:fs");
  mkdtempSyncMock.mockReset();
  mkdtempSyncMock.mockImplementation(actual.mkdtempSync);
  rmSyncMock.mockReset();
  for (const dir of created.splice(0)) {
    realRmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** Records every directory `mkdtempSync` creates, for cleanup and naming. */
function trackTempDirs(): void {
  const original = mkdtempSyncMock.getMockImplementation();
  mkdtempSyncMock.mockImplementation((...args: unknown[]) => {
    const dir = (original as (...a: unknown[]) => string)(...args);
    created.push(dir);
    return dir;
  });
}

function failure(attempt: () => unknown): unknown {
  try {
    attempt();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("fetchBase: mkdtempSync failure", () => {
  it("surfaces as a CliUsageError naming --fetch-base and --base-version", () => {
    const cause = new Error("EACCES: permission denied");
    mkdtempSyncMock.mockImplementation(() => {
      throw cause;
    });
    const runNpm = vi.fn(fakeNpmPack(TGZ));
    const error = failure(() => fetchBase({ version: "1.0.0", runNpm }));
    expect(error).toBeInstanceOf(CliUsageError);
    const message = (error as CliUsageError).message;
    expect(message).toContain("--fetch-base");
    expect(message).toContain("--base-version");
    expect(runNpm).not.toHaveBeenCalled();
  });
});

describe("fetchBase: a failed temp-directory cleanup", () => {
  it("warns on stderr naming the leftover directory and still returns the result", () => {
    trackTempDirs();
    rmSyncMock.mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = fetchBase({ version: "1.0.0", runNpm: fakeNpmPack(TGZ) });
    expect(base.version).toBe("1.0.0");
    expect(created).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(created[0]);
  });

  it("warns and still throws the original error on the failure path", () => {
    trackTempDirs();
    rmSyncMock.mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runNpm = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "npm error network",
    }));
    const error = failure(() => fetchBase({ version: "1.0.0", runNpm }));
    expect(error).toBeInstanceOf(CliUsageError);
    expect((error as CliUsageError).message).toContain(
      "npm pack exited with 1",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(created[0]);
  });
});
