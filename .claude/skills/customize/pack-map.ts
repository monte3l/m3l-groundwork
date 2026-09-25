// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The pack recommendation table `/customize` reads in Step 1 to pre-select
 * which `templates/packs/` pack(s) to offer, with the evidence shown
 * alongside each recommendation -- the same "inference happens once,
 * visibly, with its reasoning attached" principle `kind-facet-map.ts`
 * documents for project kind. A stored, unit-tested module rather than a
 * judgment made afresh each run, so the same interview answers always
 * produce the same recommendation.
 */
import type { InterviewAnswers } from "./kind-facet-map.js";

export interface PackRecommendation {
  readonly name: string;
  readonly recommended: boolean;
  readonly because: string;
}

/**
 * `harness-extras`'s four artifacts (a type-design-analyzer agent, the
 * compaction-handoff hook pair, a read-only Bash guard, a file-budget gate)
 * are language- and harness-level, not domain-level -- they apply to any
 * TypeScript project regardless of what it's building.
 */
function recommendHarnessExtras(): PackRecommendation {
  return {
    name: "harness-extras",
    recommended: true,
    because:
      "its four artifacts (a type-design review agent, compaction-handoff " +
      "hooks, a read-only Bash guard, a file-budget gate) are language- " +
      "and harness-level, not tied to any particular project kind.",
  };
}

/**
 * `statusline`'s three scripts read only the stdin payload, `.git/HEAD` (via
 * `node:fs`, never a `git` subprocess) and `os.freemem()`/`os.totalmem()` --
 * nothing about any project kind. `statusLine` is also the only documented
 * surface carrying live `context_window.used_percentage`: no hook event
 * receives token or context data, so "when to compact" can live nowhere else.
 */
function recommendStatusline(): PackRecommendation {
  return {
    name: "statusline",
    recommended: true,
    because:
      "statusLine is the only surface that exposes live context-window " +
      "pressure -- no hook event receives token data -- and its scripts " +
      "read only the stdin payload plus local git and memory state, so " +
      "they apply to any project kind. It does occupy five terminal rows.",
  };
}

/**
 * `claude-action`'s workflow assumes only GitHub, which this baseline's
 * whole toolchain (CI, Dependency Review, rulesets) already does -- nothing
 * about any project kind. It is not zero-setup: it adds one GitHub Actions
 * workflow and needs an auth secret the pack cannot create itself.
 */
function recommendClaudeAction(): PackRecommendation {
  return {
    name: "claude-action",
    recommended: true,
    because:
      "the baseline's toolchain already assumes GitHub (CI, Dependency " +
      "Review, rulesets), so a Claude Code Action integration applies to " +
      "any project kind. It does add one GitHub Actions workflow and needs " +
      "an auth secret configured by hand -- the pack cannot create it.",
  };
}

/**
 * Every pack's recommendation for the given interview answers. `answers`
 * is currently unused by any of the three packs (no recommendation varies
 * by kind), but the parameter exists now so a future kind-scoped pack (e.g.
 * a `publishing` pack recommended only for `kind: "library"`) needs no API
 * change here.
 */
export function recommendPacks(
  _answers: InterviewAnswers,
): PackRecommendation[] {
  return [
    recommendHarnessExtras(),
    recommendStatusline(),
    recommendClaudeAction(),
  ];
}
