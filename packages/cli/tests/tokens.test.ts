import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { templatesCoreDir } from "../src/main.js";
import { applyTokens } from "../src/tokens.js";

describe("applyTokens", () => {
  it("replaces every occurrence of a known token", () => {
    const result = applyTokens("name: __PROJECT_NAME__ (__PROJECT_NAME__)", {
      PROJECT_NAME: "widgets",
    });
    expect(result).toBe("name: widgets (widgets)");
  });

  it("substitutes multiple distinct tokens independently", () => {
    const result = applyTokens("__A__-__B__", { A: "1", B: "2" });
    expect(result).toBe("1-2");
  });

  it("leaves an unmatched __TOKEN__-shaped literal untouched", () => {
    const result = applyTokens("keep __UNKNOWN__ as-is", { PROJECT_NAME: "x" });
    expect(result).toBe("keep __UNKNOWN__ as-is");
  });

  it("returns the content unchanged when the token table is empty", () => {
    const result = applyTokens("plain text", {});
    expect(result).toBe("plain text");
  });
});

describe("emitted templates", () => {
  // Prettier rewrites Markdown `__EMPHASIS__` to `**EMPHASIS**`, and
  // applyTokens only matches the literal `__KEY__` form -- so a token that
  // Prettier has normalized is silently emitted as-is. This once shipped a
  // literal `# **PROJECT_NAME**` heading in every bootstrapped README.
  it("carries no token that Prettier has normalized to bold", () => {
    const templatesDir = dirname(templatesCoreDir());
    const mangled = /\*\*(PROJECT_NAME|YEAR)\*\*/;
    const offenders = readdirSync(templatesDir, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.includes("node_modules"))
      .filter((path) => mangled.test(readFileSync(path, "utf8")));

    expect(offenders).toEqual([]);
  });
});
