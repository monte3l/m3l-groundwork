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
 * `harness-extras`'s four original artifacts (a type-design-analyzer agent,
 * the compaction-handoff hook pair, a read-only Bash guard, a file-budget
 * gate) are language- and harness-level, not domain-level -- they apply to
 * any TypeScript project regardless of what it's building. Its folded-in
 * statusLine scripts read only the stdin payload, `.git/HEAD` (via
 * `node:fs`, never a `git` subprocess) and `os.freemem()`/`os.totalmem()`,
 * and `statusLine` is the only documented surface carrying live
 * `context_window.used_percentage`: no hook event receives token or context
 * data, so "when to compact" can live nowhere else.
 */
function recommendHarnessExtras(): PackRecommendation {
  return {
    name: "harness-extras",
    recommended: true,
    because:
      "its four artifacts (a type-design review agent, compaction-handoff " +
      "hooks, a read-only Bash guard, a file-budget gate) are language- " +
      "and harness-level, not tied to any particular project kind; its " +
      "statusLine is the only surface that exposes live context-window " +
      "pressure -- no hook event receives token data -- and reads only the " +
      "stdin payload plus local git and memory state. It does occupy five " +
      "terminal rows (session, model, context, quota, work).",
  };
}

/**
 * `github`'s workflow assumes only GitHub, which this baseline's whole
 * toolchain (CI, Dependency Review, rulesets) already does -- nothing about
 * any project kind. Beyond the mention-mode Action (`claude.yml`) it ships a
 * second workflow, `claude-pr-review.yml`, which posts an automated Claude
 * review comment on every PR, plus three GitHub-operations skills:
 * `reviewing-dependabot-prs` (classifies and batch-merges open Dependabot
 * PRs), `triaging-scan-alerts` (triages open code-scanning alerts to
 * file:line) and `watching-pr-checks`. It is not zero-setup: it adds two
 * GitHub Actions workflows and needs an auth secret the pack cannot create
 * itself.
 */
function recommendGithub(): PackRecommendation {
  return {
    name: "github",
    recommended: true,
    because:
      "the baseline's toolchain already assumes GitHub (CI, Dependency " +
      "Review, rulesets), so a Claude Code Action integration applies to " +
      "any project kind. Alongside the mention-mode Action it adds a " +
      "second workflow (claude-pr-review.yml) that posts an automated " +
      "Claude review comment on every PR, plus skills for classifying and " +
      "batch-merging open Dependabot PRs (reviewing-dependabot-prs), " +
      "triaging open code-scanning alerts to file:line " +
      "(triaging-scan-alerts) and watching a PR's checks " +
      "(watching-pr-checks). It does add two GitHub Actions workflows and " +
      "needs an auth secret configured by hand -- the pack cannot create it.",
  };
}

/**
 * `publishing` is the one kind-scoped pack: a release pipeline (a changesets
 * version PR, then a staged, provenance-attested npm publish via trusted
 * publishing) plus the OpenSSF supply-chain posture that goes with shipping
 * to a registry (gitleaks secret scanning, Scorecard, SPDX/REUSE license
 * headers). A `library` or `cli` typically publishes an npm package; a
 * `frontend` or `service` is typically deployed instead, so it is not
 * pre-selected there -- but it stays on offer. It is fresh-mode only and
 * needs one-time npm and GitHub setup the pack cannot perform itself.
 */
function recommendPublishing(answers: InterviewAnswers): PackRecommendation {
  const recommended = answers.kind === "library" || answers.kind === "cli";
  return {
    name: "publishing",
    recommended,
    because: recommended
      ? "a library or CLI typically ships an npm package, so this pack's " +
        "release pipeline applies: a changesets version PR, then a staged, " +
        "provenance-attested npm publish via trusted publishing -- plus the " +
        "OpenSSF supply-chain posture that goes with publishing (gitleaks " +
        "secret scanning, Scorecard, SPDX/REUSE license headers). It is " +
        "fresh-mode only and needs one-time npm and GitHub setup (the " +
        "trusted publisher, the release credentials) the pack cannot do " +
        "itself."
      : "a frontend or service is typically deployed rather than published " +
        "to a package registry, so a changesets/npm release pipeline is not " +
        "recommended by default -- it is still available if this project " +
        "does publish an npm package.",
  };
}

/**
 * Every pack's recommendation for the given interview answers. Only
 * `publishing` varies by `answers.kind` today; `harness-extras` and
 * `github` are recommended for every kind.
 */
export function recommendPacks(
  answers: InterviewAnswers,
): PackRecommendation[] {
  return [
    recommendHarnessExtras(),
    recommendGithub(),
    recommendPublishing(answers),
  ];
}
