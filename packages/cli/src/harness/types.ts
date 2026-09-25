// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shapes shared by the harness grader. `structural` findings are defects in
 * the harness's own wiring (a hook that points at nothing, a skill with no
 * frontmatter) and fail a gate; `rubric` findings are quality judgements
 * distilled from Anthropic's published guidance and only ever warn -- a
 * subjective rule must never block a push.
 */

/** How severe a finding is: `structural` fails the gate; `rubric` only ever warns. */
export type RuleLevel = "structural" | "rubric";

/** Which area of the harness (settings, hooks, skills, agents, rules, claude-md) a finding is about. */
export type HarnessCategory =
  "settings" | "hooks" | "skills" | "agents" | "rules" | "claude-md";

/** Every {@link HarnessCategory}, as an ordered list -- so rubric tallies are iterated in a fixed order. */
export const HARNESS_CATEGORIES: readonly HarnessCategory[] = [
  "settings",
  "hooks",
  "skills",
  "agents",
  "rules",
  "claude-md",
];

/** One rule's result against one subject. */
export interface HarnessFinding {
  /** The id of the rule this finding came from. */
  ruleId: string;
  /** Whether this finding fails the gate (`structural`) or only warns (`rubric`). */
  level: RuleLevel;
  /** Which harness area this finding is about. */
  category: HarnessCategory;
  /** The file, skill, agent, or registration the finding is about. */
  subject: string;
  /** Human-readable description of what the rule found. */
  message: string;
}

/** How many subjects a set of rules examined, and how many of those failed. */
export interface CheckTally {
  /** How many subjects the rules examined. */
  checked: number;
  /** How many of the examined subjects failed. */
  failed: number;
}

/** The full result of grading one project's harness. */
export interface HarnessGrade {
  /** Every finding from every rule, in rule order. */
  findings: HarnessFinding[];
  /** The tally of structural checks: how many were checked and how many failed. */
  structural: CheckTally;
  /** Rubric tallies per category -- the absolute-quality measurement. */
  rubric: Record<HarnessCategory, CheckTally>;
  /** `1 - failed/checked` over every rubric check; `1` when nothing was checked. */
  rubricScore: number;
}
