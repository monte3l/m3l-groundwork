// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// What the CLI tarball ships: packages/cli, packages/plugin and templates/
// (see packages/cli/scripts/vendor-assets.mjs). Everything else must be listed
// under `exclude-paths`, or a `fix` there would cut a release of unchanged code.
const SHIPPED = new Set(["packages", "templates"]);

interface ReleaseConfig {
  packages: Record<string, { "exclude-paths": string[] }>;
}

describe("release-please-config.json", () => {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  ) as ReleaseConfig;
  const excluded = new Set(config.packages["."]?.["exclude-paths"]);

  it("lists every top-level directory that does not ship", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => file.includes("/"))
      .map((file) => file.split("/")[0] as string);
    const directories = [...new Set(tracked)].filter(
      (directory) => !SHIPPED.has(directory),
    );

    expect(directories.filter((directory) => !excluded.has(directory))).toEqual(
      [],
    );
  });

  it("never excludes a directory that ships", () => {
    expect([...excluded].filter((path) => SHIPPED.has(path))).toEqual([]);
  });
});
