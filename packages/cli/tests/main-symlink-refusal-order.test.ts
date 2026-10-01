// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt`'s symlink refusal order (round-3 item 1): `.groundwork`,
 * `.groundwork/packs`, AND `.groundwork/baseline` must each be checked not
 * to be a symlink BEFORE any of the three stale `.groundwork/` files
 * (`inventory.json`, `adoption-report.md`, `adoption-decisions.json`) are
 * deleted and before either stager swaps anything into place. A symlinked
 * staging directory would otherwise redirect a recursive delete or a write
 * outside the adopted project. Before this fix, only `groundworkDir` itself
 * was checked up front -- a symlinked `.groundwork/baseline` or
 * `.groundwork/packs` was only caught later, by the stager's OWN
 * `prepareStaging` call, by which point the three stale files were already
 * deleted (see each `it.each` case below, which proves exactly that
 * regression).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const { main } = await import("../src/main.js");

/** Every file under `root`, relative to it (posix separators), sorted. */
function listFiles(root: string): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      results.push(absPath.slice(root.length).replaceAll("\\", "/"));
    }
  };
  if (existsSync(root)) {
    visit(root);
  }
  return results.sort();
}

describe("runAdopt symlink refusal order (round-3 item 1)", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "symlink-order-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it.each([
    ["baseline", "packs"],
    ["packs", "baseline"],
  ] as const)(
    "refuses a symlinked .groundwork/%s before deleting anything, naming the symlink, and leaves inventory.json/adoption-report.md/adoption-decisions.json AND the sibling .groundwork/%s byte-for-byte intact",
    (symlinked, sibling) => {
      const projectDir = join(targetDir, `project-${symlinked}`);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "acme", type: "module" }),
      );

      // A clean run first, to get a real baseline/ and packs/ staging plus a
      // real inventory.json/adoption-report.md on disk.
      main([projectDir]);

      const groundworkDir = join(projectDir, ".groundwork");
      const inventoryPath = join(groundworkDir, "inventory.json");
      const reportPath = join(groundworkDir, "adoption-report.md");
      const decisionsPath = join(groundworkDir, "adoption-decisions.json");

      const siblingDir = join(groundworkDir, sibling);
      const siblingBefore = listFiles(siblingDir);
      expect(siblingBefore.length).toBeGreaterThan(0);

      // Replace .groundwork/<symlinked> with a symlink to an unrelated
      // outside directory.
      const outsideDir = mkdtempSync(
        join(tmpdir(), `symlink-order-outside-${symlinked}-`),
      );
      const symlinkedDir = join(groundworkDir, symlinked);
      rmSync(symlinkedDir, { recursive: true, force: true });
      symlinkSync(outsideDir, symlinkedDir, "dir");

      // Marker content in all three CLI-owned files -- including
      // adoption-decisions.json, which a real run never recreates on its
      // own, so byte-identical survival here proves it was never touched
      // either.
      writeFileSync(inventoryPath, "MARKER-INVENTORY\n");
      writeFileSync(reportPath, "MARKER-REPORT\n");
      writeFileSync(decisionsPath, "MARKER-DECISIONS\n");

      let thrown: unknown;
      try {
        main([projectDir]);
      } catch (error) {
        thrown = error;
      }
      const outsideContents = existsSync(outsideDir)
        ? readdirSync(outsideDir)
        : [];
      rmSync(outsideDir, { recursive: true, force: true });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/symlink/);
      expect((thrown as Error).message).toContain(symlinkedDir);

      // Nothing was deleted: all three marker files survive byte-identical.
      expect(readFileSync(inventoryPath, "utf8")).toBe("MARKER-INVENTORY\n");
      expect(readFileSync(reportPath, "utf8")).toBe("MARKER-REPORT\n");
      expect(readFileSync(decisionsPath, "utf8")).toBe("MARKER-DECISIONS\n");

      // The sibling staging directory (the one NOT symlinked) is untouched.
      expect(listFiles(siblingDir)).toEqual(siblingBefore);

      // Nothing was ever written through the symlink (only "sentinel-free"
      // emptiness is asserted here -- the symlink's own target directory
      // never received a staged file).
      expect(outsideContents).toEqual([]);

      // The symlink itself was never replaced by anything real.
      expect(lstatSync(symlinkedDir).isSymbolicLink()).toBe(true);
    },
  );
});
