// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--upgrade` through `main()`: a REAL project is built by fresh mode (git and
 * the plugin installer mocked, as `main-run.test.ts` does), tampered with and
 * its manifest rewritten to simulate an upstream change, then planned and
 * staged. The plan only ever writes under `.groundwork/upgrade/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManifestError,
  readManifest,
  sha256Hex,
  writeManifest,
} from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import type { Out } from "../src/output.js";
import { AssertionError } from "node:assert/strict";
import type * as PlanModule from "../src/upgrade/plan.js";
import type * as PluginModule from "../src/plugin.js";
import type {
  GuardedInstallResult,
  InstallPluginResult,
} from "../src/plugin.js";
import { UPGRADE_SKILL } from "../src/skill-spec.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";

const {
  gitInitMock,
  runInstallMock,
  installSkillMock,
  installGuardedMock,
  installUpgradeSkillMock,
} = vi.hoisted(() => ({
  gitInitMock: vi.fn(),
  runInstallMock: vi.fn(),
  installUpgradeSkillMock: vi.fn(),
  installSkillMock: vi.fn((): InstallPluginResult => ({
    filesWritten: [],
  })),
  installGuardedMock: vi.fn(() => ({
    filesWritten: [],
    location: "claude" as const,
  })),
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installSkillMock,
  installCustomizeSkillGuarded: installGuardedMock,
  installSkillGuarded: installUpgradeSkillMock,
}));

// Wraps (never replaces) renderRelease to record where the release was
// rendered and that the directory existed when the call returned.
const { renderedDirs, existedAtRender } = vi.hoisted(() => ({
  renderedDirs: [] as string[],
  existedAtRender: [] as boolean[],
}));
vi.mock("../src/upgrade/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PlanModule>();
  const { existsSync: exists } = await import("node:fs");
  return {
    ...actual,
    renderRelease: (...args: Parameters<typeof actual.renderRelease>) => {
      const release = actual.renderRelease(...args);
      renderedDirs.push(release.dir);
      existedAtRender.push(exists(release.dir));
      return release;
    },
  };
});

const { main, CliUsageError } = await import("../src/main.js");
const { resolveCliVersion } = await import("../src/inventory.js");

interface PlanOnDisk {
  fromCliVersion: string;
  toCliVersion: string;
  legacy: boolean;
  files: { path: string; class: string; nextSha256?: string }[];
  staged: { path: string; staged: string; sha256: string }[];
}

function recordingOut(): Out & { infoLines: string[]; warnLines: string[] } {
  const infoLines: string[] = [];
  const warnLines: string[] = [];
  return {
    infoLines,
    warnLines,
    info: (msg) => {
      infoLines.push(msg);
    },
    notice: () => undefined,
    warn: (msg) => {
      warnLines.push(msg);
    },
    success: () => undefined,
  };
}

const UPGRADE_CLAUDE_FILES = [
  join(".claude", "skills", "upgrade", "step-3-conflicts.md"),
  join(".claude", "skills", "upgrade", "SKILL.md"),
];
const UPGRADE_FALLBACK_FILES = [
  join(".groundwork", "upgrade-skill", "step-3-conflicts.md"),
  join(".groundwork", "upgrade-skill", "SKILL.md"),
];

function claudeInstall(): GuardedInstallResult {
  return { filesWritten: UPGRADE_CLAUDE_FILES, location: "claude" };
}

describe("main --upgrade", () => {
  let base: string;
  let project: string;
  let tmpRoot: string;

  const upgradeDir = (): string => join(project, ".groundwork", "upgrade");
  const planOnDisk = (): PlanOnDisk =>
    JSON.parse(
      readFileSync(join(upgradeDir(), "plan.json"), "utf8"),
    ) as PlanOnDisk;
  const classOf = (plan: PlanOnDisk, path: string): string | undefined =>
    plan.files.find((e) => e.path === path)?.class;
  const upgrade = (out: Out = recordingOut()): void => {
    main([project, "--upgrade"], "linux", out);
  };
  const buildProject = (packs: readonly string[] = []): void => {
    main([
      project,
      "--skip-install",
      ...packs.flatMap((name) => ["--pack", name]),
    ]);
  };
  /** Everything except the staging directory this mode owns. */
  const treeOutsideUpgrade = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(snapshotTree(project)).filter(
        ([path]) =>
          path !== ".groundwork/upgrade" &&
          !path.startsWith(".groundwork/upgrade/"),
      ),
    );
  const tamperManifest = (mutate: (m: Manifest) => void): void => {
    const manifest = readManifest(project);
    if (manifest === undefined) throw new Error("no manifest");
    mutate(manifest);
    writeManifest(project, manifest);
  };
  const renderLeftovers = (): string[] =>
    readdirSync(tmpRoot).filter((n) => n.startsWith("groundwork-upgrade-"));

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "main-upgrade-"));
    project = join(base, "project");
    tmpRoot = join(base, "tmp");
    mkdirSync(tmpRoot);
    vi.stubEnv("TMPDIR", tmpRoot);
    gitInitMock.mockReset();
    runInstallMock.mockReset();
    installSkillMock.mockReset();
    installSkillMock.mockReturnValue({ filesWritten: [] });
    installGuardedMock.mockReset();
    installGuardedMock.mockReturnValue({
      filesWritten: [],
      location: "claude",
    });
    installUpgradeSkillMock.mockReset();
    installUpgradeSkillMock.mockReturnValue(claudeInstall());
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {
      /* silence */
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  describe("an untouched project", () => {
    it.each([[[]], [["harness-extras"]]])(
      "plans every file current, stages nothing and changes no project file (packs: %j)",
      (packs: string[]) => {
        buildProject(packs);
        const before = treeOutsideUpgrade();
        const manifestBytes = readFileSync(
          join(project, ".groundwork", "manifest.json"),
        );

        upgrade();

        const plan = planOnDisk();
        expect(plan.files.length).toBeGreaterThan(50);
        expect(plan.files.filter((e) => e.class !== "current")).toEqual([]);
        expect(plan.staged).toEqual([]);
        expect(plan.legacy).toBe(false);
        expect(plan.toCliVersion).toBe(resolveCliVersion());
        expect(existsSync(join(upgradeDir(), "staged"))).toBe(false);
        const report = readFileSync(
          join(upgradeDir(), "upgrade-report.md"),
          "utf8",
        );
        expect(report).toMatch(/nothing to apply/i);
        expect(treeOutsideUpgrade()).toEqual(before);
        expect(
          readFileSync(join(project, ".groundwork", "manifest.json")),
        ).toEqual(manifestBytes);
      },
      60_000,
    );

    it("ends with a Next line that points at --upgrade --stamp as nothing to apply", () => {
      buildProject();
      const out = recordingOut();
      upgrade(out);
      const next = out.infoLines.filter((l) => l.startsWith("Next:"));
      expect(next).toEqual([
        "Next: nothing to apply -- run --upgrade --stamp to record the new release in the manifest",
      ]);
    });

    it("prints the whole one-line summary and the staging location through out.info", () => {
      buildProject();
      const out = recordingOut();
      upgrade(out);
      const version = resolveCliVersion();
      const count = planOnDisk().files.length;
      expect(out.infoLines).toContain(
        `upgrade plan ${version} -> ${version}: ${String(count)} current`,
      );
      expect(out.infoLines.join("\n")).toMatch(
        /wrote \.groundwork\/upgrade\/ \(.*\b0 staged files\)/,
      );
    });

    it("exits normally and leaves no temporary render directory behind", () => {
      buildProject();
      expect(() => {
        upgrade();
      }).not.toThrow();
      expect(renderLeftovers()).toEqual([]);
    });

    it("renders under the stubbed temp root while running and removes the directory afterwards", () => {
      buildProject();
      renderedDirs.length = 0;
      existedAtRender.length = 0;

      upgrade();

      expect(renderedDirs).toHaveLength(1);
      const dir = renderedDirs[0] ?? "";
      expect(dir.startsWith(`${tmpRoot}/`)).toBe(true);
      expect(existedAtRender).toEqual([true]);
      expect(existsSync(dir)).toBe(false);
    });

    it("removes the render directory when the plan fails too", () => {
      buildProject();
      writeFileSync(join(project, "tsconfig.json"), "{ broken");
      renderedDirs.length = 0;

      expect(() => {
        upgrade();
      }).toThrow(/tsconfig\.json/);

      expect(renderedDirs).toHaveLength(1);
      expect(existsSync(renderedDirs[0] ?? "")).toBe(false);
    });

    it("gives byte-identical plan.json and report on a second run", () => {
      buildProject();
      upgrade();
      const planText = readFileSync(join(upgradeDir(), "plan.json"), "utf8");
      const reportText = readFileSync(
        join(upgradeDir(), "upgrade-report.md"),
        "utf8",
      );
      upgrade();
      expect(readFileSync(join(upgradeDir(), "plan.json"), "utf8")).toBe(
        planText,
      );
      expect(
        readFileSync(join(upgradeDir(), "upgrade-report.md"), "utf8"),
      ).toBe(reportText);
    });
  });

  describe("tampered projects (an upstream change simulated through the manifest)", () => {
    const OLD_COMMITLINT = "// the old commitlint config\n";
    const OLD_LEFTHOOK = "# the old lefthook\n";

    let freshCommitlint: Buffer;

    function tamper(): void {
      buildProject();
      freshCommitlint = readFileSync(join(project, "commitlint.config.js"));
      // safe-update: the project still holds the OLD content the manifest records.
      writeFileSync(join(project, "commitlint.config.js"), OLD_COMMITLINT);
      // conflict-3way: the manifest records an old hash AND the user edited the file.
      writeFileSync(join(project, "lefthook.yml"), "# my own lefthook\n");
      // local-only: the release is unchanged, the user edited it.
      writeFileSync(join(project, "knip.json"), '{"mine":true}\n');
      // user-deleted.
      rmSync(join(project, "README.md"));
      // remove (untouched) and orphan-edited (edited): recorded, absent upstream.
      writeFileSync(join(project, "ghost.txt"), "ghost\n");
      writeFileSync(join(project, "ghost-edited.txt"), "ghost edited\n");
      tamperManifest((m) => {
        const entry = (hash: string): Manifest["files"][string] => ({
          sha256: hash,
          origin: "emitted",
        });
        m.files["commitlint.config.js"] = entry(sha256Hex(OLD_COMMITLINT));
        m.files["lefthook.yml"] = entry(sha256Hex(OLD_LEFTHOOK));
        m.files["ghost.txt"] = entry(sha256Hex("ghost\n"));
        m.files["ghost-edited.txt"] = entry(sha256Hex("ghost original\n"));
      });
    }

    it("classifies each scenario and stages exactly the four staged classes", () => {
      tamper();
      const before = treeOutsideUpgrade();

      upgrade();

      const plan = planOnDisk();
      expect(classOf(plan, "commitlint.config.js")).toBe("safe-update");
      expect(classOf(plan, "lefthook.yml")).toBe("conflict-3way");
      expect(classOf(plan, "knip.json")).toBe("local-only");
      expect(classOf(plan, "README.md")).toBe("user-deleted");
      expect(classOf(plan, "ghost.txt")).toBe("remove");
      expect(classOf(plan, "ghost-edited.txt")).toBe("orphan-edited");
      expect(classOf(plan, ".gitignore")).toBe("current");

      expect(plan.staged.map((s) => s.path)).toEqual([
        "commitlint.config.js",
        "lefthook.yml",
      ]);
      const stagedDir = join(upgradeDir(), "staged");
      expect(existsSync(join(stagedDir, "commitlint.config.js.staged"))).toBe(
        true,
      );
      expect(existsSync(join(stagedDir, "lefthook.yml.staged"))).toBe(true);
      for (const unstaged of [
        "knip.json",
        "README.md",
        "ghost.txt",
        "ghost-edited.txt",
      ]) {
        expect(existsSync(join(stagedDir, `${unstaged}.staged`))).toBe(false);
      }
      // The staged bytes are exactly the new release's (what fresh mode emitted).
      const stagedBytes = readFileSync(
        join(stagedDir, "commitlint.config.js.staged"),
      );
      expect(stagedBytes).toEqual(freshCommitlint);
      const staged = plan.staged.find((s) => s.path === "commitlint.config.js");
      const planned = plan.files.find((e) => e.path === "commitlint.config.js");
      expect(planned?.nextSha256).toBeDefined();
      expect(staged?.sha256).toBe(planned?.nextSha256);
      expect(staged?.sha256).toBe(sha256Hex(stagedBytes));
      expect(staged?.sha256).toBe(sha256Hex(freshCommitlint));
      expect(treeOutsideUpgrade()).toEqual(before);
    });

    it("pluralises the staged-file count in the summary line", () => {
      tamper();
      const out = recordingOut();
      upgrade(out);
      expect(out.infoLines.join("\n")).toMatch(/\b2 staged files\)/);
    });

    it("says '1 staged file' for exactly one staged file", () => {
      buildProject();
      writeFileSync(join(project, "commitlint.config.js"), OLD_COMMITLINT);
      tamperManifest((m) => {
        m.files["commitlint.config.js"] = {
          sha256: sha256Hex(OLD_COMMITLINT),
          origin: "emitted",
        };
      });
      const out = recordingOut();
      upgrade(out);
      expect(planOnDisk().staged).toHaveLength(1);
      expect(out.infoLines.join("\n")).toMatch(/\b1 staged file\)/);
    });

    it("ends with the apply-case Next line when a file is staged", () => {
      tamper();
      const out = recordingOut();
      upgrade(out);
      const next = out.infoLines.filter((l) => l.startsWith("Next:"));
      expect(next).toHaveLength(1);
      expect(next[0]).toBe(
        "Next: open this project in Claude Code and run /upgrade to apply the plan (or apply the staged files by hand, then run --upgrade --stamp)",
      );
      expect(next[0]).not.toContain("not available yet");
      expect(next[0]).not.toContain("nothing to apply");
    });

    it("lists the decisions and removals in the report", () => {
      tamper();
      upgrade();
      const report = readFileSync(
        join(upgradeDir(), "upgrade-report.md"),
        "utf8",
      );
      expect(report).toContain("`lefthook.yml`");
      expect(report).toContain("`commitlint.config.js`");
      expect(report).toContain("`ghost.txt`");
      expect(report).toContain("`ghost-edited.txt`");
      expect(report).not.toMatch(/nothing to apply/i);
    });
  });

  describe("refusals that write nothing", () => {
    it("refuses a project with no manifest as a usage error with the adopt advice", () => {
      mkdirSync(project);
      writeFileSync(join(project, "package.json"), '{"name":"legacy"}\n');
      const before = snapshotTree(project);

      let thrown: unknown;
      try {
        upgrade();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CliUsageError);
      const message = (thrown as Error).message;
      expect(message).toContain("manifest");
      expect(message).toContain("npx @monte3l/groundwork .");
      expect(message).toMatch(/adopt/);
      expect(message).toContain("/customize");
      expect(snapshotTree(project)).toEqual(before);
      expect(existsSync(join(project, ".groundwork"))).toBe(false);
      expect(renderLeftovers()).toEqual([]);
    });

    it("propagates a corrupt manifest as a ManifestError and writes nothing", () => {
      buildProject();
      writeFileSync(
        join(project, ".groundwork", "manifest.json"),
        "{ not json",
      );
      const before = snapshotTree(project);

      expect(() => {
        upgrade();
      }).toThrow(ManifestError);

      expect(snapshotTree(project)).toEqual(before);
      expect(existsSync(upgradeDir())).toBe(false);
    });

    it("fails with the plan module's error for a pack the release lacks, writing nothing and leaving no render directory", () => {
      buildProject();
      tamperManifest((m) => {
        m.packs = ["no-such-pack"];
      });
      const before = snapshotTree(project);

      expect(() => {
        upgrade();
      }).toThrow(/no-such-pack/);

      expect(snapshotTree(project)).toEqual(before);
      expect(existsSync(upgradeDir())).toBe(false);
      expect(renderLeftovers()).toEqual([]);
    });

    it("fails with the plan module's error for an unparseable managed JSON file, writing nothing and leaving no render directory", () => {
      buildProject();
      writeFileSync(join(project, "tsconfig.json"), "{ broken");
      const before = snapshotTree(project);

      expect(() => {
        upgrade();
      }).toThrow(/tsconfig\.json/);

      expect(snapshotTree(project)).toEqual(before);
      expect(existsSync(upgradeDir())).toBe(false);
      expect(renderLeftovers()).toEqual([]);
    });
  });

  describe("a previous .groundwork/upgrade/", () => {
    it("discards foreign entries loudly through the warn channel, naming each", () => {
      buildProject();
      upgrade();
      writeFileSync(join(upgradeDir(), "decisions.json"), "[]\n");
      writeFileSync(join(upgradeDir(), "notes.txt"), "mine\n");
      const out = recordingOut();

      upgrade(out);

      expect(readdirSync(upgradeDir()).sort()).toEqual([
        "plan.json",
        "upgrade-report.md",
      ]);
      const warning = out.warnLines.join("\n");
      expect(warning).toContain("decisions.json");
      expect(warning).toContain("notes.txt");
      expect(warning).toMatch(/discarded/);
      expect(warning).toMatch(/decision/);
      expect(warning).toMatch(/own plan/);
      const elsewhere = [...out.infoLines].join("\n");
      expect(elsewhere).not.toContain("notes.txt");
    });

    it("does not warn when the previous staging holds only plan.json, upgrade-report.md and staged", () => {
      buildProject();
      writeFileSync(join(project, "commitlint.config.js"), "// mine\n");
      tamperManifest((m) => {
        m.files["commitlint.config.js"] = {
          sha256: sha256Hex("// mine\n"),
          origin: "emitted",
        };
      });
      upgrade();
      expect(readdirSync(upgradeDir()).sort()).toEqual([
        "plan.json",
        "staged",
        "upgrade-report.md",
      ]);
      const out = recordingOut();

      upgrade(out);

      expect(out.warnLines).toEqual([]);
    });

    it("refuses a regular file at .groundwork/upgrade with a plain error, writing nothing", () => {
      buildProject();
      writeFileSync(join(project, ".groundwork", "upgrade"), "i am a file\n");
      const before = snapshotTree(project);

      let thrown: unknown;
      try {
        upgrade();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      expect(thrown).not.toBeInstanceOf(ManifestError);
      const message = (thrown as Error).message;
      expect(message).toContain(".groundwork/upgrade");
      expect(message).toMatch(/remove/);
      expect(snapshotTree(project)).toEqual(before);
      expect(
        readFileSync(join(project, ".groundwork", "upgrade"), "utf8"),
      ).toBe("i am a file\n");
      expect(renderLeftovers()).toEqual([]);
    });
  });

  describe("an unreadable target", () => {
    const cannotChmod =
      process.platform === "win32" || process.getuid?.() === 0;

    it.skipIf(cannotChmod)(
      "surfaces the real error naming the path instead of 'does not exist'",
      () => {
        const locked = join(base, "locked");
        const target = join(locked, "project");
        mkdirSync(target, { recursive: true });
        chmodSync(locked, 0o000);

        let thrown: unknown;
        try {
          main([target, "--upgrade"], "linux", recordingOut());
        } catch (error) {
          thrown = error;
        } finally {
          chmodSync(locked, 0o755);
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(CliUsageError);
        const message = (thrown as Error).message;
        expect(message).toContain(target);
        expect(message).not.toMatch(/does not exist/);
      },
    );
  });

  describe("usage errors in upgrade mode", () => {
    it.each([
      [["--name", "widgets"], "--name"],
      [["--force"], "--force"],
      [["--pack", "harness-extras"], "--pack"],
      [["--skip-install"], "--skip-install"],
    ])(
      "rejects %j as having no effect in upgrade mode",
      (extra: string[], flag: string) => {
        buildProject();
        const before = snapshotTree(project);

        let thrown: unknown;
        try {
          main([project, "--upgrade", ...extra], "linux", recordingOut());
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(CliUsageError);
        expect((thrown as Error).message).toContain(flag);
        expect((thrown as Error).message).toMatch(/no effect in upgrade mode/);
        expect(snapshotTree(project)).toEqual(before);
      },
    );

    it("rejects --json, saying plan reports are not available yet", () => {
      buildProject();
      const before = snapshotTree(project);

      let thrown: unknown;
      try {
        main([project, "--upgrade", "--json"], "linux", recordingOut());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toContain("--json");
      expect((thrown as Error).message).toMatch(/not available yet/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("rejects a target directory that does not exist, creating nothing", () => {
      const missing = join(base, "missing");
      expect(() => {
        main([missing, "--upgrade"], "linux", recordingOut());
      }).toThrow(CliUsageError);
      expect(() => {
        main([missing, "--upgrade"], "linux", recordingOut());
      }).toThrow(/does not exist/);
      expect(existsSync(missing)).toBe(false);
    });

    it("rejects a target that is not a directory", () => {
      const file = join(base, "a-file");
      writeFileSync(file, "x");
      expect(() => {
        main([file, "--upgrade"], "linux", recordingOut());
      }).toThrow(CliUsageError);
      expect(() => {
        main([file, "--upgrade"], "linux", recordingOut());
      }).toThrow(/not a directory/);
    });

    it.each(["--adopt", "--fresh"])(
      "rejects --upgrade combined with %s",
      (other) => {
        buildProject();
        expect(() => {
          main([project, "--upgrade", other], "linux", recordingOut());
        }).toThrow(CliUsageError);
      },
    );
  });

  describe("the /upgrade skill install", () => {
    const APPLY_NEXT =
      "Next: open this project in Claude Code and run /upgrade to apply the plan (or apply the staged files by hand, then run --upgrade --stamp)";
    const OLD = "// the old commitlint config\n";

    /** One safe-update, so the plan has something to apply. */
    const stageOneUpdate = (): void => {
      buildProject();
      writeFileSync(join(project, "commitlint.config.js"), OLD);
      tamperManifest((m) => {
        m.files["commitlint.config.js"] = {
          sha256: sha256Hex(OLD),
          origin: "emitted",
        };
      });
    };
    const fallbackInstall = (
      fallbackCause: "entry" | "component",
    ): GuardedInstallResult => ({
      filesWritten: UPGRADE_FALLBACK_FILES,
      location: "groundwork",
      fallbackReason:
        "REASON: .claude/skills/upgrade/SKILL.md is the project's",
      fallbackCause,
    });

    it("installs UPGRADE_SKILL into the project through the generic guarded installer, once", () => {
      buildProject();
      upgrade();
      expect(installUpgradeSkillMock).toHaveBeenCalledTimes(1);
      const args = installUpgradeSkillMock.mock.calls[0] as unknown[];
      expect(args[0]).toBe(UPGRADE_SKILL);
      expect(args[1]).toBe(project);
    });

    it("runs only after plan.json is committed and the render directory is disposed", () => {
      buildProject();
      let planExisted = false;
      let renderDirGone = false;
      installUpgradeSkillMock.mockImplementation(() => {
        planExisted = existsSync(join(upgradeDir(), "plan.json"));
        renderDirGone = renderedDirs.every((dir) => !existsSync(dir));
        return claudeInstall();
      });
      upgrade();
      expect(planExisted).toBe(true);
      expect(renderDirGone).toBe(true);
    });

    it("reports a fresh install into .claude/skills/upgrade with its file count", () => {
      buildProject();
      const out = recordingOut();
      upgrade(out);
      expect(out.infoLines).toContain(
        "installed the /upgrade skill into .claude/skills/upgrade (2 files)",
      );
    });

    it("reports an identical existing copy as already present", () => {
      buildProject();
      installUpgradeSkillMock.mockReturnValue({
        filesWritten: [],
        location: "already-present",
      });
      const out = recordingOut();
      upgrade(out);
      expect(out.infoLines).toContain(
        "the /upgrade skill is already present in .claude/skills/upgrade",
      );
      expect(out.infoLines.join("\n")).not.toContain(
        "installed the /upgrade skill",
      );
    });

    it("reports a fallback install with the installer's reason on an indented line after it", () => {
      buildProject();
      installUpgradeSkillMock.mockReturnValue(fallbackInstall("entry"));
      const out = recordingOut();
      upgrade(out);
      const at = out.infoLines.indexOf(
        "installed the /upgrade skill into .groundwork/upgrade-skill (2 files)",
      );
      expect(at).toBeGreaterThanOrEqual(0);
      expect(out.infoLines[at + 1]).toBe(
        "  REASON: .claude/skills/upgrade/SKILL.md is the project's",
      );
    });

    it("ends the apply case with the /upgrade Next line", () => {
      stageOneUpdate();
      const out = recordingOut();
      upgrade(out);
      expect(out.infoLines.filter((l) => l.startsWith("Next:"))).toEqual([
        APPLY_NEXT,
      ]);
    });

    it("writes a nothing-to-apply report that does not tell the user to run /upgrade to apply", () => {
      buildProject();
      upgrade();
      const report = readFileSync(
        join(upgradeDir(), "upgrade-report.md"),
        "utf8",
      );
      expect(report).toMatch(/nothing to apply/i);
      expect(report).not.toContain("to apply this plan");
      expect(report).toContain(
        "This run wrote this plan only under `.groundwork/upgrade/`; the `/upgrade` skill is installed separately, as the console output says.",
      );
    });

    it("documents the fallback in --help as a different copy", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      main(["--help"]);
      const text = String(log.mock.calls[0]?.[0]).replace(/\s+/g, " ");
      expect(text).toContain("a different copy");
      expect(text).toContain(".groundwork/upgrade-skill/");
      expect(text).not.toContain("the project's own");
    });

    it("keeps the nothing-to-apply Next line unchanged", () => {
      buildProject();
      const out = recordingOut();
      upgrade(out);
      expect(out.infoLines.filter((l) => l.startsWith("Next:"))).toEqual([
        "Next: nothing to apply -- run --upgrade --stamp to record the new release in the manifest",
      ]);
    });

    it.each(["entry", "component"] as const)(
      "tells the user to copy the fallback copy into place first when the cause is %s",
      (cause) => {
        stageOneUpdate();
        installUpgradeSkillMock.mockReturnValue(fallbackInstall(cause));
        const out = recordingOut();
        upgrade(out);
        const next = out.infoLines.filter((l) => l.startsWith("Next:"));
        expect(next).toHaveLength(1);
        expect(next[0]).toContain(".groundwork/upgrade-skill/");
        expect(next[0]).toContain(".claude/skills/upgrade");
        expect(next[0]).toContain("/upgrade");
        expect(next[0]).not.toBe(APPLY_NEXT);
      },
    );

    it("writes the new report wording, not the unavailable-skill sentence", () => {
      stageOneUpdate();
      upgrade();
      const report = readFileSync(
        join(upgradeDir(), "upgrade-report.md"),
        "utf8",
      );
      expect(report).toContain(
        "Run `/upgrade` in Claude Code to apply this plan. This run wrote this plan only under `.groundwork/upgrade/`; the `/upgrade` skill is installed separately, as the console output says.",
      );
      expect(report).not.toContain("not available yet");
    });

    it.each([
      ["package.json"],
      [join(".claude", "skills", "customize", "SKILL.md")],
      [join(".groundwork", "upgrade", "plan.json")],
      [join(".groundwork", "manifest.json")],
      [join(".groundwork", "upgrade-skill-evil", "SKILL.md")],
      [join(".claude", "skills", "upgrade-evil", "SKILL.md")],
      [join(".claude", "skills", "upgrade", "..", "..", "settings.json")],
    ])(
      "refuses an installer result that wrote outside its scope: %s",
      (outside) => {
        buildProject();
        installUpgradeSkillMock.mockReturnValue({
          filesWritten: [...UPGRADE_CLAUDE_FILES, outside],
          location: "claude",
        });
        const out = recordingOut();
        expect(() => {
          upgrade(out);
        }).toThrow(Error);
        expect(out.infoLines.join("\n")).not.toContain(
          "installed the /upgrade skill",
        );
      },
    );

    it("accepts every planned path of both locations", () => {
      buildProject();
      installUpgradeSkillMock.mockReturnValue({
        filesWritten: [...UPGRADE_CLAUDE_FILES, ...UPGRADE_FALLBACK_FILES],
        location: "claude",
      });
      expect(() => {
        upgrade();
      }).not.toThrow();
    });

    describe("when the installer throws", () => {
      const boom = new Error("disk full");
      let thrown: Error;

      beforeEach(() => {
        buildProject();
        installUpgradeSkillMock.mockImplementation(() => {
          throw boom;
        });
        try {
          upgrade();
          throw new Error("expected --upgrade to throw");
        } catch (error) {
          thrown = error as Error;
        }
      });

      it("fails with an Error saying the plan was staged and a re-run retries the skill install", () => {
        expect(thrown).not.toBe(boom);
        expect(thrown.message).toContain(".groundwork/upgrade/");
        expect(thrown.message).toMatch(/staged/i);
        expect(thrown.message).toContain("--upgrade");
        expect(thrown.message).toMatch(/re-?run/i);
        expect(thrown.message).toContain("/upgrade");
      });

      it("chains the installer's error as the cause", () => {
        expect(thrown.cause).toBe(boom);
      });

      it("leaves the staged plan in place", () => {
        expect(existsSync(join(upgradeDir(), "plan.json"))).toBe(true);
        expect(existsSync(join(upgradeDir(), "upgrade-report.md"))).toBe(true);
      });
    });

    describe("when the installer throws an AssertionError", () => {
      it("lets it propagate unchanged, with no retry advice", () => {
        buildProject();
        const broken = new AssertionError({ message: "broken invariant" });
        installUpgradeSkillMock.mockImplementation(() => {
          throw broken;
        });
        let thrown: unknown;
        try {
          upgrade();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(broken);
        expect(thrown).toBeInstanceOf(AssertionError);
        expect((thrown as Error).message).not.toMatch(/re-?run/i);
        expect((thrown as Error).message).not.toMatch(/staged/i);
      });

      it("lets a write-scope violation reach the caller as an AssertionError", () => {
        buildProject();
        installUpgradeSkillMock.mockReturnValue({
          filesWritten: ["package.json"],
          location: "claude",
        });
        expect(() => {
          upgrade();
        }).toThrow(AssertionError);
      });
    });

    describe("never installs when --upgrade refuses", () => {
      it("with no manifest", () => {
        mkdirSync(project);
        writeFileSync(join(project, "package.json"), '{"name":"legacy"}\n');
        expect(() => {
          upgrade();
        }).toThrow(CliUsageError);
        expect(installUpgradeSkillMock).not.toHaveBeenCalled();
      });

      it("with a corrupt manifest", () => {
        buildProject();
        writeFileSync(
          join(project, ".groundwork", "manifest.json"),
          "{ not json",
        );
        expect(() => {
          upgrade();
        }).toThrow(ManifestError);
        expect(installUpgradeSkillMock).not.toHaveBeenCalled();
      });

      it.each([["--name", "widgets"], ["--force"], ["--json"], ["--adopt"]])(
        "with the usage error %j",
        (...extra: string[]) => {
          buildProject();
          expect(() => {
            main([project, "--upgrade", ...extra], "linux", recordingOut());
          }).toThrow(CliUsageError);
          expect(installUpgradeSkillMock).not.toHaveBeenCalled();
        },
      );

      const writeRawManifest = (
        mutate: (m: Record<string, unknown>) => void,
      ): void => {
        const path = join(project, ".groundwork", "manifest.json");
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
          string,
          unknown
        >;
        mutate(raw);
        writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
      };

      it.each([
        [
          "a cliVersion carrying a shell command",
          "cliVersion",
          "1.2.3; echo x",
          (m: Record<string, unknown>): void => {
            m["cliVersion"] = "1.2.3; echo x";
          },
        ],
        [
          "a PROJECT_NAME carrying a shell command",
          "PROJECT_NAME",
          "app; echo x",
          (m: Record<string, unknown>): void => {
            m["tokens"] = { PROJECT_NAME: "app; echo x", YEAR: "2026" };
          },
        ],
        [
          "a pack name that is not a pack name",
          "packs",
          "x; echo y",
          (m: Record<string, unknown>): void => {
            m["packs"] = ["x; echo y"];
          },
        ],
      ])("with a hostile manifest: %s", (_label, field, value, mutate) => {
        buildProject();
        writeRawManifest(mutate);
        const before = snapshotTree(project);
        let thrown: unknown;
        try {
          upgrade();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ManifestError);
        expect((thrown as Error).message).toContain(field);
        expect((thrown as Error).message).not.toContain(value);
        expect(snapshotTree(project)).toEqual(before);
        expect(existsSync(upgradeDir())).toBe(false);
        expect(installUpgradeSkillMock).not.toHaveBeenCalled();
      });

      it("when a regular file sits at .groundwork/upgrade", () => {
        buildProject();
        writeFileSync(join(project, ".groundwork", "upgrade"), "x");
        expect(() => {
          upgrade();
        }).toThrow(Error);
        expect(installUpgradeSkillMock).not.toHaveBeenCalled();
      });
    });

    const SCOPE_ROOTS = [
      ".groundwork/upgrade",
      ".claude/skills/upgrade",
      ".groundwork/upgrade-skill",
    ];
    const SCOPE_PARENT_DIRS = [".claude", ".claude/skills", ".groundwork"];

    /** Changed paths outside the three roots; the roots' parents count only as directories. */
    function outsideScope(
      changed: string[],
      tree: Record<string, string>,
    ): string[] {
      return changed.filter((path) => {
        const posix = path.split("\\").join("/");
        const inRoot = SCOPE_ROOTS.some(
          (root) => posix === root || posix.startsWith(`${root}/`),
        );
        const dirParent =
          SCOPE_PARENT_DIRS.includes(posix) && tree[path] === "dir";
        return !inRoot && !dirParent;
      });
    }

    it.each([
      [".claude/skills/customize/SKILL.md", "file"],
      [".groundwork/upgrade-evil/x", "file"],
      [".groundwork/upgrade-evil", "dir"],
      [".claude/skills/upgrade-evil", "dir"],
      [".claude", "file"],
      [".groundwork", "file"],
      ["package.json", "file"],
    ])("scope check flags %s as a %s", (path, kind) => {
      expect(outsideScope([path], { [path]: kind })).toEqual([path]);
    });

    it.each([
      [".claude", "dir"],
      [".claude/skills", "dir"],
      [".groundwork", "dir"],
      [".claude/skills/upgrade", "dir"],
      [".groundwork/upgrade/plan.json", "file"],
      [".groundwork/upgrade-skill/SKILL.md", "file"],
    ])("scope check accepts %s as a %s", (path, kind) => {
      expect(outsideScope([path], { [path]: kind })).toEqual([]);
    });

    it("writes only under .groundwork/upgrade/, .claude/skills/upgrade/ and .groundwork/upgrade-skill/ with the real installer, and leaves the manifest alone", async () => {
      const actual =
        await vi.importActual<typeof PluginModule>("../src/plugin.js");
      installUpgradeSkillMock.mockImplementation(actual.installSkillGuarded);
      stageOneUpdate();
      const before = snapshotTree(project);
      const manifestBytes = readFileSync(
        join(project, ".groundwork", "manifest.json"),
      );

      upgrade();

      const after = snapshotTree(project);
      const changed = [
        ...new Set([...Object.keys(before), ...Object.keys(after)]),
      ]
        .filter((path) => before[path] !== after[path])
        .sort();
      expect(changed.length).toBeGreaterThan(0);
      expect(outsideScope(changed, after)).toEqual([]);
      expect(changed).toContain(
        join(".claude", "skills", "upgrade", "SKILL.md"),
      );
      expect(
        readFileSync(join(project, ".groundwork", "manifest.json")),
      ).toEqual(manifestBytes);
    });
  });
});
