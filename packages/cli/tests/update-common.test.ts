// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUpdatableOrigin,
  assertUpdateTarget,
  escapeInline,
  formatUpdateCounts,
  installedCoreDir,
  isUpdateAvailable,
  ledgerPackVersions,
  messageOf,
  requireTemplateHistory,
  updateOrigin,
} from "../src/update-common.js";
import { buildLock, LOCK_FILE, serializeLock } from "../src/lock.js";
import { CliUsageError } from "../src/usage.js";
import type { UpdateAction } from "../src/update-classify.js";
import { writeTree } from "./update-base-fixtures.js";
import { bootstrapFresh, readLockOrThrow } from "./update-classify-fixtures.js";

let root: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "update-common-"));
  project = join(root, "project");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("escapeInline and messageOf", () => {
  it("escapes newlines and control characters onto one line", () => {
    expect(escapeInline("a\nb")).toBe("a\\nb");
    expect(escapeInline("a\u001bb")).not.toContain("\u001b");
  });

  it("takes an Error's message and stringifies anything else", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf(42)).toBe("42");
  });
});

describe("assertUpdateTarget", () => {
  it("accepts an existing directory", () => {
    mkdirSync(project);
    expect(() => {
      assertUpdateTarget(project, "--update", "a project");
    }).not.toThrow();
  });

  it("refuses an absent target naming the flag and the need", () => {
    expect(() => {
      assertUpdateTarget(project, "--update", "a project to stage for");
    }).toThrowError(/not an existing directory -- --update needs a project/);
  });

  it("refuses a file target", () => {
    writeTree(root, { file: "x" });
    expect(() => {
      assertUpdateTarget(join(root, "file"), "--update", "a project");
    }).toThrowError(CliUsageError);
  });

  it("refuses a target that cannot be inspected, chaining the cause", () => {
    symlinkSync(join(root, "loop"), join(root, "loop"));
    let thrown: unknown;
    try {
      assertUpdateTarget(join(root, "loop"), "--check-update", "a project");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliUsageError);
    expect((thrown as CliUsageError).message).toContain("could not be checked");
    expect((thrown as CliUsageError).cause).toBeInstanceOf(Error);
  });
});

describe("assertUpdatableOrigin", () => {
  it("accepts a bootstrapped project", () => {
    bootstrapFresh(project);
    expect(() => {
      assertUpdatableOrigin(project);
    }).not.toThrow();
  });

  it("accepts an adopted project", () => {
    writeTree(project, {
      ".groundwork/inventory.json": JSON.stringify({ schemaVersion: 1 }),
    });
    expect(() => {
      assertUpdatableOrigin(project);
    }).not.toThrow();
  });

  it("accepts an unmarked project that has a lock", () => {
    writeTree(project, {
      [LOCK_FILE]: serializeLock(
        buildLock({
          baseVersion: "1.0.0",
          origin: "fresh",
          tokens: { PROJECT_NAME: "acme" },
          via: "fresh",
          updatedAt: "2026-01-01T00:00:00.000Z",
          skip: [],
          files: [],
        }),
      ),
    });
    expect(() => {
      assertUpdatableOrigin(project);
    }).not.toThrow();
  });

  it("refuses an interrupted adopt and says to re-run adopt", () => {
    writeTree(project, { ".groundwork/adoption-report.md": "partial" });
    expect(() => {
      assertUpdatableOrigin(project);
    }).toThrowError(/did not finish -- re-run adopt/);
  });

  it("refuses an unknown origin with no lock", () => {
    writeTree(project, { "readme.txt": "hi" });
    expect(() => {
      assertUpdatableOrigin(project);
    }).toThrowError(/no release to compare against/);
  });
});

describe("installedCoreDir", () => {
  it("returns the readable templates/core directory", () => {
    expect(installedCoreDir("cannot check")).toMatch(/templates[\\/]core$/);
  });
});

describe("requireTemplateHistory", () => {
  it("returns an injected history unchanged", () => {
    const injected = {
      history: { schemaVersion: 1 as const, versions: {}, blobs: {} },
    };
    expect(requireTemplateHistory(injected, "x")).toBe(injected);
  });

  it("loads the shipped history when none is injected", () => {
    expect(requireTemplateHistory(undefined, "x").history.schemaVersion).toBe(
      1,
    );
  });

  it("throws a plain Error naming the damage for a note", () => {
    let thrown: unknown;
    try {
      requireTemplateHistory({ note: "history is corrupt" }, "cannot stage");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect((thrown as Error).message).toMatch(
      /^cannot stage: history is corrupt -- .*reinstall/,
    );
  });
});

describe("updateOrigin", () => {
  it("follows the lock when there is one", () => {
    const lock = bootstrapFresh(project);
    expect(updateOrigin(project, lock)).toBe("fresh");
    expect(updateOrigin(project, { ...lock, origin: "adopt" })).toBe("adopted");
  });

  it("falls back to the markers: bootstrapped is fresh", () => {
    bootstrapFresh(project);
    expect(readLockOrThrow(project).origin).toBe("fresh");
    expect(updateOrigin(project, undefined)).toBe("fresh");
  });

  it("is unknown for an interrupted adopt and for an unmarked project", () => {
    writeTree(project, { ".groundwork/adoption-report.md": "partial" });
    expect(updateOrigin(project, undefined)).toBe("unknown");
    const other = join(root, "other");
    writeTree(other, { "readme.txt": "hi" });
    expect(updateOrigin(other, undefined)).toBe("unknown");
  });

  it("is adopted for a project with a valid adopt inventory", () => {
    writeTree(project, {
      ".groundwork/inventory.json": JSON.stringify({ schemaVersion: 1 }),
    });
    expect(updateOrigin(project, undefined)).toBe("adopted");
  });
});

describe("ledgerPackVersions", () => {
  it("keeps only the entries that record a cliVersion", () => {
    expect(
      ledgerPackVersions([
        { name: "quality", cliVersion: "1.4.0" },
        { name: "legacy" },
      ]),
    ).toEqual({ quality: "1.4.0" });
  });
});

describe("formatUpdateCounts and isUpdateAvailable", () => {
  const zero: Record<UpdateAction, number> = {
    take: 0,
    merge: 0,
    conflict: 0,
    review: 0,
    add: 0,
    delete: 0,
    rename: 0,
    keep: 0,
    current: 0,
    skip: 0,
  };

  it("words the non-zero counts in a fixed order", () => {
    expect(
      formatUpdateCounts({ ...zero, add: 1, take: 3, conflict: 2 }),
    ).toEqual(["3 update cleanly", "2 conflict", "1 new"]);
    expect(formatUpdateCounts(zero)).toEqual([]);
  });

  it("is available for an outdated pack or any actionable entry only", () => {
    expect(isUpdateAvailable([], 0)).toBe(false);
    expect(isUpdateAvailable([{ action: "keep" }], 0)).toBe(false);
    expect(isUpdateAvailable([{ action: "keep" }], 1)).toBe(true);
    expect(isUpdateAvailable([{ action: "delete" }], 0)).toBe(true);
  });
});
