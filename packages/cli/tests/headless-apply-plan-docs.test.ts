// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The `--apply` documentation states the completeness and exit-code
 * behaviour the dry run has (plain string matches, whitespace-normalized
 * because Markdown wraps lines).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

interface NpmReadmeLib {
  buildNpmReadme(rootReadme: string, repositoryUrl: string): string;
}
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "npm-readme.mjs")).href
)) as NpmReadmeLib;

const flat = (text: string): string => text.replace(/\s+/gu, " ");
const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
const npmReadme = lib.buildNpmReadme(
  rootReadme,
  "git+https://github.com/monte3l/m3l-groundwork.git",
);

describe.each([
  ["README.md", rootReadme],
  ["packages/cli/README.md (generated)", npmReadme],
])("%s", (_name, text) => {
  const lines = text.split("\n");
  const applyRow = lines.find((l) =>
    l.startsWith("| `--apply <answers.json>`"),
  );

  it("tells the caller to fill every decision and empty `pending`", () => {
    expect(applyRow).toBeDefined();
    const row = flat(applyRow ?? "");
    expect(row).toMatch(/every decision/u);
    expect(row).toMatch(/empty[^|]*`pending`/u);
  });

  it("has an exit-1 row for --apply with --dry-run", () => {
    const row = lines.find(
      (l) =>
        /^\|[^|]*`--apply`[^|]*`--dry-run`[^|]*\|\s*1\s*\|/u.test(l) &&
        !/^\|[^|]*without/u.test(l),
    );
    expect(row).toBeDefined();
  });
});

describe(".claude/rules/headless-mode.md", () => {
  const rules = flat(
    readFileSync(
      join(repoRoot, ".claude", "rules", "headless-mode.md"),
      "utf8",
    ),
  );

  it("says the planner finds a changed project file after the completeness check", () => {
    expect(rules).toMatch(
      /changed project file[^.]*after the completeness check/u,
    );
    expect(rules).toMatch(
      /pending decisions plus a changed project file[^.]*exit(s)? 3/u,
    );
  });

  it("says a staged copy changed after the survey is an ApplyError, exit 1", () => {
    expect(rules).toMatch(
      /staged copy[^.]*changed after the survey[^.]*`?ApplyError`?[^.]*exit 1/u,
    );
  });
});
