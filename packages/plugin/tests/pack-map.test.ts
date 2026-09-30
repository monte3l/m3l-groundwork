// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// This test verifies recommendPacks (src/pack-map.ts), which /customize uses
// to suggest optional templates/packs/* bundles during its interview: given a
// set of interview answers, it must deterministically recommend the same two
// packs (harness-extras, github) across every project kind, and every
// recommendation must carry non-empty "because" evidence and a non-empty
// name. Without this test, a change to pack-map.ts could silently stop
// recommending a pack for some project kind, or return a recommendation with
// no justification shown to the user, or make the mapping non-deterministic
// across identical answers -- none of which any other test in this repo
// would catch.
//
// `supply-chain` (gitleaks secret scanning + OpenSSF Scorecard) was carved
// out of `publishing` into its own pack, recommended for every project kind
// -- unlike `publishing` (a release pipeline), secret scanning and Scorecard
// apply just as much to a frontend or service repo as to a published
// library or CLI. `publishing`'s own evidence must no longer mention
// gitleaks/secret-scanning/Scorecard now that they live in a separate pack.
//
// `quality` was carved out of `harness-extras` into its own pack: the
// type-design-analyzer agent and the per-file-size (file-budget) ratchet
// gate. Both are language-level, not harness-ergonomics-level, so they get
// their own pack recommended for every project kind; harness-extras's own
// evidence must no longer mention either now that they live separately --
// only the compaction-handoff hooks, the read-only Bash guard and the
// statusLine remain.
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

  it("returns exactly seven recommendations: harness-extras, github, publishing, worktrees, ts-advisor, supply-chain and quality", () => {
    const names = recommendPacks(BASE_ANSWERS).map((r) => r.name);
    expect(names).toEqual([
      "harness-extras",
      "github",
      "publishing",
      "worktrees",
      "ts-advisor",
      "supply-chain",
      "quality",
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

  it("recommends harness-extras with evidence naming the compaction-handoff hooks, the read-only Bash guard and the folded-in statusline segment, and no longer mentions the type-design agent or file-budget gate now that they live in the separate quality pack, for every project kind", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const recommendations = recommendPacks({ ...BASE_ANSWERS, kind });
      const harnessExtras = recommendations.find(
        (r) => r.name === "harness-extras",
      );
      expect(harnessExtras?.recommended).toBe(true);
      expect(harnessExtras?.because.length).toBeGreaterThan(0);
      // Substrings distinguishing the artifacts that remain in this pack:
      // the compaction-handoff hooks and the read-only Bash guard.
      expect(harnessExtras?.because).toMatch(/compaction/i);
      expect(harnessExtras?.because).toMatch(/read-only Bash/i);
      // A substring distinguishing the folded-in statusline segment: live
      // context-window pressure, rendered across the five documented rows
      // (session, model, context, quota, work).
      expect(harnessExtras?.because).toMatch(/context.window/i);
      expect(harnessExtras?.because).toMatch(/session|model|quota|work/i);
      // The type-design review agent and the file-budget gate moved to the
      // separate `quality` pack -- this pack's own evidence must no longer
      // claim either.
      expect(harnessExtras?.because).not.toMatch(/file-budget|type.design/i);
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

  it("recommends publishing (for a library) with evidence naming the release pipeline, and no longer mentions the supply-chain half now that it lives in its own pack", () => {
    const publishing = recommendPacks({
      ...BASE_ANSWERS,
      kind: "library",
    }).find((r) => r.name === "publishing");
    expect(publishing?.recommended).toBe(true);
    // A substring distinguishing the release half: changesets, trusted
    // publishing, or npm itself.
    expect(publishing?.because).toMatch(/changeset|trusted publish|npm/i);
    // The supply-chain half (secret scanning, OpenSSF Scorecard) was carved
    // out into its own `supply-chain` pack -- publishing's own evidence
    // must no longer claim it.
    expect(publishing?.because).not.toMatch(/gitleaks|secret|scorecard/i);
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

  it("recommends supply-chain unconditionally, for every project kind, with evidence naming secret scanning and OpenSSF Scorecard", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const supplyChain = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "supply-chain",
      );
      expect(supplyChain).toBeDefined();
      expect(supplyChain?.recommended).toBe(true);
      expect(supplyChain?.because.length).toBeGreaterThan(0);
      // A substring distinguishing secret scanning (gitleaks).
      expect(supplyChain?.because).toMatch(/gitleaks|secret/i);
      // A substring distinguishing OpenSSF Scorecard.
      expect(supplyChain?.because).toMatch(/scorecard/i);
    }
  });

  it("recommends ts-advisor unconditionally, for every project kind, with non-empty evidence distinguishing it from the other packs", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const tsAdvisor = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "ts-advisor",
      );
      expect(tsAdvisor).toBeDefined();
      expect(tsAdvisor?.recommended).toBe(true);
      expect(tsAdvisor?.because.length).toBeGreaterThan(0);
      // A substring distinguishing this pack's own job -- recommending
      // missing TypeScript-ecosystem tooling -- from every other pack's
      // evidence above (harness ergonomics, GitHub operations, releases,
      // worktree isolation).
      expect(tsAdvisor?.because).toMatch(/recommending-ts-tooling/i);
    }
  });

  it("recommends quality unconditionally, for every project kind, with evidence naming the per-file size ratchet and the type-design review agent", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const quality = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "quality",
      );
      expect(quality).toBeDefined();
      expect(quality?.recommended).toBe(true);
      expect(quality?.because.length).toBeGreaterThan(0);
      // A substring distinguishing the per-file size ratchet (the
      // file-budget gate carved out of harness-extras).
      expect(quality?.because).toMatch(/file-budget|size/i);
      // A substring distinguishing the type-design review agent.
      expect(quality?.because).toMatch(/type.design/i);
    }
  });
});
