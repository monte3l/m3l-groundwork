// This test verifies recommendPacks (src/pack-map.ts), which /customize uses
// to suggest optional templates/packs/* bundles during its interview: given a
// set of interview answers, it must deterministically recommend the same
// packs (harness-extras, statusline, claude-action) across every project
// kind, and every recommendation must carry non-empty "because" evidence and
// a non-empty name. Without this test, a change to pack-map.ts could silently
// stop recommending a pack for some project kind, or return a recommendation
// with no justification shown to the user, or make the mapping
// non-deterministic across identical answers -- none of which any other test
// in this repo would catch.
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

  it("recommends harness-extras with non-empty evidence, for every project kind", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const recommendations = recommendPacks({ ...BASE_ANSWERS, kind });
      const harnessExtras = recommendations.find(
        (r) => r.name === "harness-extras",
      );
      expect(harnessExtras?.recommended).toBe(true);
      expect(harnessExtras?.because.length).toBeGreaterThan(0);
    }
  });

  it("recommends statusline with non-empty evidence, for every project kind", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const statusline = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "statusline",
      );
      expect(statusline?.recommended).toBe(true);
      expect(statusline?.because.length).toBeGreaterThan(0);
    }
  });

  it("recommends claude-action with non-empty evidence, for every project kind", () => {
    for (const kind of ["library", "cli", "frontend", "service"] as const) {
      const claudeAction = recommendPacks({ ...BASE_ANSWERS, kind }).find(
        (r) => r.name === "claude-action",
      );
      expect(claudeAction?.recommended).toBe(true);
      expect(claudeAction?.because.length).toBeGreaterThan(0);
    }
  });

  it("gives every recommendation non-empty evidence", () => {
    for (const rec of recommendPacks(BASE_ANSWERS)) {
      expect(rec.because.length).toBeGreaterThan(0);
      expect(rec.name.length).toBeGreaterThan(0);
    }
  });
});
