// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// This test is a structural guarantee, not documentation: it verifies that
// every file under the real templates/core tree (and every packs/*/files
// tree) is claimed by exactly one of typescript-guidance's domain,
// harness-guidance's domain, or an explicit neutral allowlist, via
// classifyPath from src/domain-map.ts. It walks the actual template tree on
// every run (not a fixture), so adding a new file to templates/core that
// matches none of the three glob lists fails this test -- that is the
// intended catch: it stops a new template file from becoming a silent blind
// spot that neither guidance sweep ever sees or updates.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPath } from "../src/domain-map.js";

const templatesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "templates",
);
const templatesCoreDir = join(templatesDir, "core");
const templatesPacksDir = join(templatesDir, "packs");

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

  it("classifies the harness grader's bin/ files as harness-domain despite the bin/*.mjs typescript globs", () => {
    expect(classifyPath("bin/check-harness.mjs")).toBe("harness");
    expect(classifyPath("bin/lib/harness-rules.mjs")).toBe("harness");
    expect(classifyPath("bin/lib/frontmatter.mjs")).toBe("harness");
    expect(classifyPath("bin/check-exports.mjs")).toBe("typescript");
    expect(classifyPath("bin/lib/report.mjs")).toBe("typescript");
  });

  it("classifies the claude-action pack's workflow file as harness-domain despite the .github/workflows/*.yml typescript glob", () => {
    expect(classifyPath(".github/workflows/claude.yml")).toBe("harness");
  });

  it("classifies explicitly neutral files as neutral, not uncovered", () => {
    expect(classifyPath("README.md")).toBe("neutral");
  });

  it("reports an unrecognized path as uncovered", () => {
    expect(classifyPath("some/random/file.xyz")).toBe("uncovered");
  });

  it("classifies common adopt-mode toolchain equivalents as typescript-domain", () => {
    expect(classifyPath(".eslintrc.cjs")).toBe("typescript");
    expect(classifyPath("jest.config.js")).toBe("typescript");
    expect(classifyPath(".husky/pre-commit")).toBe("typescript");
    expect(classifyPath("packages/a/tsconfig.json")).toBe("typescript");
    expect(classifyPath("biome.json")).toBe("typescript");
    expect(classifyPath(".nvmrc")).toBe("typescript");
  });

  it("classifies adopt-mode harness equivalents as harness-domain", () => {
    expect(classifyPath(".claude/commands/deploy.md")).toBe("harness");
    expect(classifyPath(".mcp.json")).toBe("harness");
  });

  it("does not let a broadened typescript glob swallow .claude/settings.json", () => {
    expect(classifyPath(".claude/settings.json")).toBe("harness");
  });

  it("classifies via extraGlobs when the shared lists don't cover a path", () => {
    expect(classifyPath("config/custom-lint.json")).toBe("uncovered");
    expect(
      classifyPath("config/custom-lint.json", {
        typescript: ["config/custom-lint.json"],
      }),
    ).toBe("typescript");
    expect(
      classifyPath("config/custom-hook.md", {
        harness: ["config/custom-hook.md"],
      }),
    ).toBe("harness");
  });

  it("still prefers the shared domain lists over extraGlobs when both would match", () => {
    expect(classifyPath("README.md", { typescript: ["README.md"] })).toBe(
      "neutral",
    );
  });
});

describe("the real templates/core tree", () => {
  it("has no file that falls outside both guidance sweeps' domains", () => {
    const files = listFiles(templatesCoreDir, templatesCoreDir);
    const uncovered = files.filter((f) => classifyPath(f) === "uncovered");
    expect(uncovered, `uncovered files: ${uncovered.join(", ")}`).toEqual([]);
  });
});

describe("every templates/packs/*/files tree", () => {
  it("has no file that falls outside both guidance sweeps' domains", () => {
    if (!existsSync(templatesPacksDir)) return;

    const packNames = readdirSync(templatesPacksDir, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());

    const uncovered: string[] = [];
    for (const pack of packNames) {
      const filesDir = join(templatesPacksDir, pack.name, "files");
      if (!existsSync(filesDir)) continue;
      for (const f of listFiles(filesDir, filesDir)) {
        if (classifyPath(f) === "uncovered") {
          uncovered.push(`${pack.name}/files/${f}`);
        }
      }
    }
    expect(uncovered, `uncovered files: ${uncovered.join(", ")}`).toEqual([]);
  });
});
