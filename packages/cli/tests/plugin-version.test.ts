// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    marketplace: {
      entryName: string | undefined;
      entryVersion: string | undefined;
      sourceIsNpm: boolean;
    };
  };
  setVersion(text: string, version: string): string;
}

const lib = (await import(
  pathToFileURL(join(binDir, "lib", "plugin-version.mjs")).href
)) as PluginVersionLib;

describe("setVersion", () => {
  it("replaces the value and leaves every other byte alone", () => {
    const before =
      '{\n  "name": "x",\n  "version": "1.2.3",\n  "tags": ["a", "b"]\n}\n';

    expect(lib.setVersion(before, "2.0.0-next.1")).toBe(
      '{\n  "name": "x",\n  "version": "2.0.0-next.1",\n  "tags": ["a", "b"]\n}\n',
    );
  });

  it("refuses a file with no version key", () => {
    expect(() => lib.setVersion('{"name":"x"}', "1.0.0")).toThrow(
      /exactly one "version" key, found 0/,
    );
  });

  it("refuses a file where the version would be ambiguous", () => {
    expect(() =>
      lib.setVersion(
        '{"version":"1.0.0","source":{"version":"1.0.0"}}',
        "2.0.0",
      ),
    ).toThrow(/exactly one "version" key, found 2/);
  });
});

describe("the plugin-version gate", () => {
  let root: string;

  /** A throwaway git repo holding just the files the gate reads. */
  function writeFixture(overrides: {
    cli?: string;
    manifest?: string;
    pluginPrivate?: boolean;
    entryName?: string;
    entrySource?: unknown;
    entryVersion?: string;
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

    const entry: Record<string, unknown> = {
      name: overrides.entryName ?? "the-plugin",
      source: overrides.entrySource ?? "./packages/plugin",
    };
    if (overrides.entryVersion !== undefined) {
      entry["version"] = overrides.entryVersion;
    }
    put(".claude-plugin/marketplace.json", {
      name: "mkt",
      plugins: [entry],
    });
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

  it("reads every version, name and source fact from a fixture", () => {
    writeFixture({});

    const versions = lib.readVersions(root);

    expect(versions.cliPackage.version).toBe("1.0.0");
    expect(versions.manifest.version).toBe("1.0.0");
    expect(versions.pluginPackagePrivate).toBe(true);
    expect(versions.marketplace.entryName).toBe("the-plugin");
    expect(versions.marketplace.sourceIsNpm).toBe(false);
    expect(versions.marketplace.entryVersion).toBeUndefined();
  });

  it("passes when everything agrees", () => {
    writeFixture({});

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(0);
    expect(result.output).toContain("plugin.json version is 1.0.0");
    expect(result.output).toContain("stays private");
    expect(result.output).toContain('marketplace entry "the-plugin" matches');
    expect(result.output).toContain("no separate version pin");
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

  it("fails when the marketplace has no entry named after the plugin", () => {
    writeFixture({ entryName: "some-other-name" });

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(1);
    expect(result.output).toContain('no plugin entry named "the-plugin"');
  });

  it("fails when the marketplace source has grown npm shape again", () => {
    writeFixture({
      entrySource: {
        source: "npm",
        package: "@scope/plugin",
        version: "1.0.0",
      },
    });

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(1);
    expect(result.output).toContain("points the plugin at an npm source");
  });

  it("fails when the marketplace entry pins its own version", () => {
    writeFixture({ entryVersion: "1.0.0" });

    const result = run("check-plugin-version.mjs");

    expect(result.status).toBe(1);
    expect(result.output).toContain("pins the plugin to 1.0.0");
    expect(result.output).toContain("inherits plugin.json's version");
  });

  it("sync copies the CLI's version into plugin.json only", () => {
    writeFixture({ cli: "2.0.0-next.0", manifest: "1.0.0" });
    expect(run("check-plugin-version.mjs").status).toBe(1);

    const synced = run("sync-plugin-version.mjs");

    expect(synced.status).toBe(0);
    expect(run("check-plugin-version.mjs").status).toBe(0);
    expect(
      readFileSync(
        join(root, "packages/plugin/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ).toContain('"version": "2.0.0-next.0"');
    // Untouched: the plugin package's own version and the marketplace file.
    expect(
      readFileSync(join(root, "packages/plugin/package.json"), "utf8"),
    ).toContain('"version": "0.0.0"');
  });

  it("sync is a no-op, and silent, when already in step", () => {
    writeFixture({});

    const result = run("sync-plugin-version.mjs");

    expect(result.status).toBe(0);
    expect(result.output).toBe("");
  });
});
