/**
 * Covers main()'s own body (parseArgs and templatesCoreDir are covered
 * separately in main.test.ts). git.js and plugin.js are mocked so this
 * exercises real emitTemplate()/surveyProject()/planConflicts() against a
 * real temp directory without spawning real git/pnpm processes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Inventory } from "../src/inventory.js";

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

const { main, CliUsageError } = await import("../src/main.js");

describe("main", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-run-"));
    gitInitMock.mockClear();
    runInstallMock.mockClear();
    installCustomizeSkillMock.mockClear();
    installCustomizeSkillGuardedMock.mockClear();
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  describe("fresh mode", () => {
    it("emits the template, installs the skill, inits git, and installs deps by default", () => {
      // main() targets an empty subdirectory it creates itself.
      const emptyTarget = join(targetDir, "sub");

      main([emptyTarget, "--name", "widgets"]);

      expect(existsSync(join(emptyTarget, "package.json"))).toBe(true);
      expect(installCustomizeSkillMock).toHaveBeenCalledWith(emptyTarget);
      expect(gitInitMock).toHaveBeenCalledWith(emptyTarget);
      expect(runInstallMock).toHaveBeenCalledWith(emptyTarget);
    });

    it("skips the install step when --skip-install is passed", () => {
      const emptyTarget = join(targetDir, "sub2");

      main([emptyTarget, "--skip-install"]);

      expect(gitInitMock).toHaveBeenCalledWith(emptyTarget);
      expect(runInstallMock).not.toHaveBeenCalled();
    });

    it("throws rather than overwrite a non-empty directory without --force", () => {
      mkdirSync(join(targetDir, "occupied"));
      writeFileSync(join(targetDir, "occupied", "existing.txt"), "hi");

      expect(() => main([join(targetDir, "occupied")])).toThrow(
        /already exists and is not empty/,
      );
      expect(gitInitMock).not.toHaveBeenCalled();
    });

    it("proceeds into a non-empty directory when --force is passed", () => {
      mkdirSync(join(targetDir, "occupied2"));
      writeFileSync(join(targetDir, "occupied2", "existing.txt"), "hi");

      main([join(targetDir, "occupied2"), "--skip-install", "--force"]);

      expect(gitInitMock).toHaveBeenCalled();
    });

    it("forces fresh mode even on a directory with a package.json, via --fresh", () => {
      const freshForced = join(targetDir, "sub3");
      mkdirSync(freshForced);
      writeFileSync(join(freshForced, "package.json"), "{}");

      main([freshForced, "--skip-install", "--force", "--fresh"]);

      expect(gitInitMock).toHaveBeenCalled();
      expect(installCustomizeSkillGuardedMock).not.toHaveBeenCalled();
    });

    it("installs a requested pack alongside the baseline", () => {
      const packTarget = join(targetDir, "sub-pack");

      main([packTarget, "--skip-install", "--pack", "harness-extras"]);

      expect(
        existsSync(
          join(packTarget, ".claude", "hooks", "guard-readonly-bash.mjs"),
        ),
      ).toBe(true);
      expect(existsSync(join(packTarget, "bin", "check-file-budget.mjs"))).toBe(
        true,
      );
      const steps = JSON.parse(
        readFileSync(
          join(packTarget, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as unknown[];
      expect(steps).toHaveLength(1);
    });

    it("prints a caps summary when a pack is installed", () => {
      const packTarget = join(targetDir, "sub-pack-summary");
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      main([packTarget, "--skip-install", "--pack", "harness-extras"]);

      expect(
        logSpy.mock.calls.some(
          ([line]) =>
            typeof line === "string" && line.includes("templates/core:"),
        ),
      ).toBe(true);
      logSpy.mockRestore();
    });

    it("throws naming the available packs when an unknown pack is requested", () => {
      const packTarget = join(targetDir, "sub-pack-unknown");

      expect(() =>
        main([packTarget, "--skip-install", "--pack", "does-not-exist"]),
      ).toThrow(/unknown pack "does-not-exist"/);
    });
  });

  describe("adopt mode", () => {
    it("auto-detects adopt for a directory containing package.json and writes .groundwork/ only", () => {
      const projectDir = join(targetDir, "existing-project");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );

      main([projectDir]);

      expect(
        existsSync(join(projectDir, ".groundwork", "inventory.json")),
      ).toBe(true);
      expect(
        existsSync(join(projectDir, ".groundwork", "adoption-report.md")),
      ).toBe(true);
      const inventory = JSON.parse(
        readFileSync(join(projectDir, ".groundwork", "inventory.json"), "utf8"),
      ) as Inventory;
      expect(inventory.modeSignal).toBe("found package.json");

      // Nothing outside .groundwork/ was written -- no git init, no install,
      // and the guarded (not the unguarded) skill installer was used.
      expect(gitInitMock).not.toHaveBeenCalled();
      expect(runInstallMock).not.toHaveBeenCalled();
      expect(installCustomizeSkillMock).not.toHaveBeenCalled();
      expect(installCustomizeSkillGuardedMock).toHaveBeenCalledWith(projectDir);
    });

    it("forces adopt mode via --adopt even on an empty directory", () => {
      const emptyTarget = join(targetDir, "forced-adopt");
      mkdirSync(emptyTarget);

      main([emptyTarget, "--adopt"]);

      expect(
        existsSync(join(emptyTarget, ".groundwork", "inventory.json")),
      ).toBe(true);
      expect(gitInitMock).not.toHaveBeenCalled();
    });

    it("rejects --force in adopt mode rather than writing anything", () => {
      const projectDir = join(targetDir, "existing-project2");
      mkdirSync(projectDir);
      writeFileSync(join(projectDir, "package.json"), "{}");

      expect(() => main([projectDir, "--force"])).toThrow(
        /no effect in adopt mode/,
      );
      expect(existsSync(join(projectDir, ".groundwork"))).toBe(false);
    });

    // Contract 1: --force in adopt mode is a usage error (exit 2), not a
    // plain runtime Error (exit 1) -- it is a contradictory flag/mode
    // combination knowable from argv alone, once mode is resolved, the same
    // class of mistake --adopt+--fresh already is.
    it("rejects --force in adopt mode with CliUsageError, not a plain Error", () => {
      const projectDir = join(targetDir, "existing-project2-usage");
      mkdirSync(projectDir);
      writeFileSync(join(projectDir, "package.json"), "{}");

      expect(() => main([projectDir, "--force"])).toThrow(CliUsageError);
      expect(() => main([projectDir, "--force"])).toThrow(
        /--force has no effect in adopt mode/,
      );
      expect(existsSync(join(projectDir, ".groundwork"))).toBe(false);
    });

    it("surveys every pack and stages it, unapplied, when no --pack is given", () => {
      const projectDir = join(targetDir, "existing-project3");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );

      main([projectDir]);

      const inventory = JSON.parse(
        readFileSync(join(projectDir, ".groundwork", "inventory.json"), "utf8"),
      ) as Inventory;
      expect(inventory.packs.some((p) => p.name === "harness-extras")).toBe(
        true,
      );

      // Staged, not installed: the payload lives under .groundwork/packs/,
      // and the project's own .claude/ tree was never created.
      expect(
        existsSync(
          join(
            projectDir,
            ".groundwork",
            "packs",
            "harness-extras",
            "files",
            ".claude",
            "hooks",
            "guard-readonly-bash.mjs",
          ),
        ),
      ).toBe(true);
      expect(existsSync(join(projectDir, ".claude"))).toBe(false);
    });

    // Contract 1: --pack in adopt mode is rejected up front as a usage
    // error, rather than silently ignored while the survey proceeds to
    // stage every pack regardless (the OLD contract, dropped by this fix --
    // see the previous test for its replacement covering the no--pack
    // case).
    it("rejects --pack in adopt mode as a usage error, rather than silently ignoring it", () => {
      const projectDir = join(targetDir, "existing-project3-pack-usage");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );

      expect(() => main([projectDir, "--pack", "harness-extras"])).toThrow(
        CliUsageError,
      );
      expect(() => main([projectDir, "--pack", "harness-extras"])).toThrow(
        /no effect in adopt mode/,
      );
      expect(existsSync(join(projectDir, ".groundwork"))).toBe(false);
    });

    // Contract 2: --adopt against a target directory that does not exist
    // yet is a clean usage error, not an uncaught filesystem exception --
    // resolveMode checks existence before forcing adopt, so a missing
    // target never reaches surveyProject's readdirSync call.
    it("rejects --adopt against a nonexistent target directory as a usage error, not a raw filesystem exception", () => {
      const missing = join(targetDir, "does-not-exist-yet");

      expect(() => main([missing, "--adopt"])).toThrow(CliUsageError);
      expect(() => main([missing, "--adopt"])).toThrow(
        /does not exist -- --adopt needs an existing project to survey/,
      );
      expect(existsSync(missing)).toBe(false);
    });
  });

  describe("--help / --version", () => {
    it("prints usage and returns for --help without requiring a target directory", () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      main(["--help"]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/usage: m3l-groundwork/),
      );
      logSpy.mockRestore();
    });

    it("prints a version string and returns for --version", () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      main(["--version"]);
      // Not a plain X.Y.Z: this project is in Changesets prerelease mode
      // (.changeset/pre.json), so the real version is X.Y.Z-next.N most of
      // the time -- see resolveCliVersion's own test in inventory.test.ts.
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/),
      );
      logSpy.mockRestore();
    });
  });

  describe("--list-packs", () => {
    it("prints every available pack without requiring a target directory", () => {
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      main(["--list-packs"]);
      expect(
        logSpy.mock.calls.some(
          ([line]) =>
            typeof line === "string" && line.includes("harness-extras"),
        ),
      ).toBe(true);
      logSpy.mockRestore();
    });
  });
});
