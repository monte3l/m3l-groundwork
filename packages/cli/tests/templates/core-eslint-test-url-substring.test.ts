// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The emitted `eslint.config.js` bans a substring check on a URL literal in a
 * test, the shape CodeQL's `js/incomplete-url-substring-sanitization` reports
 * there. The config is run for real against text linted as the template's own
 * `tests/index.test.ts` (a path the TypeScript project service knows).
 * `templates/**` is excluded from vitest discovery, so the config is read by
 * path.
 */
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "..", "..", "..", "..", "templates", "core");
const eslint = new ESLint({ cwd: core });

async function restricted(
  code: string,
  filePath = "tests/index.test.ts",
): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(core, filePath),
  });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

describe("templates/core eslint.config.js: URL substring checks in tests", () => {
  it.each(["includes", "startsWith", "endsWith", "indexOf"])(
    "flags `.%s` with an http(s) URL literal",
    async (method) => {
      const found = await restricted(
        `const url = "x";\nvoid url.${method}("https://a.example/path");\n`,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("new URL(x).hostname");
    },
  );

  it("flags an http:// literal too", async () => {
    expect(
      await restricted(
        `const u = "x";\nvoid u.includes("http://a.example");\n`,
      ),
    ).toHaveLength(1);
  });

  it("accepts a parsed host and a non-URL substring", async () => {
    expect(
      await restricted(
        [
          `const u = "https://a.example/x";`,
          `void (new URL(u).hostname === "a.example");`,
          `void u.includes("path");`,
        ].join("\n") + "\n",
      ),
    ).toEqual([]);
  });

  // The selector sees syntax, not types: it cannot tell a string from an array.
  // Known limit; the fix there is the same (compare the parsed value).
  it("also flags Array#includes with a URL literal, since it cannot see types", async () => {
    expect(
      await restricted(`void ["x"].includes("https://a.example");\n`),
    ).toHaveLength(1);
  });

  it("does not apply outside tests", async () => {
    expect(
      await restricted(
        `export const ok = "x".includes("https://a.example");\n`,
        "src/index.ts",
      ),
    ).toEqual([]);
  });
});
