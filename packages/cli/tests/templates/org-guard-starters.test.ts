// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Pins the org guard starters this repository adopts verbatim from
 * monte3l/.github (`guard-double-background`, `guard-git-push-signed`,
 * `guard-secret-writes` and `bin/lib/signed-range.mjs`): the root copy and the
 * copy `templates/core` emits are the same file apart from the SPDX header, a
 * guard fails closed on a payload it cannot read, and the push guard and its
 * helper are one unit. `templates/**` is excluded from vitest discovery, so the
 * guards are run by path rather than imported.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const core = join(root, "templates", "core");

/**
 * A file's text without its SPDX header lines (the root copies carry them, the
 * template copies do not), with every run of blank lines folded to none: the
 * header's own blank line is the only difference besides the header.
 */
function body(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\/\/ SPDX-/.test(line) && line !== "")
    .join("\n");
}

const HOOKS = [
  "guard-double-background.mjs",
  "guard-git-push-signed.mjs",
  "guard-secret-writes.mjs",
];

describe("org guard starters: root and emitted copies", () => {
  it.each(HOOKS)(
    "%s is the same file in .claude/hooks and templates/core",
    (name) => {
      expect(body(join(root, ".claude", "hooks", name))).toBe(
        body(join(core, ".claude", "hooks", name)),
      );
    },
  );

  it("signed-range.mjs is the same file in bin/lib and templates/core", () => {
    expect(body(join(root, "bin", "lib", "signed-range.mjs"))).toBe(
      body(join(core, "bin", "lib", "signed-range.mjs")),
    );
  });
});

describe("org guard starters: fail closed on a payload they cannot read", () => {
  it.each(HOOKS)("%s exits 2 on text that is not JSON", (name) => {
    const { status, stderr } = spawnSync(
      "node",
      [join(core, ".claude", "hooks", name)],
      {
        input: "this is not json",
        encoding: "utf8",
      },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("could not read the hook payload");
  });
});

describe("org guard starters: the push guard and its helper are one unit", () => {
  const needed = [
    "parseGitPushes",
    "outgoingCommits",
    "unsignedCommits",
    "signingEnabled",
    "gitRunner",
    "trustedRoots",
    "dirsToVet",
  ];

  it.each([
    ["root", join(root, "bin", "lib", "signed-range.mjs")],
    ["emitted", join(core, "bin", "lib", "signed-range.mjs")],
  ])(
    "the %s helper exports every function the push guard loads",
    async (_label, path) => {
      const lib = (await import(pathToFileURL(path).href)) as Record<
        string,
        unknown
      >;
      for (const name of needed) expect(typeof lib[name]).toBe("function");
    },
  );

  it("the push guard lists exactly those helper functions", () => {
    const source = readFileSync(
      join(core, ".claude", "hooks", "guard-git-push-signed.mjs"),
      "utf8",
    );
    const listed =
      /const HELPER_EXPORTS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    expect([...listed.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual(needed);
  });
});
