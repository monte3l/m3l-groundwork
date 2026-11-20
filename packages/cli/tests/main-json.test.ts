// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `--json` run behaviour at the main() seam: child processes get
 * ["ignore", 2, 2], the three warning-painted lines go through Out.notice
 * (never Out.info), version/packs print one JSON document, --help keeps its
 * usage text. Division of labour pinned here: main() returns the RunResult
 * and writes NO report itself for fresh/adopt (the bin builds the report from
 * the result and writes it exactly once); main() itself prints the small
 * version/packs documents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PacksModule from "../src/packs.js";
import type { Out } from "../src/output.js";
import type { InstallPluginResult } from "../src/plugin.js";

const gitInitMock = vi.fn();
const runInstallMock = vi.fn();
const installCustomizeSkillMock = vi.fn((): InstallPluginResult => ({
  filesWritten: [],
}));

const { injected } = vi.hoisted(() => ({
  injected: new Map<
    string,
    { setupSteps?: string[]; budget?: Record<string, number> }
  >(),
}));

vi.mock("../src/git.js", () => ({
  gitInit: gitInitMock,
  runInstall: runInstallMock,
}));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: installCustomizeSkillMock,
  installCustomizeSkillGuarded: vi.fn(() => ({
    filesWritten: [],
    location: "claude" as const,
  })),
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

const { main } = await import("../src/main.js");
const { listPackNames, loadPack } = await import("../src/packs.js");
const { resolveCliVersion } = await import("../src/inventory.js");

function recordingOut(): Out & {
  calls: {
    info: string[];
    notice: string[];
    warn: string[];
    success: string[];
  };
} {
  const calls = {
    info: [] as string[],
    notice: [] as string[],
    warn: [] as string[],
    success: [] as string[],
  };
  return {
    calls,
    info: (m) => calls.info.push(m),
    notice: (m) => calls.notice.push(m),
    warn: (m) => calls.warn.push(m),
    success: (m) => calls.success.push(m),
  };
}

const OVER_CAP = {
  agents: 99,
  skills: 99,
  hooks: 99,
  workflows: 99,
  scripts: 99,
};

describe("main under --json", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "main-json-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    injected.clear();
    gitInitMock.mockReset();
    runInstallMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes stdio [ignore, 2, 2] to gitInit and runInstall", () => {
    const target = join(dir, "fresh");

    main([target, "--json"], "linux", recordingOut());

    expect(gitInitMock).toHaveBeenCalledExactlyOnceWith(target, [
      "ignore",
      2,
      2,
    ]);
    expect(runInstallMock).toHaveBeenCalledExactlyOnceWith(target, [
      "ignore",
      2,
      2,
    ]);
  });

  it("leaves the child stdio untouched without --json (human mode unchanged)", () => {
    const target = join(dir, "fresh");

    main([target], "linux", recordingOut());

    expect(gitInitMock).toHaveBeenCalledExactlyOnceWith(target);
    expect(runInstallMock).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("returns the RunResult and writes nothing to console.log or process.stdout for a fresh run", () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const target = join(dir, "fresh");

    const result = main([target, "--json", "--skip-install"]);

    expect(result).toMatchObject({ mode: "fresh", target });
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("routes the over-cap summary through Out.notice, not Out.info", () => {
    injected.set("publishing", { budget: OVER_CAP });
    const out = recordingOut();

    main(
      [join(dir, "f"), "--json", "--skip-install", "--pack", "publishing"],
      "linux",
      out,
    );

    expect(out.calls.notice.filter((l) => l.includes("over cap"))).toHaveLength(
      1,
    );
    expect(out.calls.info.filter((l) => l.includes("over cap"))).toHaveLength(
      0,
    );
  });

  it("routes the pack setup block through Out.notice, not Out.info", () => {
    injected.set("publishing", { setupSteps: ["pnpm add -D thing"] });
    const out = recordingOut();

    main(
      [join(dir, "f"), "--json", "--skip-install", "--pack", "publishing"],
      "linux",
      out,
    );

    expect(
      out.calls.notice.filter((l) => l.includes("pnpm add -D thing")),
    ).toHaveLength(1);
    expect(
      out.calls.info.filter((l) => l.includes("pnpm add -D thing")),
    ).toHaveLength(0);
  });

  it("routes the install-failure line (and the setup block) through Out.notice, then throws", () => {
    injected.set("publishing", { setupSteps: ["pnpm add -D thing"] });
    runInstallMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const out = recordingOut();
    const target = join(dir, "f");

    expect(() =>
      main([target, "--json", "--pack", "publishing"], "linux", out),
    ).toThrowError(/pnpm install/);

    expect(
      out.calls.notice.filter((l) =>
        l.includes("dependencies are not installed"),
      ),
    ).toHaveLength(1);
    expect(
      out.calls.info.filter((l) =>
        l.includes("dependencies are not installed"),
      ),
    ).toHaveLength(0);
    expect(out.calls.notice.some((l) => l.includes("pnpm add -D thing"))).toBe(
      true,
    );
  });

  it("uses Out.notice in human mode too (the Out decides the destination)", () => {
    injected.set("publishing", {
      budget: OVER_CAP,
      setupSteps: ["pnpm add -D t"],
    });
    const out = recordingOut();

    main(
      [join(dir, "f"), "--skip-install", "--pack", "publishing"],
      "linux",
      out,
    );

    expect(out.calls.notice.some((l) => l.includes("over cap"))).toBe(true);
    expect(out.calls.notice.some((l) => l.includes("pnpm add -D t"))).toBe(
      true,
    );
  });

  it("runs an adopt survey under --json: returns the RunResult, console.log untouched", () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const project = join(dir, "existing");
    mkdirSync(project);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );

    const result = main([project, "--json"]);

    expect(result).toMatchObject({ mode: "adopt", target: project });
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});

describe("main --version / --list-packs / --help with --json", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function onlyDocument(): unknown {
    const log = vi.mocked(console.log);
    expect(log).toHaveBeenCalledOnce();
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).not.toContain("\n");
    return JSON.parse(text) as unknown;
  }

  it("--version --json prints one groundwork.version document", () => {
    expect(main(["--version", "--json"])).toBeUndefined();
    expect(onlyDocument()).toEqual({
      schema: "groundwork.version",
      schemaVersion: 1,
      cliVersion: resolveCliVersion(),
    });
  });

  it("--version without --json still prints the bare version", () => {
    main(["--version"]);
    expect(vi.mocked(console.log)).toHaveBeenCalledExactlyOnceWith(
      resolveCliVersion(),
    );
  });

  it("--list-packs --json prints one groundwork.packs document, one entry per pack in listing order", () => {
    expect(main(["--list-packs", "--json"])).toBeUndefined();
    const doc = onlyDocument() as {
      schema: string;
      schemaVersion: number;
      packs: { name: string; modes: string[]; description: string }[];
    };
    expect(doc.schema).toBe("groundwork.packs");
    expect(doc.schemaVersion).toBe(1);
    const names = listPackNames();
    expect(doc.packs.map((p) => p.name)).toEqual(names);
    expect(names.length).toBeGreaterThan(0);
    for (const entry of doc.packs) {
      const manifest = loadPack(entry.name).manifest;
      expect(entry.modes).toEqual(manifest.modes);
      expect(entry.description).toBe(manifest.description);
    }
  });

  it("--help --json still prints the usage text, not JSON", () => {
    main(["--help", "--json"]);
    const log = vi.mocked(console.log);
    expect(log).toHaveBeenCalledOnce();
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toMatch(/^usage: m3l-groundwork/);
    expect(() => {
      JSON.parse(text);
    }).toThrow();
  });
});
