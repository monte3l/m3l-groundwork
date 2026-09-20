/**
 * Shapes shared by the toolchain grader. Same two-level model as the harness
 * grader (`../harness/types.ts`): `structural` findings are wiring defects
 * `tsc` and ESLint do not catch and fail a gate; `rubric` findings are the
 * floor official TypeScript / typescript-eslint guidance sets and only ever
 * warn.
 */
import type { CheckTally, RuleLevel } from "../harness/types.js";

export type ToolchainCategory =
  "tsconfig" | "modules" | "eslint" | "testing" | "gates" | "deps";

export const TOOLCHAIN_CATEGORIES: readonly ToolchainCategory[] = [
  "tsconfig",
  "modules",
  "eslint",
  "testing",
  "gates",
  "deps",
];

export interface ToolchainFinding {
  ruleId: string;
  level: RuleLevel;
  category: ToolchainCategory;
  /** The file, package, or verify step the finding is about. */
  subject: string;
  message: string;
}

export interface ToolchainGrade {
  findings: ToolchainFinding[];
  structural: CheckTally;
  /** Rubric tallies per category -- the absolute-quality measurement. */
  rubric: Record<ToolchainCategory, CheckTally>;
  /** `1 - failed/checked` over every rubric check; `1` when nothing was checked. */
  rubricScore: number;
}
