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
 * Every pack's recommendation for the given interview answers. `answers`
 * is currently unused by `harness-extras` (its recommendation doesn't vary
 * by kind), but the parameter exists now so a future kind-scoped pack (e.g.
 * a `publishing` pack recommended only for `kind: "library"`) needs no API
 * change here.
 */
export function recommendPacks(
  _answers: InterviewAnswers,
): PackRecommendation[] {
  return [recommendHarnessExtras()];
}
