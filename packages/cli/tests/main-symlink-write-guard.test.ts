// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * GAP 1, main()-level: fresh mode's `runFresh` (`../src/main.js`) writes the
 * baseline (`emitTemplate`) and any `--pack` payload (`installPack`, itself
 * `emitTemplate` over the pack's `files/`) with no symlink/non-directory
 * preflight at all today. New contract: before the first byte of either the
 * baseline OR a requested pack is written, every destination path either
 * would touch is validated, and the whole run is refused -- naming the
 * offending path, nothing written -- when one is a symlink or a
 * non-directory where a directory is needed.
 *
 * `git.js` and `plugin.js` are mocked the same way `main-run.test.ts` mocks
 * them, so this exercises the real `emitTemplate`/`installPack` against a
 * real temp directory without spawning real git/pnpm or touching the
 * `/customize` skill install.
 *
 * The existing "target exists and is not empty" gate (`isEmptyOrMissing`)
 * runs BEFORE this new guard and is unaffected by it: a target that already
 * contains a symlinked entry is non-empty, so `--force` is required to reach
 * the new guard at all. Both arms of that precedence are exercised below
 * (`test.each`'s `withForce` axis) per `.claude/rules/tests.md`'s "every arm
 * reachable" rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallPluginResult } from "../src/plugin.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn((): InstallPluginResult => ({
  filesWritten: [],
}));
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

/** Every message in `thrown`'s own `cause` chain, outermost first, as long as each link is itself an `Error`. */
function errorChainMessages(thrown: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/**
 * Asserts `thrown` is an `Error` naming a refusal at exactly
 * `offendingPath`, carrying fresh mode's ONE consistent retry instruction
 * (the `--fresh --force` marker, exactly once across the whole chain) and
 * never adopt mode's bare "re-run the CLI" -- mirrors
 * `emit-symlink-guard.test.ts`'s and `plugin-symlink.test.ts`'s convention.
 */
function expectFreshModeRefusal(thrown: unknown, offendingPath: string): void {
  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toContain(offendingPath);

  const chain = errorChainMessages(thrown);
  const occurrences = chain.reduce(
    (total, chainMessage) =>
      total + (chainMessage.match(/--fresh --force/g)?.length ?? 0),
    0,
  );
  expect(occurrences).toBe(1);
  for (const chainMessage of chain) {
    expect(chainMessage).not.toMatch(/\bre-run the CLI\b/);
  }
}

describe("main() fresh mode: symlink/non-directory preflight (GAP 1)", () => {
  let targetDir: string;
  let outsideDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-symlink-guard-"));
    outsideDir = mkdtempSync(join(tmpdir(), "main-symlink-guard-outside-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  describe("a non-empty target whose single entry is a symlinked directory component (.claude)", () => {
    function plantClaudeSymlink(): string {
      writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch\n");
      const symlinkPath = join(targetDir, ".claude");
      symlinkSync(outsideDir, symlinkPath, "dir");
      return symlinkPath;
    }

    it("without --force: the pre-existing 'already exists and is not empty' gate fires first, leaving the symlink and sentinel untouched", () => {
      const symlinkPath = plantClaudeSymlink();

      expect(() => main([targetDir])).toThrow(
        /already exists and is not empty/,
      );

      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
        "do not touch\n",
      );
      expect(readdirSync(outsideDir)).toEqual(["sentinel.txt"]);
      expect(gitInitMock).not.toHaveBeenCalled();
    });

    it("with --force: refuses with the new symlink guard, writing no baseline file and leaving the symlink and sentinel untouched", () => {
      const symlinkPath = plantClaudeSymlink();

      let thrown: unknown;
      try {
        main([targetDir, "--force", "--skip-install"]);
      } catch (error) {
        thrown = error;
      }

      expectFreshModeRefusal(thrown, symlinkPath);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
        "do not touch\n",
      );
      expect(readdirSync(outsideDir)).toEqual(["sentinel.txt"]);
      expect(existsSync(join(targetDir, "package.json"))).toBe(false);
      expect(gitInitMock).not.toHaveBeenCalled();
      expect(runInstallMock).not.toHaveBeenCalled();
    });
  });

  describe("a non-empty target whose single entry is a symlinked destination FILE (package.json)", () => {
    function plantPackageJsonSymlink(): string {
      const outsideFile = join(outsideDir, "sentinel-package.json");
      writeFileSync(outsideFile, "SENTINEL - do not touch\n");
      const symlinkPath = join(targetDir, "package.json");
      symlinkSync(outsideFile, symlinkPath);
      return symlinkPath;
    }

    it("without --force: the pre-existing 'already exists and is not empty' gate fires first, leaving the symlink and sentinel untouched", () => {
      const symlinkPath = plantPackageJsonSymlink();

      expect(() => main([targetDir])).toThrow(
        /already exists and is not empty/,
      );

      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(
        readFileSync(join(outsideDir, "sentinel-package.json"), "utf8"),
      ).toBe("SENTINEL - do not touch\n");
    });

    it("with --force: refuses with the new symlink guard instead of writing the baseline package.json through the symlink", () => {
      const symlinkPath = plantPackageJsonSymlink();

      let thrown: unknown;
      try {
        main([targetDir, "--force", "--skip-install"]);
      } catch (error) {
        thrown = error;
      }

      expectFreshModeRefusal(thrown, symlinkPath);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(
        readFileSync(join(outsideDir, "sentinel-package.json"), "utf8"),
      ).toBe("SENTINEL - do not touch\n");
      expect(gitInitMock).not.toHaveBeenCalled();
    });
  });

  describe("a --pack payload path crossing a symlinked directory the baseline also writes into", () => {
    it("refuses before writing anything -- neither the baseline nor the pack's own files, when .claude/hooks is a symlink", () => {
      writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch\n");
      mkdirSync(join(targetDir, ".claude"), { recursive: true });
      const symlinkPath = join(targetDir, ".claude", "hooks");
      symlinkSync(outsideDir, symlinkPath, "dir");

      let thrown: unknown;
      try {
        main([
          targetDir,
          "--force",
          "--skip-install",
          "--pack",
          "harness-extras",
        ]);
      } catch (error) {
        thrown = error;
      }

      expectFreshModeRefusal(thrown, symlinkPath);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readdirSync(outsideDir)).toEqual(["sentinel.txt"]);
      // Neither the baseline's own root-level package.json nor any of the
      // pack's hook files were written -- the whole run (baseline AND pack)
      // is validated before the first write.
      expect(existsSync(join(targetDir, "package.json"))).toBe(false);
      expect(gitInitMock).not.toHaveBeenCalled();
    });
  });

  it("does not guard targetDir itself: a symlinked target directory still bootstraps successfully, writing through to its real location", () => {
    const realTarget = mkdtempSync(
      join(tmpdir(), "main-symlink-guard-real-target-"),
    );
    const symlinkedTarget = join(targetDir, "project-link");
    symlinkSync(realTarget, symlinkedTarget, "dir");

    try {
      main([symlinkedTarget, "--skip-install"]);

      expect(existsSync(join(realTarget, "package.json"))).toBe(true);
      expect(gitInitMock).toHaveBeenCalledWith(symlinkedTarget);
    } finally {
      rmSync(realTarget, { recursive: true, force: true });
    }
  });
});
