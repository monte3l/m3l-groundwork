/**
 * Shapes shared by the harness grader. `structural` findings are defects in
 * the harness's own wiring (a hook that points at nothing, a skill with no
 * frontmatter) and fail a gate; `rubric` findings are quality judgements
 * distilled from Anthropic's published guidance and only ever warn -- a
 * subjective rule must never block a push.
 */
export type RuleLevel = "structural" | "rubric";

export type HarnessCategory =
  "settings" | "hooks" | "skills" | "agents" | "rules" | "claude-md";

export const HARNESS_CATEGORIES: readonly HarnessCategory[] = [
  "settings",
  "hooks",
  "skills",
  "agents",
  "rules",
  "claude-md",
];

export interface HarnessFinding {
  ruleId: string;
  level: RuleLevel;
  category: HarnessCategory;
  /** The file, skill, agent, or registration the finding is about. */
  subject: string;
  message: string;
}

/** How many subjects a set of rules examined, and how many of those failed. */
export interface CheckTally {
  checked: number;
  failed: number;
}

export interface HarnessGrade {
  findings: HarnessFinding[];
  structural: CheckTally;
  /** Rubric tallies per category -- the absolute-quality measurement. */
  rubric: Record<HarnessCategory, CheckTally>;
  /** `1 - failed/checked` over every rubric check; `1` when nothing was checked. */
  rubricScore: number;
}
