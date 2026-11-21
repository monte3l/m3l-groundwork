// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--upgrade --stamp` through `main()`: a REAL project is built by fresh mode
 * (git and the plugin installer mocked, as `main-upgrade.test.ts` does), an
 * upstream change is simulated through the manifest, `--upgrade` stages the
 * plan, the change is applied by hand and `--stamp` records it. The stamp
 * writes only the manifest and never renders, plans or stages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_RELATIVE_PATH,
  ManifestError,
  readManifest,
  sha256Hex,
  writeManifest,
} from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import type { Out } from "../src/output.js";
import { UpgradeStampError } from "../src/upgrade/stamp.js";
import type * as PlanModule from "../src/upgrade/plan.js";
import type * as StageModule from "../src/upgrade/stage.js";
import type { InstallPluginResult } from "../src/plugin.js";
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

// Wrap (never replace) the plan and staging entry points to count calls.
const { calls } = vi.hoisted(() => ({
  calls: { render: 0, compute: 0, stage: 0 },
}));
vi.mock("../src/upgrade/plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PlanModule>();
  return {
    ...actual,
    renderRelease: (...args: Parameters<typeof actual.renderRelease>) => {
      calls.render += 1;
      return actual.renderRelease(...args);
    },
    computePlan: (...args: Parameters<typeof actual.computePlan>) => {
      calls.compute += 1;
      return actual.computePlan(...args);
    },
  };
});
vi.mock("../src/upgrade/stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof StageModule>();
  return {
    ...actual,
    stageUpgrade: (...args: Parameters<typeof actual.stageUpgrade>) => {
      calls.stage += 1;
      return actual.stageUpgrade(...args);
    },
  };
});

const { main, CliUsageError } = await import("../src/main.js");
const { resolveCliVersion } = await import("../src/inventory.js");

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

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

describe("main --upgrade --stamp", () => {
  let base: string;
  let project: string;

  const OLD_COMMITLINT = "// the old commitlint config\n";
  let freshCommitlint: string;

  const manifestFile = (): string =>
    join(project, ".groundwork", "manifest.json");
  const buildProject = (): void => {
    main([project, "--skip-install"], "linux", recordingOut());
  };
  const upgrade = (): void => {
    main([project, "--upgrade"], "linux", recordingOut());
  };
  const stampArgs = (...extra: string[]): string[] => [
    project,
    "--upgrade",
    "--stamp",
    ...extra,
  ];
  const tamperManifest = (mutate: (m: Manifest) => void): void => {
    const manifest = readManifest(project);
    if (manifest === undefined) throw new Error("no manifest");
    mutate(manifest);
    writeManifest(project, manifest);
  };
  /** A project with one pending safe-update (commitlint.config.js) and a plan staged for it. */
  const projectWithStagedUpgrade = (): void => {
    buildProject();
    freshCommitlint = readFileSync(
      join(project, "commitlint.config.js"),
      "utf8",
    );
    writeFileSync(join(project, "commitlint.config.js"), OLD_COMMITLINT);
    tamperManifest((m) => {
      m.files["commitlint.config.js"] = {
        sha256: sha256Hex(OLD_COMMITLINT),
        origin: "emitted",
      };
    });
    upgrade();
  };
  const thrownBy = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "main-upgrade-stamp-"));
    project = join(base, "project");
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
    installUpgradeSkillMock.mockReturnValue({
      filesWritten: [
        ".claude/skills/upgrade/SKILL.md",
        ".claude/skills/upgrade/step-3-conflicts.md",
      ],
      location: "claude",
    });
    calls.render = 0;
    calls.compute = 0;
    calls.stage = 0;
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {
      /* silence */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  describe("the success path", () => {
    it("records an applied safe-update, prints the two lines and writes only the manifest", () => {
      projectWithStagedUpgrade();
      // applied by hand, as the upgrade report says
      writeFileSync(join(project, "commitlint.config.js"), freshCommitlint);
      const before = snapshotTree(project);
      calls.render = 0;
      calls.compute = 0;
      calls.stage = 0;
      installUpgradeSkillMock.mockClear();
      const out = recordingOut();

      const result = main(stampArgs(), "linux", out);

      expect(result).toBeUndefined();
      expect(out.infoLines).toHaveLength(2);
      expect(out.infoLines[0]).toMatch(/^upgrade mode: /);
      const version = resolveCliVersion();
      expect(out.infoLines[1]).toMatch(
        new RegExp(
          `^stamped ${MANIFEST_RELATIVE_PATH.replaceAll(".", "\\.")} at ${version.replaceAll(".", "\\.")}: 1 updated, \\d+ kept, 0 dropped$`,
        ),
      );
      const manifest = readManifest(project);
      expect(manifest?.cliVersion).toBe(version);
      expect(manifest?.files["commitlint.config.js"]).toEqual({
        sha256: sha256Hex(freshCommitlint),
        origin: "emitted",
      });
      const after = snapshotTree(project);
      const changed = Object.keys({ ...before, ...after }).filter(
        (path) => before[path] !== after[path],
      );
      expect(changed).toEqual([".groundwork/manifest.json"]);
      expect(calls).toEqual({ render: 0, compute: 0, stage: 0 });
      expect(installUpgradeSkillMock).not.toHaveBeenCalled();
    });

    it("leaves an unapplied safe-update pending: the old hash is kept, marked merged", () => {
      projectWithStagedUpgrade();

      main(stampArgs(), "linux", recordingOut());

      expect(readManifest(project)?.files["commitlint.config.js"]).toEqual({
        sha256: sha256Hex(OLD_COMMITLINT),
        origin: "merged",
      });
    });

    it("refuses a cross-version re-stamp of the same plan as stale, writing nothing", () => {
      projectWithStagedUpgrade();
      writeFileSync(join(project, "commitlint.config.js"), freshCommitlint);
      main(stampArgs(), "linux", recordingOut());
      const before = snapshotTree(project);

      const thrown = thrownBy(() => main(stampArgs(), "linux", recordingOut()));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/stale/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("ends the plain --upgrade output with a Next line that mentions running --upgrade --stamp after applying", () => {
      buildProject();
      const out = recordingOut();

      main([project, "--upgrade"], "linux", out);

      const next = out.infoLines.at(-1) ?? "";
      expect(next).toMatch(/^Next:/);
      expect(next).toContain("--upgrade --stamp");
      expect(next).toMatch(/apply/i);
    });

    it("records a conflict the user kept as merged with the disk hash", () => {
      projectWithStagedUpgrade();
      writeFileSync(join(project, "commitlint.config.js"), "// my own\n");

      main(stampArgs(), "linux", recordingOut());

      expect(readManifest(project)?.files["commitlint.config.js"]).toEqual({
        sha256: sha256Hex("// my own\n"),
        origin: "merged",
      });
    });

    it("refuses a plan whose fromCliVersion no longer matches the manifest as stale, writing nothing", () => {
      projectWithStagedUpgrade();
      // Make the manifest's version differ from the plan's fromCliVersion.
      tamperManifest((m) => {
        m.cliVersion = "0.0.1";
      });
      const before = snapshotTree(project);

      const thrown = thrownBy(() => main(stampArgs(), "linux", recordingOut()));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/stale|already stamped/);
      expect(snapshotTree(project)).toEqual(before);
    });
  });

  describe("--help", () => {
    it("documents --upgrade --stamp as also valid straight away when --upgrade reports nothing to apply", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      main(["--help"]);

      // line wrapping is the implementer's call: compare on collapsed whitespace
      const text = String(log.mock.calls[0]?.[0]).replace(/\s+/g, " ");
      expect(text).toContain(
        "--upgrade --stamp, run once the plan is applied (or straight away when --upgrade reports nothing to apply), re-hashes the plan's files and writes only the manifest.",
      );
    });
  });

  describe("usage errors (exit 2)", () => {
    it("rejects --stamp without --upgrade, saying it needs --upgrade, writing nothing", () => {
      buildProject();
      const before = snapshotTree(project);

      const thrown = thrownBy(() =>
        main([project, "--stamp"], "linux", recordingOut()),
      );

      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toContain("--stamp");
      expect((thrown as Error).message).toMatch(/needs --upgrade/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it.each([
      [["--name", "widgets"], "--name"],
      [["--force"], "--force"],
      [["--pack", "harness-extras"], "--pack"],
      [["--skip-install"], "--skip-install"],
    ])(
      "rejects %j alongside --upgrade --stamp as having no effect in upgrade mode",
      (extra: string[], flag: string) => {
        projectWithStagedUpgrade();
        const before = snapshotTree(project);

        const thrown = thrownBy(() =>
          main(stampArgs(...extra), "linux", recordingOut()),
        );

        expect(thrown).toBeInstanceOf(CliUsageError);
        expect((thrown as Error).message).toContain(flag);
        expect((thrown as Error).message).toMatch(/no effect in upgrade mode/);
        expect(snapshotTree(project)).toEqual(before);
      },
    );

    it("rejects --json alongside --upgrade --stamp", () => {
      projectWithStagedUpgrade();
      const before = snapshotTree(project);

      const thrown = thrownBy(() =>
        main(stampArgs("--json"), "linux", recordingOut()),
      );

      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toContain("--json");
      expect((thrown as Error).message).not.toMatch(/unrecognized option/);
      expect(snapshotTree(project)).toEqual(before);
    });

    it.each(["--adopt", "--fresh"])(
      "rejects --upgrade --stamp combined with %s",
      (other) => {
        projectWithStagedUpgrade();
        const thrown = thrownBy(() =>
          main(stampArgs(other), "linux", recordingOut()),
        );
        expect(thrown).toBeInstanceOf(CliUsageError);
        expect((thrown as Error).message).not.toMatch(/unrecognized option/);
      },
    );

    it("rejects a target directory that does not exist, creating nothing", () => {
      const missing = join(base, "missing");
      const thrown = thrownBy(() =>
        main([missing, "--upgrade", "--stamp"], "linux", recordingOut()),
      );
      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toMatch(/does not exist/);
      expect(existsSync(missing)).toBe(false);
    });

    it("rejects a target that is not a directory", () => {
      const file = join(base, "a-file");
      writeFileSync(file, "x");
      const thrown = thrownBy(() =>
        main([file, "--upgrade", "--stamp"], "linux", recordingOut()),
      );
      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toMatch(/not a directory/);
    });

    it("refuses a project with no manifest with the same advice as --upgrade, writing nothing", () => {
      mkdirSync(project);
      writeFileSync(join(project, "package.json"), '{"name":"legacy"}\n');
      const before = snapshotTree(project);

      const thrown = thrownBy(() => main(stampArgs(), "linux", recordingOut()));

      expect(thrown).toBeInstanceOf(CliUsageError);
      const cause = (thrown as Error).cause;
      expect(cause).toBeInstanceOf(UpgradeStampError);
      expect((cause as UpgradeStampError).code).toBe("no-manifest");
      const message = (thrown as Error).message;
      expect(message).toContain("manifest");
      expect(message).toContain("npx @monte3l/groundwork .");
      expect(message).toContain("/customize");
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses a project with a manifest but no plan, telling the user to run --upgrade first", () => {
      buildProject();
      const before = snapshotTree(project);

      const thrown = thrownBy(() => main(stampArgs(), "linux", recordingOut()));

      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toContain(
        "no plan to stamp -- run --upgrade first",
      );
      expect(snapshotTree(project)).toEqual(before);
      expect(calls).toEqual({ render: 0, compute: 0, stage: 0 });
    });
  });

  describe("runtime failures (exit 1)", () => {
    it("propagates a corrupt manifest as a ManifestError", () => {
      projectWithStagedUpgrade();
      writeFileSync(manifestFile(), "{ not json");
      const before = snapshotTree(project);

      const thrown = thrownBy(() => main(stampArgs(), "linux", recordingOut()));

      expect(thrown).toBeInstanceOf(ManifestError);
      expect(snapshotTree(project)).toEqual(before);
    });

    it("refuses a malformed plan with a plain Error, not a usage error", () => {
      projectWithStagedUpgrade();
      writeFileSync(
        join(project, ".groundwork", "upgrade", "plan.json"),
        "{ broken",
      );
      const before = snapshotTree(project);

      const thrown = thrownBy(() => main(stampArgs(), "linux", recordingOut()));

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toContain("plan.json");
      expect(snapshotTree(project)).toEqual(before);
    });
  });

  describe("documentation of the flag", () => {
    it("lists --stamp in the --help text", () => {
      const log = vi.mocked(console.log);
      main(["--help"], "linux", recordingOut());
      const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("--stamp");
    });

    it("documents --stamp as a row of the README flags table", () => {
      const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
      expect(readme).toMatch(/^\| `--stamp`\s+\|/m);
    });

    it("names --stamp in the usage error for an unknown option", () => {
      const thrown = thrownBy(() =>
        main([project, "--bogus"], "linux", recordingOut()),
      );
      expect(thrown).toBeInstanceOf(CliUsageError);
      expect((thrown as Error).message).toContain("--stamp");
    });
  });
});
