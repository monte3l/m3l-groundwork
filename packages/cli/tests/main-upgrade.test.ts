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
import type * as PlanModule from "../src/upgrade/plan.js";
import type { InstallPluginResult } from "../src/plugin.js";
import { snapshotTree } from "./upgrade-plan-fixture.js";

const { gitInitMock, runInstallMock, installSkillMock, installGuardedMock } =
  vi.hoisted(() => ({
    gitInitMock: vi.fn(),
    runInstallMock: vi.fn(),
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
      expect(next[0]).toContain("apply the staged files you want by hand");
      expect(next[0]).toContain("/upgrade skill");
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
});
