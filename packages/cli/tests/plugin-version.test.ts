// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "..", "..", "bin");

interface PluginVersionLib {
  readVersions(root: string): {
    cliPackage: { name: string; version: string };
    manifest: { name: string; version: string };
    pluginPackagePrivate: boolean;
    skillMarkers: {
      path: string;
      present: boolean;
      version?: string | undefined;
    }[];
  };
}

const lib = (await import(
  pathToFileURL(join(binDir, "lib", "plugin-version.mjs")).href
)) as PluginVersionLib;

describe("the plugin-version gate", () => {
  let root: string;

  /** A throwaway git repo holding just the files the gate reads. */
  function writeFixture(overrides: {
    cli?: string;
    manifest?: string;
    pluginPrivate?: boolean;
  }): void {
    const put = (rel: string, value: unknown): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
    };
    put("packages/cli/package.json", {
      name: "@scope/cli",
      version: overrides.cli ?? "1.0.0",
    });
    put("packages/plugin/package.json", {
      name: "@scope/plugin",
      version: "0.0.0",
      private: overrides.pluginPrivate ?? true,
    });
    put("packages/plugin/.claude-plugin/plugin.json", {
      name: "the-plugin",
      version: overrides.manifest ?? "1.0.0",
    });
  }

  const markerFiles = [
    "packages/plugin/skills/customize/update.md",
    ".claude/skills/customize/update.md",
  ];

  function putMarkerFile(rel: string, body: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }

  function marker(version: string): string {
    return `# Update\n\nSkill version: ${version} <!-- x-release-please-version -->\n`;
  }

  function run(script: string): { status: number | null; output: string } {
    const result = spawnSync("node", [join(binDir, script)], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plugin-version-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads every version and name fact from a fixture", () => {
    writeFixture({});

    const versions = lib.readVersions(root);

    expect(versions.cliPackage.version).toBe("1.0.0");
    expect(versions.manifest.version).toBe("1.0.0");
    expect(versions.pluginPackagePrivate).toBe(true);
  });

  it("passes when everything agrees", () => {
    writeFixture({});

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(0);
    expect(result.output).toContain("plugin.json version is 1.0.0");
    expect(result.output).toContain("stays private");
  });

  it("fails, naming the file, when plugin.json has drifted from the CLI", () => {
    writeFixture({ manifest: "0.9.0" });

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(1);
    expect(result.output).toMatch(
      /plugin\.json version is 0\.9\.0, but @scope\/cli is 1\.0\.0/,
    );
  });

  it("fails when packages/plugin/package.json is not private", () => {
    writeFixture({ pluginPrivate: false });

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(1);
    expect(result.output).toContain("is not private");
    expect(result.output).toContain("not npm");
  });

  it("reads each update.md copy's marker, flagging absent files", () => {
    writeFixture({});
    putMarkerFile(markerFiles[0] as string, marker("1.0.0"));

    const [first, second] = lib.readVersions(root).skillMarkers;

    expect(first).toMatchObject({ present: true, version: "1.0.0" });
    expect(second).toMatchObject({ present: false });
  });

  it("passes when both marker files match the CLI version", () => {
    writeFixture({});
    for (const rel of markerFiles) putMarkerFile(rel, marker("1.0.0"));

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(0);
    expect(result.output).toContain("Skill version is 1.0.0");
  });

  it("fails when a marker differs from the CLI version", () => {
    writeFixture({});
    putMarkerFile(markerFiles[0] as string, marker("0.9.0"));
    putMarkerFile(markerFiles[1] as string, marker("1.0.0"));

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(1);
    expect(result.output).toMatch(
      /update\.md Skill version is 0\.9\.0, but @scope\/cli is 1\.0\.0/,
    );
  });

  it("fails when a present update.md has no marker line", () => {
    writeFixture({});
    putMarkerFile(markerFiles[0] as string, "# Update\n\nno marker here\n");

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(1);
    expect(result.output).toContain("Skill version is missing");
  });

  it("only warns when the update.md files are absent", () => {
    writeFixture({});

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(0);
    expect(result.output).toContain("is absent");
  });
});
