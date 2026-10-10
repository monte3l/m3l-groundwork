// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// This test verifies planFacets (src/kind-facet-map.ts) deterministically maps
// interview answers -- project kind, runtime target, CI depth, kept agents --
// to a fixed research-priority plan across the five TypeScript facets and five
// harness facets: the same interview answers always produce the same facet
// plan, and every fixed facet id is covered exactly once on each side. Several
// assertions pin exact prose fragments the mapping returns (for example
// "visual verification" only for the frontend kind, "Node + browser" for the
// "both" runtime target, and the "minimal"/"thorough" CI-depth phrasing) as
// part of that determinism guarantee, not as incidental wording.
import { describe, expect, it } from "vitest";
import {
  planFacets,
  TYPESCRIPT_FIXED_FACETS,
  HARNESS_FIXED_FACETS,
  type InterviewAnswers,
} from "../src/kind-facet-map.js";

const BASE_ANSWERS: InterviewAnswers = {
  kind: "library",
  runtime: "node",
  testsMandatory: true,
  ciDepth: "standard",
  keepAgents: ["code-reviewer"],
};

describe("planFacets", () => {
  it("is deterministic: the same answers always produce the same plan", () => {
    const first = planFacets(BASE_ANSWERS);
    const second = planFacets({ ...BASE_ANSWERS });
    expect(second).toEqual(first);
  });

  it("covers every fixed TypeScript facet exactly once", () => {
    const plan = planFacets(BASE_ANSWERS);
    const ids = plan.typescript.map((f) => f.facetId);
    expect(ids).toEqual([...TYPESCRIPT_FIXED_FACETS]);
  });

  it("covers every fixed harness facet exactly once", () => {
    const plan = planFacets(BASE_ANSWERS);
    const ids = plan.harness.map((f) => f.facetId);
    expect(ids).toEqual([...HARNESS_FIXED_FACETS]);
  });

  it("gives every facet a non-empty emphasis string", () => {
    const plan = planFacets(BASE_ANSWERS);
    for (const facet of [...plan.typescript, ...plan.harness]) {
      expect(facet.emphasis.length).toBeGreaterThan(0);
    }
  });

  it("varies TypeScript emphasis by project kind", () => {
    const library = planFacets({ ...BASE_ANSWERS, kind: "library" });
    const frontend = planFacets({ ...BASE_ANSWERS, kind: "frontend" });
    const libraryTesting = library.typescript.find(
      (f) => f.facetId === "testing-language-features",
    );
    const frontendTesting = frontend.typescript.find(
      (f) => f.facetId === "testing-language-features",
    );
    expect(libraryTesting?.emphasis).not.toBe(frontendTesting?.emphasis);
  });

  it("adds a visual-verification emphasis only for the frontend kind", () => {
    const frontend = planFacets({ ...BASE_ANSWERS, kind: "frontend" });
    const service = planFacets({ ...BASE_ANSWERS, kind: "service" });
    const frontendAgent = frontend.harness.find(
      (f) => f.facetId === "agent-subagent-design",
    );
    const serviceAgent = service.harness.find(
      (f) => f.facetId === "agent-subagent-design",
    );
    expect(frontendAgent?.emphasis).toContain("visual verification");
    expect(serviceAgent?.emphasis).not.toContain("visual verification");
  });

  it('covers the "both" runtime target branch', () => {
    const plan = planFacets({ ...BASE_ANSWERS, runtime: "both" });
    const modules = plan.typescript.find(
      (f) => f.facetId === "modules-esm-node-interop",
    );
    expect(modules?.emphasis).toContain("Node + browser");
  });

  it("covers the minimal and thorough CI-depth branches", () => {
    const minimal = planFacets({ ...BASE_ANSWERS, ciDepth: "minimal" });
    const thorough = planFacets({ ...BASE_ANSWERS, ciDepth: "thorough" });
    const minimalCi = minimal.harness.find(
      (f) => f.facetId === "cc-features-settings",
    );
    const thoroughCi = thorough.harness.find(
      (f) => f.facetId === "cc-features-settings",
    );
    expect(minimalCi?.emphasis).toContain("minimal");
    expect(thoroughCi?.emphasis).toContain("thorough");
  });

  it("varies module-resolution emphasis by runtime target", () => {
    const node = planFacets({ ...BASE_ANSWERS, runtime: "node" });
    const browser = planFacets({ ...BASE_ANSWERS, runtime: "browser" });
    const nodeModules = node.typescript.find(
      (f) => f.facetId === "modules-esm-node-interop",
    );
    const browserModules = browser.typescript.find(
      (f) => f.facetId === "modules-esm-node-interop",
    );
    expect(nodeModules?.emphasis).not.toBe(browserModules?.emphasis);
  });

  describe("the plugin kind", () => {
    const facet = (
      plan: ReturnType<typeof planFacets>,
      id: (typeof TYPESCRIPT_FIXED_FACETS)[number],
    ) => plan.typescript.find((f) => f.facetId === id)?.emphasis;

    it.each(["library", "cli", "frontend", "service", "plugin"] as const)(
      "covers every fixed facet exactly once for the %s kind",
      (kind) => {
        const plan = planFacets({ ...BASE_ANSWERS, kind });
        expect(plan.typescript.map((f) => f.facetId)).toEqual([
          ...TYPESCRIPT_FIXED_FACETS,
        ]);
        expect(plan.harness.map((f) => f.facetId)).toEqual([
          ...HARNESS_FIXED_FACETS,
        ]);
      },
    );

    it("de-emphasizes packaging: a marketplace manifest, none of the library's npm packaging emphasis", () => {
      const plugin = planFacets({ ...BASE_ANSWERS, kind: "plugin" });
      const library = planFacets({ ...BASE_ANSWERS, kind: "library" });
      const packaging = facet(plugin, "packaging-declaration-emit");
      expect(packaging).toMatch(/marketplace/i);
      expect(packaging).not.toMatch(/exports-map|isolatedDeclarations/);
      expect(packaging).not.toBe(facet(library, "packaging-declaration-emit"));
    });

    it("keeps lint-typing-rules emphasized separately from the de-emphasized packaging facet", () => {
      const plugin = planFacets({ ...BASE_ANSWERS, kind: "plugin" });
      const lint = facet(plugin, "lint-typing-rules");
      expect(lint).toMatch(/typed-lint/i);
      expect(lint).not.toBe(facet(plugin, "packaging-declaration-emit"));
    });

    it("gives compiler-config and testing emphasis distinct from the library kind", () => {
      const plugin = planFacets({ ...BASE_ANSWERS, kind: "plugin" });
      const library = planFacets({ ...BASE_ANSWERS, kind: "library" });
      expect(facet(plugin, "compiler-config-flags")).toBeTruthy();
      expect(facet(plugin, "compiler-config-flags")).not.toBe(
        facet(library, "compiler-config-flags"),
      );
      expect(facet(plugin, "testing-language-features")).not.toBe(
        facet(library, "testing-language-features"),
      );
    });

    it("adds no extra agent emphasis for the plugin kind", () => {
      const plugin = planFacets({ ...BASE_ANSWERS, kind: "plugin" });
      const library = planFacets({ ...BASE_ANSWERS, kind: "library" });
      const agent = (p: typeof plugin) =>
        p.harness.find((f) => f.facetId === "agent-subagent-design")?.emphasis;
      expect(agent(plugin)).toBe(agent(library));
      expect(agent(plugin)).not.toContain("visual verification");
    });
  });
});
