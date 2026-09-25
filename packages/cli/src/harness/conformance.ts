// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * How far a project's harness has drifted from `templates/core`'s -- the
 * second number the grader reports, kept separate from rubric quality
 * because `/customize` deliberately rewrites the baseline. "Divergent" is
 * therefore information, never a defect. Derived from the conflict plan
 * `planConflicts` already computed, so no second diff is ever run.
 */
import type { FileConflict } from "../conflicts.js";

export interface HarnessConformance {
  identical: number;
  divergent: number;
  absent: number;
  /** Baseline harness files the project has edited. */
  divergentFiles: string[];
  /** Baseline harness files the project lacks. */
  absentFiles: string[];
}

function isHarnessPath(relPath: string): boolean {
  return relPath.startsWith(".claude/") || relPath === "CLAUDE.md";
}

/** Counts the harness-scoped subset of a baseline conflict plan. */
export function summarizeHarnessConformance(
  conflicts: FileConflict[],
): HarnessConformance {
  const scoped = conflicts.filter((conflict) =>
    isHarnessPath(conflict.relPath),
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
