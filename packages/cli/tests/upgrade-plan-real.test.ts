// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The plan against the real baseline: the project is built by fresh mode's
 * own `main()` (git and the plugin installer mocked, as `main-run.test.ts`
 * does), the clock then moves, and a render plus plan must still find
 * everything `current` -- so the render is neither clock-dependent nor any
 * different from what fresh mode emitted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../src/manifest.js";
import { packsRootDir } from "../src/packs.js";
import { computePlan, renderRelease } from "../src/upgrade/plan.js";
import type { InstallPluginResult } from "../src/plugin.js";

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

const { main, templatesCoreDir } = await import("../src/main.js");

describe("plan against the real baseline", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "upgrade-plan-real-"));
    gitInitMock.mockReset();
    runInstallMock.mockReset();
    installSkillMock.mockReset();
    installSkillMock.mockReturnValue({ filesWritten: [] });
    installGuardedMock.mockReset();
    installGuardedMock.mockReturnValue({
      filesWritten: [],
      location: "claude",
    });
    // main() reports progress on stdout; keep the test output clean.
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {
      /* silence */
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it.each([[[]], [["harness-extras"]], [["harness-extras", "quality"]]])(
    "finds every path and key current after fresh mode and a later clock (packs: %j)",
    (packNames: string[]) => {
      const projectDir = join(base, "project");
      main([
        projectDir,
        "--skip-install",
        ...packNames.flatMap((name) => ["--pack", name]),
      ]);
      const manifest = readManifest(projectDir);
      if (manifest === undefined)
        throw new Error("fresh mode wrote no manifest");
      expect(manifest.packs).toEqual([...packNames].sort());

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2031-06-01"));
      const release = renderRelease({
        manifest,
        cliVersion: manifest.cliVersion,
        templatesDir: templatesCoreDir(),
        packsRoot: packsRootDir(),
        tmpRoot: base,
      });
      try {
        const plan = computePlan({
          targetDir: projectDir,
          manifest,
          release,
          cliVersion: manifest.cliVersion,
        });

        expect(plan.files.length).toBeGreaterThan(50);
        expect(plan.files.filter((e) => e.class !== "current")).toEqual([]);
        const keys = Object.values(plan.jsonKeys).flat();
        expect(Object.keys(plan.jsonKeys)).toContain("package.json");
        expect(keys.length).toBeGreaterThan(5);
        expect(keys.filter((e) => e.class !== "current")).toEqual([]);
      } finally {
        release.dispose();
      }
      expect(
        readdirSync(base).filter((n) => n.startsWith("groundwork-upgrade-")),
      ).toEqual([]);
    },
    60_000,
  );
});
