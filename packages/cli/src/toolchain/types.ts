// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shapes shared by the toolchain grader. Same two-level model as the harness
 * grader (`../harness/types.ts`): `structural` findings are pass/fail wiring
 * defects `tsc` and ESLint do not catch, and fail a gate. `rubric` findings
 * are quality judgements scored against a checklist rather than pass/fail
 * wiring checks; that checklist encodes the floor -- the minimum baseline of
 * practice current official TypeScript / typescript-eslint guidance
 * recommends -- and a rubric finding only ever warns.
 */
import type { CheckTally, RuleLevel } from "../harness/types.js";

/** The toolchain area a rule or finding belongs to (tsconfig, modules, eslint, testing, gates, deps). */
export type ToolchainCategory =
  "tsconfig" | "modules" | "eslint" | "testing" | "gates" | "deps";

/** Every {@link ToolchainCategory}, as an ordered list -- so rubric tallies are iterated in a fixed order. */
export const TOOLCHAIN_CATEGORIES: readonly ToolchainCategory[] = [
  "tsconfig",
  "modules",
  "eslint",
  "testing",
  "gates",
  "deps",
];

/** One rule's result against one subject. */
export interface ToolchainFinding {
  /** The id of the rule this finding came from. */
  ruleId: string;
  /** Whether this finding fails the gate (`structural`) or only warns (`rubric`). */
  level: RuleLevel;
  /** Which toolchain area this finding is about. */
  category: ToolchainCategory;
  /** The file, package, or verify step the finding is about. */
  subject: string;
  /** Human-readable description of what the rule found. */
  message: string;
}

/** The full result of grading one project's toolchain. */
export interface ToolchainGrade {
  /** Every finding from every rule, in rule order. */
  findings: ToolchainFinding[];
  /** The tally of structural checks: how many were checked and how many failed. */
  structural: CheckTally;
  /** Rubric tallies per category -- the absolute-quality measurement. */
  rubric: Record<ToolchainCategory, CheckTally>;
  /** `1 - failed/checked` over every rubric check; `1` when nothing was checked. */
  rubricScore: number;
}
