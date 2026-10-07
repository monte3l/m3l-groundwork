// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Fresh mode's consolidated "pack setup required" block (the `setupSteps`
 * pack manifest field). git.js and plugin.js are mocked as in
 * main-run.test.ts; packs.js wraps the real `loadPack`, injecting fixture
 * `setupSteps` for the names in `injectedSteps` so multi-pack ordering is
 * reachable (the real packs root cannot be injected into `main()`, and only
 * `publishing` really declares steps). With `injectedSteps` empty, the real
 * manifests pass through untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PacksModule from "../src/packs.js";
import type { InstallPluginResult } from "../src/plugin.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn((): InstallPluginResult => ({
  filesWritten: [],
}));

const { injectedSteps } = vi.hoisted(() => ({
  injectedSteps: new Map<string, string[]>(),
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
  installCustomizeSkillGuarded: vi.fn(),
}));
vi.mock("../src/packs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PacksModule>();
  return {
    ...actual,
    loadPack: (...args: Parameters<typeof actual.loadPack>) => {
      const pack = actual.loadPack(...args);
      const steps = injectedSteps.get(pack.manifest.name);
      return steps === undefined
        ? pack
        : { ...pack, manifest: { ...pack.manifest, setupSteps: steps } };
    },
  };
});

const { main } = await import("../src/main.js");

/** publishing's setupSteps, as printed (two-space indent), in order. */
const PUBLISHING_COMMANDS = [
  "  pnpm add -D @changesets/cli",
  "  git add -A",
  "  node bin/check-license-headers.mjs --fix",
  "  git add -A",
];

// eslint-disable-next-line no-control-regex -- stripping ANSI colour escapes from painted output
const ANSI = /\u001b\[[0-9;]*m/g;

describe("fresh mode: pack setupSteps block", () => {
  let targetDir: string;
  let lines: string[];

  /** Every console.log call, ANSI-stripped, split into physical lines. */
  function runFresh(args: string[]): void {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    main([targetDir, ...args]);
    lines = logSpy.mock.calls
      .flatMap((call) => String(call[0]).replace(ANSI, "").split("\n"))
      .filter((line) => line.length > 0);
  }

  /** Like runFresh, but for a run that must throw; returns the thrown error. */
  function runFreshFailing(args: string[]): unknown {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let thrown: unknown;
    try {
      main([targetDir, ...args]);
    } catch (error) {
      thrown = error;
    }
    lines = logSpy.mock.calls
      .flatMap((call) => String(call[0]).replace(ANSI, "").split("\n"))
      .filter((line) => line.length > 0);
    return thrown;
  }

  const headingCount = (): number =>
    lines.filter((line) => line.includes("pnpm verify")).length;

  const readyIndex = (): number =>
    lines.findIndex((line) => line.includes("is ready at"));

  beforeEach(() => {
    targetDir = join(mkdtempSync(join(tmpdir(), "main-setup-")), "proj");
    gitInitMock.mockReset();
    runInstallMock.mockReset();
    installCustomizeSkillMock.mockReset();
    installCustomizeSkillMock.mockReturnValue({ filesWritten: [] });
    injectedSteps.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(join(targetDir, ".."), { recursive: true, force: true });
  });

  it("prints, after the ready line, a setup heading naming the target dir, the pack, and each publishing command indented by two spaces", () => {
    runFresh(["--skip-install", "--pack", "publishing"]);

    const ready = readyIndex();
    expect(ready).toBeGreaterThanOrEqual(0);
    const after = lines.slice(ready + 1);
    const heading = after.findIndex(
      (line) => line.includes("pnpm verify") && line.includes(targetDir),
    );
    expect(heading).toBeGreaterThanOrEqual(0);
    const packLine = after.findIndex(
      (line, i) => i > heading && line.includes("publishing"),
    );
    expect(packLine).toBeGreaterThan(heading);
    expect(after.slice(packLine + 1)).toEqual([...PUBLISHING_COMMANDS]);
  });

  it("still prints the block when installing dependencies (no --skip-install)", () => {
    runFresh(["--pack", "publishing"]);

    expect(runInstallMock).toHaveBeenCalledWith(targetDir);
    expect(lines).toContain("  pnpm add -D @changesets/cli");
    expect(readyIndex()).toBeLessThan(
      lines.indexOf("  pnpm add -D @changesets/cli"),
    );
  });

  it("prints nothing extra when the installed pack declares no setupSteps: the ready line is the last output", () => {
    runFresh(["--skip-install", "--pack", "harness-extras"]);

    expect(readyIndex()).toBe(lines.length - 1);
    expect(lines.some((line) => line.includes("pnpm verify"))).toBe(false);
  });

  it("prints nothing extra when no --pack is given", () => {
    runFresh(["--skip-install"]);

    expect(readyIndex()).toBe(lines.length - 1);
    expect(lines.some((line) => line.includes("pnpm verify"))).toBe(false);
  });

  it("does not mention a pack without setupSteps installed beside one that has them", () => {
    runFresh([
      "--skip-install",
      "--pack",
      "harness-extras",
      "--pack",
      "publishing",
    ]);

    const after = lines.slice(readyIndex() + 1);
    expect(after.some((line) => line.includes("publishing"))).toBe(true);
    expect(after.some((line) => line.includes("harness-extras"))).toBe(false);
  });

  it("lists each pack with steps in install order, one consolidated heading, commands under their own pack", () => {
    injectedSteps.set("quality", ["echo quality-1", "echo quality-2"]);
    // parseArgs sorts and de-duplicates --pack values, so packs install
    // alphabetically (publishing before quality) whatever the request order;
    // requesting quality first proves the request order does not decide it.
    runFresh(["--skip-install", "--pack", "quality", "--pack", "publishing"]);

    const after = lines.slice(readyIndex() + 1);
    expect(after.filter((line) => line.includes("pnpm verify"))).toHaveLength(
      1,
    );
    const p = after.findIndex((line) => line.includes("publishing"));
    const p1 = after.indexOf("  pnpm add -D @changesets/cli");
    const p2 = after.lastIndexOf("  git add -A");
    expect(after.indexOf("  node bin/check-license-headers.mjs --fix")).toBe(
      p2 - 1,
    );
    const q = after.findIndex((line) => line.includes("quality"));
    const q1 = after.indexOf("  echo quality-1");
    const q2 = after.indexOf("  echo quality-2");
    expect(p).toBeGreaterThanOrEqual(0);
    expect([p, p1, p2, q, q1, q2]).toEqual(
      [p, p1, p2, q, q1, q2].toSorted((a, b) => a - b),
    );
    expect(new Set([p, p1, p2, q, q1, q2]).size).toBe(6);
  });

  it("prints the same block whichever order the packs are requested in", () => {
    injectedSteps.set("quality", ["echo quality-1"]);
    // The block embeds the target dir, so normalise it before comparing.
    const block = (): string[] =>
      lines
        .slice(readyIndex() + 1)
        .map((line) => line.replaceAll(targetDir, "<target>"));

    runFresh(["--skip-install", "--pack", "publishing", "--pack", "quality"]);
    const forward = block();

    // Drop the first run's console spy, or its calls leak into the second.
    vi.restoreAllMocks();
    const firstDir = targetDir;
    targetDir = join(firstDir, "..", "proj-reversed");
    runFresh(["--skip-install", "--pack", "quality", "--pack", "publishing"]);
    const reversed = block();

    expect(reversed).toEqual(forward);
    expect(forward.indexOf("  pnpm add -D @changesets/cli")).toBeGreaterThan(
      -1,
    );
    expect(forward.indexOf("  pnpm add -D @changesets/cli")).toBeLessThan(
      forward.indexOf("  echo quality-1"),
    );
  });
  describe("failure paths", () => {
    it("prints the block once, before throwing, when runInstall fails", () => {
      runInstallMock.mockImplementation(() => {
        throw new Error("pnpm exploded");
      });

      const thrown = runFreshFailing(["--pack", "publishing"]);

      expect(thrown).toBeInstanceOf(Error);
      expect(headingCount()).toBe(1);
      const heading = lines.findIndex((line) => line.includes("pnpm verify"));
      const packLine = lines.findIndex(
        (line, i) => i > heading && line.includes("publishing"),
      );
      expect(packLine).toBeGreaterThan(heading);
      expect(lines.slice(packLine + 1)).toEqual(PUBLISHING_COMMANDS);
      expect(lines.some((line) => line.includes("is ready at"))).toBe(false);
    });

    it("prints the block once, before throwing, when gitInit fails (runInstall never runs)", () => {
      gitInitMock.mockImplementation(() => {
        throw new Error("git exploded");
      });

      const thrown = runFreshFailing(["--pack", "publishing"]);

      expect((thrown as Error).message).toContain("git init failed");
      expect(runInstallMock).not.toHaveBeenCalled();
      expect(headingCount()).toBe(1);
      const heading = lines.findIndex((line) => line.includes("pnpm verify"));
      const packLine = lines.findIndex(
        (line, i) => i > heading && line.includes("publishing"),
      );
      expect(lines.slice(packLine + 1)).toEqual(PUBLISHING_COMMANDS);
    });

    it("prints no setup heading when runInstall fails and no installed pack has setupSteps", () => {
      runInstallMock.mockImplementation(() => {
        throw new Error("pnpm exploded");
      });

      const thrown = runFreshFailing(["--pack", "harness-extras"]);

      expect(runInstallMock).toHaveBeenCalledWith(targetDir);
      expect((thrown as Error).message).toContain(
        "run `pnpm install` there yourself",
      );
      expect(headingCount()).toBe(0);
    });

    it("prints no setup heading when gitInit fails and no installed pack has setupSteps", () => {
      gitInitMock.mockImplementation(() => {
        throw new Error("git exploded");
      });

      const thrown = runFreshFailing([]);

      expect((thrown as Error).message).toContain("git init failed");
      expect(runInstallMock).not.toHaveBeenCalled();
      expect(headingCount()).toBe(0);
    });

    it("does not print the block when the /customize skill install fails (its message says to re-run)", () => {
      installCustomizeSkillMock.mockImplementation(() => {
        throw new Error("skill exploded");
      });

      const thrown = runFreshFailing(["--pack", "publishing"]);

      expect((thrown as Error).message).toContain("--fresh --force");
      expect(headingCount()).toBe(0);
      expect(lines).not.toContain("  pnpm add -D @changesets/cli");
    });
  });
});
