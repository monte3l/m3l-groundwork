// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

interface NpmReadmeLib {
  buildNpmReadme(rootReadme: string, repositoryUrl: string): string;
  repoWebUrl(repositoryUrl: string): string;
  NPM_README_BANNER: string;
}

const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "npm-readme.mjs")).href
)) as NpmReadmeLib;
const { NPM_README_BANNER } = lib;
const buildNpmReadme = (text: string, url: string): string =>
  lib.buildNpmReadme(text, url);
const repoWebUrl = (url: string): string => lib.repoWebUrl(url);

const REPO = "git+https://github.com/acme/widget.git";
const BASE = "https://github.com/acme/widget";

/** Body of the output, with the banner and its blank line removed. */
function body(input: string): string {
  const out = buildNpmReadme(input, REPO);
  return out.slice(NPM_README_BANNER.length + 1);
}

describe("repoWebUrl", () => {
  it.each([
    ["git+https://github.com/acme/widget.git", BASE],
    ["https://github.com/acme/widget.git", BASE],
    ["git+https://github.com/acme/widget", BASE],
    [BASE, BASE],
  ])("turns %s into %s", (input, expected) => {
    expect(repoWebUrl(input)).toBe(expected);
  });
});

describe("buildNpmReadme output shape", () => {
  it("starts with the banner, then a blank line, then the body", () => {
    const out = buildNpmReadme("# Title\n", REPO);
    expect(out.startsWith(NPM_README_BANNER + "\n# Title\n")).toBe(true);
    expect(out).toBe(`${NPM_README_BANNER}\n# Title\n`);
  });
});

describe("buildNpmReadme link rewriting", () => {
  it.each([
    ["[a](docs/x.md)", `[a](${BASE}/blob/main/docs/x.md)`],
    ["[a](./docs/x.md)", `[a](${BASE}/blob/main/docs/x.md)`],
    ["[a](docs/x.md#frag)", `[a](${BASE}/blob/main/docs/x.md#frag)`],
    ['[a](docs/x.md "Title")', `[a](${BASE}/blob/main/docs/x.md "Title")`],
    ["![img](design/logo.svg)", `![img](${BASE}/blob/main/design/logo.svg)`],
    [
      "[a](docs/x.md) and [b](LICENSE)",
      `[a](${BASE}/blob/main/docs/x.md) and [b](${BASE}/blob/main/LICENSE)`,
    ],
  ])("rewrites %s", (input, expected) => {
    expect(body(input)).toBe(expected);
  });

  it.each([
    "[a](#anchor)",
    "[a](https://example.com/x.md)",
    "[a](mailto:me@example.com)",
    "text with `[a](docs/x.md)` in a code span",
    "``[a](docs/x.md)`` double-tick span",
  ])("leaves %s untouched", (input) => {
    expect(body(input)).toBe(input);
  });

  it("rewrites a link outside a code span on a line that also has one", () => {
    expect(body("`code` [a](docs/x.md)")).toBe(
      `\`code\` [a](${BASE}/blob/main/docs/x.md)`,
    );
  });

  it.each(["```", "~~~"])(
    "leaves links inside a %s fenced block and resumes after it",
    (fence) => {
      const input = [
        "[before](a.md)",
        fence,
        "[inside](b.md)",
        fence,
        "[after](c.md)",
      ].join("\n");
      expect(body(input)).toBe(
        [
          `[before](${BASE}/blob/main/a.md)`,
          fence,
          "[inside](b.md)",
          fence,
          `[after](${BASE}/blob/main/c.md)`,
        ].join("\n"),
      );
    },
  );

  it("does not close a backtick fence with a tilde fence", () => {
    const input = ["```", "~~~", "[inside](b.md)", "```"].join("\n");
    expect(body(input)).toBe(input);
  });
});

describe("buildNpmReadme fence closing", () => {
  it("does not close a four-backtick fence with a three-backtick line", () => {
    const input = [
      "````",
      "[a](x.md)",
      "```",
      "[b](y.md)",
      "````",
      "[c](z.md)",
    ].join("\n");
    expect(body(input)).toBe(
      [
        "````",
        "[a](x.md)",
        "```",
        "[b](y.md)",
        "````",
        `[c](${BASE}/blob/main/z.md)`,
      ].join("\n"),
    );
  });

  it("closes a three-backtick fence with a longer fence", () => {
    const input = ["```", "[a](x.md)", "`````", "[c](z.md)"].join("\n");
    expect(body(input)).toBe(
      ["```", "[a](x.md)", "`````", `[c](${BASE}/blob/main/z.md)`].join("\n"),
    );
  });

  it("does not close a fence with a line that has trailing text", () => {
    const input = ["```", "``` js", "[a](x.md)", "```"].join("\n");
    expect(body(input)).toBe(input);
  });
});

describe("buildNpmReadme unsupported forms", () => {
  it.each([
    "[a]: docs/x.md",
    '<a href="docs/x.md">x</a>',
    '<img src="design/l.svg">',
    "[a](<docs/x.md>)",
    "[a](docs/x.md 't')",
    "[a](../x.md)",
  ])("throws on %s", (input) => {
    expect(() => buildNpmReadme(input, REPO)).toThrowError(
      /^npm README: unsupported/,
    );
  });

  it.each([
    '<a href="https://x.dev">x</a>',
    '<img src="https://x.dev/a.svg">',
    "<a href='#top'>x</a>",
  ])("does not throw on absolute or fragment HTML url %s", (input) => {
    expect(() => buildNpmReadme(input, REPO)).not.toThrow();
  });

  it.each([
    "[^1]: footnote",
    '```\n[a]: docs/x.md\n<a href="docs/x.md">\n[a](<docs/x.md>)\n[a](../x.md)\n```',
  ])("does not throw on %s", (input) => {
    expect(() => buildNpmReadme(input, REPO)).not.toThrow();
  });
});

describe("buildNpmReadme over the real README", () => {
  const rootReadme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"),
  ) as { repository: { url: string } };
  const out = buildNpmReadme(rootReadme, pkg.repository.url);

  it("leaves no repo-relative link target outside fences and code spans", () => {
    const relative: string[] = [];
    let inFence = false;
    for (const line of out.split("\n")) {
      // Minimal independent toggle: any fence-looking line flips the state.
      if (/^ {0,3}(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const prose = line.replace(/(`+).*?\1/g, "");
      for (const t of prose.matchAll(/\]\(([^)\s]+)/g)) {
        const target = t[1] ?? "";
        if (/^(?!https?:|#|mailto:)/.test(target)) relative.push(target);
      }
    }
    expect(relative).toEqual([]);
  });

  it("matches the committed packages/cli/README.md's banner", () => {
    const committed = readFileSync(
      join(repoRoot, "packages", "cli", "README.md"),
      "utf8",
    );
    expect(committed.startsWith(NPM_README_BANNER)).toBe(true);
    expect(out.startsWith(NPM_README_BANNER)).toBe(true);
  });
});
