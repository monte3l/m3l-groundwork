// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// This test verifies recommendPacks (src/pack-map.ts), which /customize uses
// to suggest optional templates/packs/* bundles during its interview: given a
// set of interview answers, it must deterministically recommend the same
// packs (harness-extras, statusline, github, claude-github, ...) across every project kind, and every
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
// `licensing` (the SPDX/REUSE license-header gate) was likewise carved out of
// `publishing` into its own fresh-only pack, recommended for the same kinds
// (library, cli) and listed directly after `publishing`; `publishing`'s own
// evidence must no longer mention SPDX/REUSE/license headers.
//
// `quality` was carved out of `harness-extras` into its own pack: the
// type-design-analyzer agent and the per-file-size (file-budget) ratchet
// gate. Both are language-level, not harness-ergonomics-level, so they get
// their own pack recommended for every project kind; harness-extras's own
// evidence must no longer mention either now that they live separately --
// only the compaction-handoff hooks and the read-only Bash guard remain.
//
// The status line was then carved out of `harness-extras` into its own
// `statusline` pack, recommended for every project kind and listed directly
// after `harness-extras`; harness-extras's own evidence must no longer
// mention it.
//
// `frontend` (a read-only UI/accessibility review agent plus a new-component
// scaffolding skill) is the third kind-varying pack, after `publishing` and
// `licensing`: it is recommended only for the `frontend` project kind.
//
// `service` (a read-only performance-analyzer agent plus an api-doc skill) is
// the fourth kind-varying pack: recommended only for the `service` kind.
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

  it("returns exactly eleven recommendations: harness-extras, statusline, github, claude-github, publishing, licensing, worktrees, supply-chain, quality, frontend and service", () => {
    const names = recommendPacks(BASE_ANSWERS).map((r) => r.name);
    expect(names).toEqual([
      "harness-extras",
      "statusline",
      "github",
      "claude-github",
      "publishing",
      "licensing",
      "worktrees",
      "supply-chain",
      "quality",
      "frontend",
      "service",
    ]);
  });

  it("recommends worktrees as opt-in (not recommended by default) with non-empty evidence, for every project kind -- it changes the day-to-day workflow rather than being a zero-cost addition", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
      const worktrees = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "worktrees",
      );
      expect(worktrees).toBeDefined();
      expect(worktrees?.recommended).toBe(false);
      expect(worktrees?.because.length).toBeGreaterThan(0);
    }
  });

  it("recommends harness-extras with evidence naming the compaction-handoff hooks and the read-only Bash guard, and no longer the statusline, the type-design agent or the file-budget gate, for every project kind", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
      const recommendations = recommendPacks({ ...BASE_ANSWERS, kind });
      const harnessExtras = recommendations.find(
        (r) => r.name === "harness-extras",
      );
      expect(harnessExtras?.recommended).toBe(true);
      expect(harnessExtras?.because.length).toBeGreaterThan(0);
      expect(harnessExtras?.because).toMatch(/compact/i);
      expect(harnessExtras?.because).toMatch(/read-only|readonly/i);
      // The status line moved to the separate `statusline` pack.
      expect(harnessExtras?.because).not.toMatch(/context.window/i);
      expect(harnessExtras?.because).not.toMatch(/statusline|status line/i);
      // The type-design review agent and the file-budget gate moved to the
      // separate `quality` pack.
      expect(harnessExtras?.because).not.toMatch(/file-budget|type.design/i);
    }
  });

  it("recommends statusline for every project kind, with evidence naming live context-window pressure and the session/model/quota/work rows", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
      const statusline = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "statusline",
      );
      expect(statusline?.recommended).toBe(true);
      expect(statusline?.because).toMatch(/context.window/i);
      expect(statusline?.because).toMatch(/session|model|quota|work/i);
    }
  });

  it("recommends github with non-empty evidence, for every project kind", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
      const github = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "github",
      );
      expect(github?.recommended).toBe(true);
      expect(github?.because.length).toBeGreaterThan(0);
    }
  });

  it("recommends github with evidence naming its two triage/audit skills and no longer the PR-review workflow, for every project kind", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
      const github = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "github",
      );
      expect(github?.recommended).toBe(true);
      // The automated-review workflow moved to the claude-github pack.
      expect(github?.because).not.toMatch(/pr.review|review comment/i);
      // A substring distinguishing reviewing-dependabot-prs.
      expect(github?.because).toMatch(/dependabot/i);
      // A substring distinguishing triaging-scan-alerts.
      expect(github?.because).toMatch(/scan.alert/i);
    }
  });

  it("recommends claude-github as opt-in (never recommended) for every project kind, with evidence naming the auth secret and the per-PR review spend", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
      const claudeGithub = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "claude-github",
      );
      expect(claudeGithub).toBeDefined();
      expect(claudeGithub?.recommended).toBe(false);
      expect(claudeGithub?.because).toMatch(/pr.review|review comment/i);
      expect(claudeGithub?.because).toMatch(/secret|api.key/i);
    }
  });

  it("recommends publishing only for kinds that ship an npm package (library, cli), not for frontend, service or plugin", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
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
    // The license-header gate moved to the `licensing` pack.
    expect(publishing?.because).not.toMatch(/SPDX|REUSE|license/i);
  });

  it("recommends licensing only for library and cli, with SPDX/REUSE evidence that mentions the one-time backfill", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
      const licensing = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "licensing",
      );
      expect(licensing).toBeDefined();
      expect(licensing?.recommended).toBe(kind === "library" || kind === "cli");
      expect(licensing?.because).toMatch(/SPDX|REUSE/);
      expect(licensing?.because).toMatch(/backfill/i);
    }
  });

  it("explains why publishing is not recommended for frontend/service/plugin kinds", () => {
    for (const kind of ["frontend", "service", "plugin"] as const) {
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
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
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

  it("recommends quality unconditionally, for every project kind, with evidence naming the per-file size ratchet and the type-design review agent", () => {
    for (const kind of [
      "library",
      "cli",
      "frontend",
      "service",
      "plugin",
    ] as const) {
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

  it.each([
    ["frontend", true],
    ["library", false],
    ["cli", false],
    ["service", false],
    ["plugin", false],
  ] as const)(
    "recommends frontend only for the frontend kind (kind %s -> %s), with evidence naming frontend and, when recommended, accessibility",
    (kind, expected) => {
      const frontend = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "frontend",
      );
      expect(frontend).toBeDefined();
      expect(frontend?.recommended).toBe(expected);
      expect(frontend?.because).toMatch(/frontend/i);
      if (expected) {
        expect(frontend?.because).toMatch(/accessib/i);
      }
    },
  );

  it.each([
    ["service", true],
    ["library", false],
    ["cli", false],
    ["frontend", false],
    ["plugin", false],
  ] as const)(
    "recommends service only for the service kind (kind %s -> %s), with evidence naming service and, when recommended, performance and OpenAPI",
    (kind, expected) => {
      const service = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "service",
      );
      expect(service).toBeDefined();
      expect(service?.recommended).toBe(expected);
      expect(service?.because).toMatch(/service/i);
      if (expected) {
        expect(service?.because).toMatch(/performance/i);
        expect(service?.because).toMatch(/OpenAPI/i);
      } else {
        expect(service?.because).toMatch(/preselected for the service kind/);
      }
    },
  );
});
