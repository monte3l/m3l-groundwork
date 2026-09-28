// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// This test verifies recommendPacks (src/pack-map.ts), which /customize uses
// to suggest optional templates/packs/* bundles during its interview: given a
// set of interview answers, it must deterministically recommend the same two
// packs (harness-extras, github) across every project kind, and every
// recommendation must carry non-empty "because" evidence and a non-empty
// name. harness-extras now folds in the former statusline pack, so its
// evidence must speak to both halves (the four original artifacts and the
// five-row statusLine/context-window-pressure segment) -- not just restate
// the whole sentence, but name a substring from each half so a future edit
// that silently drops one half's evidence is caught. Without this test, a
// change to pack-map.ts could silently stop recommending a pack for some
// project kind, or return a recommendation with no justification shown to
// the user, or make the mapping non-deterministic across identical answers --
// none of which any other test in this repo would catch.
import { describe, expect, it } from "vitest";
import { recommendPacks } from "../src/pack-map.js";
import type { InterviewAnswers } from "../src/kind-facet-map.js";

const BASE_ANSWERS: InterviewAnswers = {
  kind: "library",
  runtime: "node",
  testsMandatory: true,
  ciDepth: "standard",
  keepAgents: ["code-reviewer"],
};

describe("recommendPacks", () => {
  it("is deterministic: the same answers always produce the same recommendations", () => {
    const first = recommendPacks(BASE_ANSWERS);
    const second = recommendPacks({ ...BASE_ANSWERS });
    expect(second).toEqual(first);
  });

  it("returns exactly four recommendations: harness-extras, github, publishing and worktrees", () => {
    const names = recommendPacks(BASE_ANSWERS).map((r) => r.name);
    expect(names).toEqual([
      "harness-extras",
      "github",
      "publishing",
      "worktrees",
    ]);
  });

  it("recommends worktrees as opt-in (not recommended by default) with non-empty evidence, for every project kind -- it changes the day-to-day workflow rather than being a zero-cost addition", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const worktrees = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "worktrees",
      );
      expect(worktrees).toBeDefined();
      expect(worktrees?.recommended).toBe(false);
      expect(worktrees?.because.length).toBeGreaterThan(0);
    }
  });

  it("recommends harness-extras with evidence naming a substring from both the four original artifacts and the folded-in statusline segment, for every project kind", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const recommendations = recommendPacks({ ...BASE_ANSWERS, kind });
      const harnessExtras = recommendations.find(
        (r) => r.name === "harness-extras",
      );
      expect(harnessExtras?.recommended).toBe(true);
      expect(harnessExtras?.because.length).toBeGreaterThan(0);
      // A substring distinguishing the four original artifacts (a type-design
      // review agent, compaction-handoff hooks, a read-only Bash guard, a
      // file-budget gate) -- not the whole sentence.
      expect(harnessExtras?.because).toMatch(/type.design/i);
      expect(harnessExtras?.because).toMatch(/compaction/i);
      expect(harnessExtras?.because).toMatch(/read-only Bash/i);
      expect(harnessExtras?.because).toMatch(/file-budget/i);
      // A substring distinguishing the folded-in statusline segment: live
      // context-window pressure, rendered across the five documented rows
      // (session, model, context, quota, work).
      expect(harnessExtras?.because).toMatch(/context.window/i);
      expect(harnessExtras?.because).toMatch(/session|model|quota|work/i);
    }
  });

  it("recommends github with non-empty evidence, for every project kind", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const github = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "github",
      );
      expect(github?.recommended).toBe(true);
      expect(github?.because.length).toBeGreaterThan(0);
    }
  });

  it("recommends github with evidence naming the automated PR-review workflow and its two triage/audit skills, for every project kind", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const github = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "github",
      );
      expect(github?.recommended).toBe(true);
      // A substring distinguishing the new automated-review workflow
      // (claude-pr-review.yml) from the pre-existing mention-mode
      // claude.yml description.
      expect(github?.because).toMatch(/pr.review|review comment/i);
      // A substring distinguishing reviewing-dependabot-prs.
      expect(github?.because).toMatch(/dependabot/i);
      // A substring distinguishing triaging-scan-alerts.
      expect(github?.because).toMatch(/scan.alert/i);
    }
  });

  it("recommends publishing only for kinds that ship an npm package (library, cli), not for frontend or service", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const publishing = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "publishing",
      );
      expect(publishing).toBeDefined();
      expect(publishing?.because.length).toBeGreaterThan(0);
      expect(publishing?.recommended).toBe(
        kind === "library" || kind === "cli",
      );
    }
  });

  it("recommends publishing (for a library) with evidence naming the release pipeline and its supply-chain posture", () => {
    const publishing = recommendPacks({
      ...BASE_ANSWERS,
      kind: "library",
    }).find((r) => r.name === "publishing");
    expect(publishing?.recommended).toBe(true);
    // A substring distinguishing the release half: changesets, trusted
    // publishing, or npm itself.
    expect(publishing?.because).toMatch(/changeset|trusted publish|npm/i);
    // A substring distinguishing the supply-chain half: secret scanning.
    expect(publishing?.because).toMatch(/gitleaks|secret/i);
    // A substring distinguishing the supply-chain half: OpenSSF Scorecard.
    expect(publishing?.because).toMatch(/scorecard|supply.chain/i);
  });

  it("explains why publishing is not recommended for frontend/service kinds", () => {
    for (const kind of ["frontend", "service"] as const) {
      const publishing = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "publishing",
      );
      expect(publishing?.recommended).toBe(false);
      expect(publishing?.because).toMatch(/deploy|not.*publish|registry/i);
    }
  });

  it("gives every recommendation non-empty evidence", () => {
    for (const rec of recommendPacks(BASE_ANSWERS)) {
      expect(rec.because.length).toBeGreaterThan(0);
      expect(rec.name.length).toBeGreaterThan(0);
    }
  });
});
