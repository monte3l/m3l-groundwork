import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPath } from "../src/domain-map.js";

const templatesCoreDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "templates",
  "core",
);

function listFiles(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, root));
    } else {
      out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out;
}

describe("classifyPath", () => {
  it("classifies known toolchain files as typescript-domain", () => {
    expect(classifyPath("tsconfig.base.json")).toBe("typescript");
    expect(classifyPath("eslint.config.js")).toBe("typescript");
    expect(classifyPath("bin/verify.mjs")).toBe("typescript");
  });

  it("classifies .claude/ files as harness-domain", () => {
    expect(classifyPath(".claude/settings.json")).toBe("harness");
    expect(classifyPath(".claude/skills/creating-prs/SKILL.md")).toBe(
      "harness",
    );
  });

  it("classifies explicitly neutral files as neutral, not uncovered", () => {
    expect(classifyPath("README.md")).toBe("neutral");
  });

  it("reports an unrecognized path as uncovered", () => {
    expect(classifyPath("some/random/file.xyz")).toBe("uncovered");
  });
});

describe("the real templates/core tree", () => {
  it("has no file that falls outside both guidance sweeps' domains", () => {
    const files = listFiles(templatesCoreDir, templatesCoreDir);
    const uncovered = files.filter((f) => classifyPath(f) === "uncovered");
    expect(uncovered, `uncovered files: ${uncovered.join(", ")}`).toEqual([]);
  });
});
