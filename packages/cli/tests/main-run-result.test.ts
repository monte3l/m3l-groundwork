// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * main() returns a RunResult for fresh and adopt runs (and undefined for the
 * help/version/list-packs paths). Mocked like main-run.test.ts.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as InventoryModule from "../src/inventory.js";
import type * as ReportModule from "../src/report.js";
import type * as PacksModule from "../src/packs.js";
import type { Out } from "../src/output.js";
import type { RunResult } from "../src/run-result.js";
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
const { injected } = vi.hoisted(() => ({
  injected: new Map<
    string,
    { setupSteps?: string[]; budget?: Record<string, number> }
  >(),
}));

vi.mock("../src/packs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PacksModule>();
  return {
    ...actual,
    loadPack: (...args: Parameters<typeof actual.loadPack>) => {
      const pack = actual.loadPack(...args);
      const extra = injected.get(pack.manifest.name);
      return extra === undefined
        ? pack
        : { ...pack, manifest: { ...pack.manifest, ...extra } };
    },
  };
});

// eslint-disable-next-line no-control-regex -- stripping ANSI colour escapes from painted output
const ANSI = /\u001b\[[0-9;]*m/g;

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

const { main } = await import("../src/main.js");

describe("main return value (RunResult)", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "main-run-result-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    injected.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("returns a fresh RunResult with no next step for a plain fresh run", () => {
    const target = join(targetDir, "fresh");

    const result = main([target, "--skip-install"]);

    expect(result).toEqual({
      mode: "fresh",
      target,
      warnings: [],
      setupSteps: [],
      nextStep: null,
    });
  });

  it("returns an adopt RunResult carrying the printed next step", () => {
    const project = join(targetDir, "existing");
    mkdirSync(project);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );

    const result = main([project]);

    expect(result).toMatchObject({
      mode: "adopt",
      target: project,
      warnings: [],
      setupSteps: [],
    });
    expect(typeof result?.nextStep).toBe("string");
    expect(result?.nextStep).toMatch(/^Next: /);
  });

  it("groups a pack's setupSteps per pack, in the (alphabetical) order packs are installed", () => {
    injected.set("publishing", { setupSteps: ["pnpm a", "pnpm b"] });
    injected.set("licensing", { setupSteps: ["git add -A"] });

    const result = main([
      join(targetDir, "fresh"),
      "--skip-install",
      "--pack",
      "publishing",
      "--pack",
      "licensing",
    ]);

    expect(result?.setupSteps).toEqual([
      { pack: "licensing", steps: ["git add -A"] },
      { pack: "publishing", steps: ["pnpm a", "pnpm b"] },
    ]);
    expectTypeOf(result).toEqualTypeOf<RunResult | undefined>();
    expectTypeOf<RunResult["setupSteps"]>().toEqualTypeOf<
      readonly { pack: string; steps: readonly string[] }[]
    >();
    expectTypeOf<RunResult["warnings"]>().toEqualTypeOf<readonly string[]>();
  });

  it("reports the unpainted over-cap summary as a warning", () => {
    injected.set("publishing", {
      budget: { agents: 99, skills: 99, hooks: 99, workflows: 99, scripts: 99 },
    });
    const log = vi.mocked(console.log);

    const result = main([
      join(targetDir, "fresh"),
      "--skip-install",
      "--pack",
      "publishing",
    ]);

    const printed = log.mock.calls
      .map((call) => String(call[0]).replace(ANSI, ""))
      .filter((line) => line.includes("over cap"));
    expect(printed).toHaveLength(1);
    expect(result?.warnings).toEqual([printed[0]]);
    expect(result?.warnings[0]).not.toMatch(ANSI);
  });

  it("routes fresh status lines through the supplied Out, not console.log", () => {
    const out = {
      info: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
    } satisfies Out;
    const log = vi.mocked(console.log);

    main([join(targetDir, "fresh"), "--skip-install"], "linux", out);

    expect(out.success).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("is ready at"),
    );
    expect(out.info).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("routes the adopt Next: line through the supplied Out.info, not console.log", () => {
    const project = join(targetDir, "existing");
    mkdirSync(project);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    const out = {
      info: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
    } satisfies Out;
    const log = vi.mocked(console.log);

    const result = main([project], "linux", out);

    expect(out.info).toHaveBeenCalledWith(result?.nextStep);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([["--help"], ["--version"], ["--list-packs"]])(
    "returns undefined for %s",
    (flag) => {
      expect(main([flag])).toBeUndefined();
    },
  );
});
