import { describe, expect, it } from "vitest";
import type { FileConflict } from "../../src/conflicts.js";
import { summarizeToolchainConformance } from "../../src/toolchain/conformance.js";

const conflict = (
  relPath: string,
  status: FileConflict["status"],
): FileConflict => ({ relPath, status, keyDiffs: undefined });

describe("summarizeToolchainConformance", () => {
  it("counts only toolchain-scoped files", () => {
    const summary = summarizeToolchainConformance([
      conflict("tsconfig.base.json", "divergent"),
      conflict("tsconfig.json", "identical"),
      conflict("eslint.config.js", "absent"),
      conflict("vitest.config.ts", "divergent"),
      conflict("package.json", "identical"),
      conflict(".node-version", "absent"),
      conflict("bin/check-toolchain.mjs", "absent"),
      conflict(".github/workflows/ci.yml", "divergent"),
      conflict(".claude/settings.json", "divergent"),
      conflict("CLAUDE.md", "absent"),
      conflict("src/index.ts", "divergent"),
    ]);
    expect(summary).toEqual({
      identical: 2,
      divergent: 3,
      absent: 3,
      divergentFiles: [
        "tsconfig.base.json",
        "vitest.config.ts",
        ".github/workflows/ci.yml",
      ],
      absentFiles: [
        "eslint.config.js",
        ".node-version",
        "bin/check-toolchain.mjs",
      ],
    });
  });

  it("is all zeros for an empty plan", () => {
    expect(summarizeToolchainConformance([])).toEqual({
      identical: 0,
      divergent: 0,
      absent: 0,
      divergentFiles: [],
      absentFiles: [],
    });
  });
});
