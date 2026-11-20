// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `FileConflict.targetSha256` (inventory schema 7): the lowercase-hex sha256 of
 * the project file's bytes exactly as `planConflicts` read them for the
 * comparison -- read ONCE, so the hash can never describe different bytes
 * than the verdict -- and `null` whenever there is no such read (absent,
 * blocked, unresolvable or unreadable).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) =>
      readFileSyncMock(...args) as ReturnType<
        typeof actual.readFileSync
      >) as typeof actual.readFileSync,
  };
});

const { planConflicts } = await import("../src/conflicts.js");

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("planConflicts -- targetSha256", () => {
  let templateRoot: string;
  let targetDir: string;
  let realReadFileSync: typeof FsModule.readFileSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");
    realReadFileSync = actual.readFileSync;
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realReadFileSync>) =>
        realReadFileSync(...args),
    );
    templateRoot = mkdtempSync(join(tmpdir(), "conflicts-sha-template-"));
    targetDir = mkdtempSync(join(tmpdir(), "conflicts-sha-target-"));
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  function targetReads(): number {
    return readFileSyncMock.mock.calls.filter(
      ([path]) => String(path) === join(targetDir, "README.md"),
    ).length;
  }

  it("is the lowercase hex sha256 of the project file's bytes for a whole-file identical result", () => {
    writeFileSync(join(templateRoot, "README.md"), "# __PROJECT_NAME__\n");
    writeFileSync(join(targetDir, "README.md"), "# acme\n");
    const [conflict] = planConflicts(templateRoot, targetDir, {
      PROJECT_NAME: "acme",
    });
    expect(conflict?.status).toBe("identical");
    expect(conflict?.targetSha256).toBe(sha256Hex("# acme\n"));
    expect(conflict?.targetSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the sha256 of the PROJECT file (not the baseline) for a whole-file divergent result", () => {
    writeFileSync(join(templateRoot, "README.md"), "baseline\n");
    writeFileSync(join(targetDir, "README.md"), "mine\n");
    const [conflict] = planConflicts(templateRoot, targetDir, {});
    expect(conflict?.status).toBe("divergent");
    expect(conflict?.targetSha256).toBe(sha256Hex("mine\n"));
    expect(conflict?.targetSha256).not.toBe(sha256Hex("baseline\n"));
  });

  it("hashes the raw file bytes for a key-level JSON file whose formatting differs from the baseline", () => {
    writeFileSync(
      join(templateRoot, "package.json"),
      JSON.stringify({ name: "x", type: "module" }),
    );
    const projectBytes = '{\r\n  "name": "x",\r\n  "type": "commonjs"\r\n}\r\n';
    writeFileSync(join(targetDir, "package.json"), projectBytes);
    const [conflict] = planConflicts(templateRoot, targetDir, {});
    expect(conflict?.status).toBe("divergent");
    expect(conflict?.keyDiffs).toEqual(["type"]);
    expect(conflict?.targetSha256).toBe(sha256Hex(projectBytes));
  });

  it("hashes the raw bytes, not a decoded string, so a file with invalid UTF-8 gets the true digest", () => {
    writeFileSync(join(templateRoot, "README.md"), "baseline\n");
    const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
    writeFileSync(join(targetDir, "README.md"), bytes);
    const [conflict] = planConflicts(templateRoot, targetDir, {});
    expect(conflict?.targetSha256).toBe(sha256Hex(bytes));
  });

  it("reads the project file exactly once and hashes those same bytes, even if the file changes after that read", () => {
    writeFileSync(join(templateRoot, "README.md"), "baseline\n");
    writeFileSync(join(targetDir, "README.md"), "first\n");
    const target = join(targetDir, "README.md");
    readFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realReadFileSync>) => {
        const result = realReadFileSync(...args);
        if (String(args[0]) === target) {
          // Whatever the code reads from now on sees different bytes.
          writeFileSync(target, "second\n");
        }
        return result;
      },
    );
    const [conflict] = planConflicts(templateRoot, targetDir, {});
    expect(targetReads()).toBe(1);
    expect(conflict?.targetSha256).toBe(sha256Hex("first\n"));
  });

  it("is null for a file the target does not have", () => {
    writeFileSync(join(templateRoot, "README.md"), "baseline\n");
    const [conflict] = planConflicts(templateRoot, targetDir, {});
    expect(conflict?.status).toBe("absent");
    expect(conflict?.targetSha256).toBeNull();
  });

  it("is null when the project path is a directory where the baseline has a file (the read fails with EISDIR)", () => {
    writeFileSync(join(templateRoot, "README.md"), "baseline\n");
    mkdirSync(join(targetDir, "README.md"));
    const undetermined: string[] = [];
    const [conflict] = planConflicts(templateRoot, targetDir, {}, undetermined);
    expect(conflict?.status).toBe("divergent");
    expect(undetermined).toHaveLength(1);
    expect(conflict?.targetSha256).toBeNull();
  });

  it("is null for a dangling symlink at the target path (divergent, never hashed)", () => {
    writeFileSync(join(templateRoot, "README.md"), "baseline\n");
    symlinkSync(join(targetDir, "nowhere"), join(targetDir, "README.md"));
    const [conflict] = planConflicts(templateRoot, targetDir, {});
    expect(conflict?.status).toBe("divergent");
    expect(conflict?.targetSha256).toBeNull();
  });

  it("is null when a regular file sits where an ancestor directory should be (ENOTDIR, divergent)", () => {
    mkdirSync(join(templateRoot, "docs"));
    writeFileSync(join(templateRoot, "docs", "a.md"), "baseline\n");
    writeFileSync(join(targetDir, "docs"), "i am a file\n");
    const [conflict] = planConflicts(templateRoot, targetDir, {});
    expect(conflict?.status).toBe("divergent");
    expect(conflict?.targetSha256).toBeNull();
  });

  it("carries the field on every conflict in a mixed plan, in the same order as before", () => {
    writeFileSync(join(templateRoot, "a.md"), "a\n");
    writeFileSync(join(templateRoot, "b.md"), "b\n");
    writeFileSync(join(templateRoot, "c.md"), "c\n");
    writeFileSync(join(targetDir, "a.md"), "a\n");
    writeFileSync(join(targetDir, "b.md"), "other\n");
    const byPath = new Map(
      planConflicts(templateRoot, targetDir, {}).map((c) => [c.relPath, c]),
    );
    expect(byPath.get("a.md")?.targetSha256).toBe(sha256Hex("a\n"));
    expect(byPath.get("b.md")?.targetSha256).toBe(sha256Hex("other\n"));
    expect(byPath.get("c.md")?.targetSha256).toBeNull();
  });
});
