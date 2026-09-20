/**
 * How far a project's toolchain files have drifted from `templates/core`'s --
 * the second number the grader reports, kept separate from rubric quality
 * because `/customize` deliberately rewrites the baseline. "Divergent" is
 * therefore information, never a defect. Derived from the conflict plan
 * `planConflicts` already computed, so no second diff is ever run.
 */
import type { FileConflict } from "../conflicts.js";

export interface ToolchainConformance {
  identical: number;
  divergent: number;
  absent: number;
  /** Baseline toolchain files the project has edited. */
  divergentFiles: string[];
  /** Baseline toolchain files the project lacks. */
  absentFiles: string[];
}

const TOOLCHAIN_FILES = new Set([
  "package.json",
  ".node-version",
  ".prettierrc.json",
  "knip.json",
  "lefthook.yml",
  "vitest.config.ts",
]);

function isToolchainPath(relPath: string): boolean {
  return (
    TOOLCHAIN_FILES.has(relPath) ||
    /^tsconfig(\..+)?\.json$/.test(relPath) ||
    /^eslint\.config\./.test(relPath) ||
    relPath.startsWith("bin/") ||
    relPath.startsWith(".github/workflows/")
  );
}

/** Counts the toolchain-scoped subset of a baseline conflict plan. */
export function summarizeToolchainConformance(
  conflicts: FileConflict[],
): ToolchainConformance {
  const scoped = conflicts.filter((conflict) =>
    isToolchainPath(conflict.relPath),
  );
  const files = (status: FileConflict["status"]): string[] =>
    scoped
      .filter((conflict) => conflict.status === status)
      .map((conflict) => conflict.relPath);
  return {
    identical: files("identical").length,
    divergent: files("divergent").length,
    absent: files("absent").length,
    divergentFiles: files("divergent"),
    absentFiles: files("absent"),
  };
}
