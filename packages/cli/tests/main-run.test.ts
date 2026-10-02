// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

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
  readdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Inventory } from "../src/inventory.js";
import type * as InventoryModule from "../src/inventory.js";
import type * as ReportModule from "../src/report.js";
import type { StagedPack, StagedPackFile } from "../src/pack-stage.js";
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

// Records the relative call order of renderReport (whose string result main()
// writes to adoption-report.md immediately after calling it) and
// writeInventory (which writes inventory.json itself, last) -- a proxy for
// the write-order contract (report before inventory) that doesn't require
// redefining a non-configurable node:fs ESM export.
const { writeOrderMock } = vi.hoisted(() => ({ writeOrderMock: vi.fn() }));

vi.mock("../src/report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ReportModule>();
  return {
    ...actual,
    renderReport: (...args: Parameters<typeof actual.renderReport>) => {
      writeOrderMock("report");
      return actual.renderReport(...args);
    },
  };
});
vi.mock("../src/inventory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof InventoryModule>();
  return {
    ...actual,
    writeInventory: (...args: Parameters<typeof actual.writeInventory>) => {
      writeOrderMock("inventory");
      return actual.writeInventory(...args);
    },
  };
});

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

    it("prints 'the /customize skill was already up to date' when installCustomizeSkill reports a no-op (filesWritten: [])", () => {
      const emptyTarget = join(targetDir, "sub-noop");
      installCustomizeSkillMock.mockReturnValueOnce({ filesWritten: [] });
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      main([emptyTarget, "--skip-install"]);

      expect(logSpy).toHaveBeenCalledWith(
        "the /customize skill was already up to date",
      );
      logSpy.mockRestore();
    });

    it("prints 'installed the /customize skill (N files)' when installCustomizeSkill actually wrote files", () => {
      const emptyTarget = join(targetDir, "sub-installed");
      installCustomizeSkillMock.mockReturnValueOnce({
        filesWritten: [
          join(".claude", "skills", "customize", "SKILL.md"),
          join(".claude", "skills", "customize", "kind-facet-map.ts"),
        ],
      });
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);

      main([emptyTarget, "--skip-install"]);

      expect(logSpy).toHaveBeenCalledWith(
        "installed the /customize skill (2 files)",
      );
      logSpy.mockRestore();
    });

    describe("fails early, before writing anything", () => {
      it.each([
        ["an unknown pack", "no-such-pack", /unknown pack "no-such-pack"/],
        [
          "the retired statusline pack",
          "statusline",
          /renamed to "harness-extras"/,
        ],
      ])(
        "rejects %s as a usage error and leaves the target untouched",
        (_l, pack, re) => {
          const target = join(targetDir, "never-written");

          expect(() => main([target, "--pack", pack])).toThrow(CliUsageError);
          expect(() => main([target, "--pack", pack])).toThrow(re);
          expect(existsSync(target)).toBe(false);
          expect(gitInitMock).not.toHaveBeenCalled();
        },
      );

      it("names the available packs when an unknown pack is requested", () => {
        const target = join(targetDir, "never-written-unknown");

        let thrown: unknown;
        try {
          main([target, "--pack", "no-such-pack"]);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(CliUsageError);
        expect((thrown as Error).message).toMatch(/available:/);
        expect((thrown as Error).message).toMatch(/harness-extras/);
      });

      it("leaves an existing empty target empty when a later --pack is bad", () => {
        const target = join(targetDir, "empty-existing");
        mkdirSync(target);

        expect(() =>
          main([target, "--pack", "harness-extras", "--pack", "nope"]),
        ).toThrow(CliUsageError);
        expect(readdirSync(target)).toEqual([]);
      });

      it("rejects Windows in fresh mode with a plain Error (exit 1), before writing anything", () => {
        const target = join(targetDir, "win");
        let thrown: unknown;
        try {
          main([target], "win32");
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(CliUsageError);
        expect((thrown as Error).message).toMatch(
          /Windows is not supported yet \(Linux and macOS only\)/,
        );
        expect(existsSync(target)).toBe(false);
      });

      it.each([["--help"], ["--version"], ["--list-packs"]])(
        "still allows %s on Windows",
        (flag) => {
          const log = vi.spyOn(console, "log").mockImplementation(() => {});
          try {
            expect(() => main([flag], "win32")).not.toThrow();
            expect(log).toHaveBeenCalled();
          } finally {
            log.mockRestore();
          }
        },
      );

      it("still allows adopt mode on Windows", () => {
        const projectDir = join(targetDir, "win-adopt");
        mkdirSync(projectDir);
        writeFileSync(
          join(projectDir, "package.json"),
          JSON.stringify({ name: "acme", type: "module" }),
        );

        main([projectDir], "win32");

        expect(
          existsSync(join(projectDir, ".groundwork", "inventory.json")),
        ).toBe(true);
      });
    });

    describe("when git init fails", () => {
      it("chains the cause and says the project was written and what to run", () => {
        const target = join(targetDir, "git-fails");
        const cause = new Error("git: command not found");
        gitInitMock.mockImplementationOnce(() => {
          throw cause;
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        let thrown: unknown;
        try {
          main([target]);
        } catch (error) {
          thrown = error;
        } finally {
          vi.restoreAllMocks();
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(CliUsageError);
        expect((thrown as Error).cause).toBe(cause);
        expect((thrown as Error).message).toMatch(/project was written/);
        expect((thrown as Error).message).toMatch(/git init/);
        expect(existsSync(join(target, "package.json"))).toBe(true);
        expect(runInstallMock).not.toHaveBeenCalled();
      });
    });

    describe("when the /customize skill install fails", () => {
      /**
       * [item 4] The re-run instruction must be concrete enough to actually
       * act on: name the exact flags to re-add (`--fresh --force`) and say
       * to keep the original invocation's own flags (`--name`/`--pack`/
       * `--skip-install`) rather than silently dropping them on the retry.
       * Shared by both tests below; the `--skip-install` wording itself
       * differs per test, see each.
       */
      function expectReRunGuidance(message: string): void {
        expect(message).toContain(
          "re-run with --fresh --force (plus your original --name/--pack/--skip-install)",
        );
        expect(message).toContain("a plain re-run adopts it");
      }

      it("without --skip-install: says pnpm install did not run, and how to re-run keeping the same flags, chaining the cause", () => {
        const target = join(targetDir, "skill-install-fails");
        const cause = new Error("simulated /customize skill install failure");
        installCustomizeSkillMock.mockImplementationOnce(() => {
          throw cause;
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        let thrown: unknown;
        try {
          main([target]);
        } catch (error) {
          thrown = error;
        } finally {
          vi.restoreAllMocks();
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(CliUsageError);
        expect((thrown as Error).cause).toBe(cause);
        const message = (thrown as Error).message;
        expect(message).toContain("was written to");
        expect(message).toContain(target);
        expect(message).toContain("git init");
        expect(message).toContain("pnpm install did not run");
        expectReRunGuidance(message);

        // The template itself was written; neither git nor the dependency
        // install ran.
        expect(existsSync(join(target, "package.json"))).toBe(true);
        expect(gitInitMock).not.toHaveBeenCalled();
        expect(runInstallMock).not.toHaveBeenCalled();
      });

      it("with --skip-install: does not claim pnpm install did not run (it was never going to), but still says how to re-run", () => {
        const target = join(targetDir, "skill-install-fails-skip-install");
        const cause = new Error("simulated /customize skill install failure");
        installCustomizeSkillMock.mockImplementationOnce(() => {
          throw cause;
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        let thrown: unknown;
        try {
          main([target, "--skip-install"]);
        } catch (error) {
          thrown = error;
        } finally {
          vi.restoreAllMocks();
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(CliUsageError);
        expect((thrown as Error).cause).toBe(cause);
        const message = (thrown as Error).message;
        expect(message).toContain("was written to");
        expect(message).toContain(target);
        expect(message).toContain("git init");
        // --skip-install means pnpm install was never going to run this
        // invocation at all -- the failure did not "skip" it, and must not
        // claim it did.
        expect(message).not.toContain("pnpm install did not run");
        expect(message.toLowerCase()).not.toMatch(
          /pnpm install (?:was )?skipped/,
        );
        expectReRunGuidance(message);

        expect(existsSync(join(target, "package.json"))).toBe(true);
        expect(gitInitMock).not.toHaveBeenCalled();
        expect(runInstallMock).not.toHaveBeenCalled();
      });
    });

    describe("when the dependency install fails", () => {
      function runFailing(
        target: string,
        failure: Error,
      ): { thrown: unknown; logs: string[]; errs: string[] } {
        runInstallMock.mockImplementationOnce(() => {
          throw failure;
        });
        const logs: string[] = [];
        const errs: string[] = [];
        vi.spyOn(console, "log").mockImplementation((m: unknown) => {
          logs.push(String(m));
        });
        vi.spyOn(console, "error").mockImplementation((m: unknown) => {
          errs.push(String(m));
        });
        let thrown: unknown;
        try {
          main([target]);
        } catch (error) {
          thrown = error;
        } finally {
          vi.restoreAllMocks();
        }
        return { thrown, logs, errs };
      }

      it("chains the cause, prints no ready banner, and gives one explanation via the thrown error", () => {
        const target = join(targetDir, "install-fails");
        const cause = Object.assign(new Error("Command failed: pnpm install"), {
          status: 1,
          signal: null,
        });
        const { thrown, logs, errs } = runFailing(target, cause);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(CliUsageError);
        expect((thrown as Error).cause).toBe(cause);
        const message = (thrown as Error).message;
        expect(message).toMatch(/exit status 1/);
        expect(message).toMatch(/project was written/);
        expect(message).toMatch(/run `pnpm install`/);
        expect(errs).toEqual([]);
        expect(logs.join("\n")).not.toMatch(/is ready at/);
        expect(logs.join("\n")).toMatch(
          /written to .*but dependencies are not installed/,
        );
        expect(existsSync(join(target, "package.json"))).toBe(true);
      });

      it("reports the spawn code or signal when there is no exit status", () => {
        const { thrown } = runFailing(
          join(targetDir, "killed"),
          Object.assign(new Error("x"), { signal: "SIGKILL" }),
        );
        expect((thrown as Error).message).toMatch(/signal SIGKILL/);

        const { thrown: t2 } = runFailing(
          join(targetDir, "eacces"),
          Object.assign(new Error("x"), { code: "EACCES" }),
        );
        expect((t2 as Error).message).toMatch(/EACCES/);
      });

      it("names a missing pnpm binary specifically", () => {
        const cause = Object.assign(new Error("spawnSync pnpm ENOENT"), {
          code: "ENOENT",
        });
        const { thrown } = runFailing(join(targetDir, "no-pnpm"), cause);

        expect((thrown as Error).message).toMatch(/pnpm was not found on PATH/);
        expect((thrown as Error).cause).toBe(cause);
      });
    });

    it("installs a requested pack alongside the baseline", () => {
      const packTarget = join(targetDir, "sub-pack");

      main([packTarget, "--skip-install", "--pack", "harness-extras"]);

      expect(
        existsSync(
          join(packTarget, ".claude", "hooks", "guard-readonly-bash.mjs"),
        ),
      ).toBe(true);
      // harness-extras alone wires no verify step (the file-budget gate and
      // its check-file-budget.mjs script moved to the quality pack) -- the
      // baseline's own empty pack-steps file comes through untouched.
      expect(existsSync(join(packTarget, "bin", "check-file-budget.mjs"))).toBe(
        false,
      );
      const steps = JSON.parse(
        readFileSync(
          join(packTarget, "bin", "lib", "verify-steps.packs.json"),
          "utf8",
        ),
      ) as unknown[];
      expect(steps).toHaveLength(0);
    });

    it("installs the quality pack's agent and gate alongside harness-extras when both are requested", () => {
      const packTarget = join(targetDir, "sub-pack-quality");

      main([
        packTarget,
        "--skip-install",
        "--pack",
        "harness-extras",
        "--pack",
        "quality",
      ]);

      expect(
        existsSync(
          join(packTarget, ".claude", "hooks", "guard-readonly-bash.mjs"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(packTarget, ".claude", "agents", "type-design-analyzer.md"),
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
      ) as Array<{ id: string }>;
      expect(steps.map((step) => step.id)).toEqual(["file-budget"]);
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
      // each file under an inert .staged name, and the project's own
      // .claude/ tree was never created.
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
            "guard-readonly-bash.mjs.staged",
          ),
        ),
      ).toBe(true);
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
      ).toBe(false);
      expect(
        existsSync(
          join(
            projectDir,
            ".groundwork",
            "packs",
            "harness-extras",
            "pack.json.staged",
          ),
        ),
      ).toBe(true);
      expect(existsSync(join(projectDir, ".claude"))).toBe(false);

      const stagedPack = inventory.stagedPacks.find(
        (p: StagedPack) => p.name === "harness-extras",
      );
      expect(stagedPack).toBeDefined();
      expect(stagedPack?.dir).toBe(".groundwork/packs/harness-extras");
      expect(stagedPack?.suffix).toBe(".staged");
      expect(stagedPack?.manifest.staged).toBe("pack.json.staged");
      const stagedHook = stagedPack?.files.find(
        (f: StagedPackFile) =>
          f.path === ".claude/hooks/guard-readonly-bash.mjs",
      );
      expect(stagedHook?.staged).toBe(
        ".claude/hooks/guard-readonly-bash.mjs.staged",
      );
    });

    it("records every pack's stagedPacks hashes matching an independent sha256 of both the staged copy on disk and the real templates/packs/<name>/ source file", () => {
      const projectDir = join(targetDir, "existing-project3-hashes");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );

      main([projectDir]);

      const inventory = JSON.parse(
        readFileSync(join(projectDir, ".groundwork", "inventory.json"), "utf8"),
      ) as Inventory;
      expect(inventory.stagedPacks.length).toBeGreaterThan(0);

      const here = dirname(fileURLToPath(import.meta.url));
      const packsSourceRoot = join(
        here,
        "..",
        "..",
        "..",
        "templates",
        "packs",
      );

      for (const pack of inventory.stagedPacks) {
        const packDir = join(projectDir, ".groundwork", "packs", pack.name);
        const manifestBytes = readFileSync(join(packDir, pack.manifest.staged));
        expect(pack.manifest.sha256).toBe(
          createHash("sha256").update(manifestBytes).digest("hex"),
        );
        for (const file of pack.files) {
          const stagedBytes = readFileSync(join(packDir, "files", file.staged));
          expect(file.sha256).toBe(
            createHash("sha256").update(stagedBytes).digest("hex"),
          );
          const sourceBytes = readFileSync(
            join(packsSourceRoot, pack.name, "files", file.path),
          );
          expect(file.sha256).toBe(
            createHash("sha256").update(sourceBytes).digest("hex"),
          );
        }
      }
    });

    // Round-3 item 4: inventory.packs (the survey) and
    // inventory.stagedPacks (the staged, inert copies) must describe
    // exactly the same packs, and for each pack the same set of files --
    // the survey's fileConflicts entries (one per file under the pack's
    // files/ tree, regardless of status) and the staged files/ tree (every
    // file, unconditionally -- unlike the baseline stager, which only
    // stages "absent" conflicts) must agree on the same relPath/path set.
    it("links inventory.packs to inventory.stagedPacks: the same set of pack names, and per pack the same set of file paths (fileConflicts vs staged files)", () => {
      const projectDir = join(targetDir, "existing-project-pack-link");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );

      main([projectDir]);

      const inventory = JSON.parse(
        readFileSync(join(projectDir, ".groundwork", "inventory.json"), "utf8"),
      ) as Inventory;

      const packNames = new Set(inventory.packs.map((p) => p.name));
      const stagedPackNames = new Set(
        inventory.stagedPacks.map((p: StagedPack) => p.name),
      );
      expect(packNames.size).toBeGreaterThan(0);
      expect(packNames).toEqual(stagedPackNames);

      for (const pack of inventory.packs) {
        const staged = inventory.stagedPacks.find(
          (p: StagedPack) => p.name === pack.name,
        );
        expect(staged).toBeDefined();
        const conflictPaths = new Set(pack.fileConflicts.map((c) => c.relPath));
        const stagedPaths = new Set(
          (staged?.files ?? []).map((f: StagedPackFile) => f.path),
        );
        expect(conflictPaths.size).toBeGreaterThan(0);
        expect(conflictPaths).toEqual(stagedPaths);
      }
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

    it("stages absent baseline files at .groundwork/baseline/ as <path>.staged, each with a sha256 matching the staged bytes, without touching the project", () => {
      const projectDir = join(targetDir, "existing-project4");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );

      main([projectDir]);

      const inventory = JSON.parse(
        readFileSync(join(projectDir, ".groundwork", "inventory.json"), "utf8"),
      ) as Inventory;

      expect(inventory.stagedBaseline.dir).toBe(".groundwork/baseline");
      expect(inventory.stagedBaseline.suffix).toBe(".staged");
      expect(inventory.stagedBaseline.files.length).toBeGreaterThan(0);
      const paths = inventory.stagedBaseline.files.map((f) => f.path);
      for (const file of inventory.stagedBaseline.files) {
        expect(file.staged).toBe(`${file.path}.staged`);
        const stagedPath = join(
          projectDir,
          ".groundwork",
          "baseline",
          file.staged,
        );
        expect(existsSync(stagedPath)).toBe(true);
        expect(file.sha256).toBe(
          createHash("sha256").update(readFileSync(stagedPath)).digest("hex"),
        );
      }
      // package.json already exists in the project (a key-level conflict,
      // never "absent") -- it must not be staged, while a real baseline
      // file this fixture never created (eslint.config.js) must be.
      expect(paths).toContain("eslint.config.js");
      expect(paths).not.toContain("package.json");
    });

    it("throws EEXIST instead of following a symlink raced into place at adoption-report.md mid-run, leaving the outside file byte-identical (the 'wx' flag's guarantee)", () => {
      const projectDir = join(targetDir, "existing-project-report-symlink");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );

      const outsideDir = mkdtempSync(
        join(tmpdir(), "main-run-report-symlink-outside-"),
      );
      const outsidePath = join(outsideDir, "sensitive.txt");
      writeFileSync(outsidePath, "do not touch\n");
      const reportPath = join(projectDir, ".groundwork", "adoption-report.md");

      // Simulates the race the "wx" flag guards against: nothing is stale
      // at this path when runAdopt starts (it already deleted any stale
      // report up front), but something plants a symlink here DURING the
      // run, before the report write itself. installCustomizeSkillGuarded
      // is the last call before that write (see main.ts), so it's the one
      // reachable seam a test can use to land a symlink exactly in that
      // window without reaching into main()'s own internals.
      installCustomizeSkillGuardedMock.mockImplementationOnce(() => {
        mkdirSync(join(projectDir, ".groundwork"), { recursive: true });
        symlinkSync(outsidePath, reportPath);
        return { filesWritten: [], location: "claude" as const };
      });

      try {
        expect(() => main([projectDir])).toThrow(/EEXIST/);

        // The write never happened: "wx" refuses to open a path that
        // already exists (symlink or not) rather than following it, so the
        // outside file is never touched.
        expect(readFileSync(outsidePath, "utf8")).toBe("do not touch\n");
        expect(lstatSync(reportPath).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("deletes a stale .groundwork/adoption-decisions.json before staging, the same as inventory.json/adoption-report.md", () => {
      const projectDir = join(targetDir, "existing-project-decisions-stale");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );
      mkdirSync(join(projectDir, ".groundwork"), { recursive: true });
      const decisionsPath = join(
        projectDir,
        ".groundwork",
        "adoption-decisions.json",
      );
      writeFileSync(decisionsPath, JSON.stringify({ stale: true }));

      main([projectDir]);

      // A stale decisions file reflects decisions made against a now-replaced
      // inventory/report; runAdopt must clear it the same way it clears
      // inventory.json/adoption-report.md before staging.
      expect(existsSync(decisionsPath)).toBe(false);
    });

    // Round-3 item 1: a symlinked .groundwork/baseline is now refused BEFORE
    // the three stale .groundwork/ files are deleted (see
    // main-symlink-refusal-order.test.ts for the full contract) -- so,
    // unlike before that fix, the stale inventory.json/adoption-report.md
    // here survive the failed run untouched rather than being deleted up
    // front.
    it("refuses a symlinked .groundwork/baseline before deleting the stale report/inventory.json, leaving them untouched", () => {
      const projectDir = join(targetDir, "existing-project-ordering");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );
      mkdirSync(join(projectDir, ".groundwork"), { recursive: true });
      writeFileSync(
        join(projectDir, ".groundwork", "inventory.json"),
        "stale inventory\n",
      );
      writeFileSync(
        join(projectDir, ".groundwork", "adoption-report.md"),
        "stale report\n",
      );

      const outsideDir = mkdtempSync(
        join(tmpdir(), "main-run-ordering-outside-"),
      );
      writeFileSync(join(outsideDir, "sentinel.txt"), "do not touch");
      symlinkSync(
        outsideDir,
        join(projectDir, ".groundwork", "baseline"),
        "dir",
      );

      try {
        expect(() => main([projectDir])).toThrow(/symlink/);

        expect(
          existsSync(join(projectDir, ".groundwork", "inventory.json")),
        ).toBe(true);
        expect(
          readFileSync(
            join(projectDir, ".groundwork", "inventory.json"),
            "utf8",
          ),
        ).toBe("stale inventory\n");
        expect(
          existsSync(join(projectDir, ".groundwork", "adoption-report.md")),
        ).toBe(true);
        expect(
          readFileSync(
            join(projectDir, ".groundwork", "adoption-report.md"),
            "utf8",
          ),
        ).toBe("stale report\n");
        expect(readFileSync(join(outsideDir, "sentinel.txt"), "utf8")).toBe(
          "do not touch",
        );
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("writes adoption-report.md, then inventory.json last, on a normal run", () => {
      const projectDir = join(targetDir, "existing-project-order-normal");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );
      writeOrderMock.mockClear();

      main([projectDir]);

      // renderReport's result is written to adoption-report.md immediately
      // after it's called; writeInventory writes inventory.json itself --
      // the call order below is a direct proxy for the file-write order the
      // contract requires (report, then inventory.json last).
      expect(
        writeOrderMock.mock.calls.map((call: unknown[]) => call[0]),
      ).toEqual(["report", "inventory"]);
      expect(
        existsSync(join(projectDir, ".groundwork", "inventory.json")),
      ).toBe(true);
    });

    // Round-3 item 3: installCustomizeSkillGuarded throwing is one of the
    // failures past the point of no return (the three stale .groundwork/
    // files are already deleted by the time it runs) that now gets wrapped
    // -- see main-adopt-failure-wrapping.test.ts for the full contract
    // across every such failure. Neither inventory.json nor
    // adoption-report.md exists when it throws either way; what changed is
    // that the raw cause's message is chained via `cause`, not the thrown
    // error's own `message`.
    it("runs installCustomizeSkillGuarded BEFORE writing inventory.json/adoption-report.md -- neither file exists when it throws, and the failure is wrapped with the original chained as cause", () => {
      const projectDir = join(targetDir, "existing-project-skill-order");
      mkdirSync(projectDir);
      writeFileSync(
        projectDir + "/package.json",
        JSON.stringify({ name: "acme", type: "module" }),
      );
      // Seed all three stale .groundwork/ files from a PREVIOUS run, so the
      // wrapped failure's "adoption-decisions.json ... removed" wording is
      // legitimately true here (item 6: removedStaleFilesError names only
      // the files that existed before the run -- a bare first run, with
      // nothing to seed, must NOT claim this, see
      // main-adopt-removed-files-wording.test.ts).
      const groundworkDir = join(projectDir, ".groundwork");
      mkdirSync(groundworkDir, { recursive: true });
      writeFileSync(join(groundworkDir, "inventory.json"), "stale inventory\n");
      writeFileSync(
        join(groundworkDir, "adoption-report.md"),
        "stale report\n",
      );
      writeFileSync(
        join(groundworkDir, "adoption-decisions.json"),
        "stale decisions\n",
      );
      const cause = new Error("simulated guarded skill install failure");
      installCustomizeSkillGuardedMock.mockImplementationOnce(() => {
        throw cause;
      });

      let thrown: unknown;
      try {
        main([projectDir]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/adoption-decisions\.json/);
      expect((thrown as Error).message).toMatch(/removed/);
      expect((thrown as Error).message).toMatch(/re-run/);
      expect((thrown as Error).cause).toBe(cause);

      expect(
        existsSync(join(projectDir, ".groundwork", "inventory.json")),
      ).toBe(false);
      expect(
        existsSync(join(projectDir, ".groundwork", "adoption-report.md")),
      ).toBe(false);
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
