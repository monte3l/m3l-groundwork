// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// This test verifies recommendPlugins (src/plugin-map.ts), which /customize
// will use in Step 1 to pre-select which built-in `claude-plugins-official`
// marketplace plugin(s) to offer, alongside the existing recommendPacks
// (pack-map.ts) table for templates/packs/* bundles -- same "inference
// happens once, visibly, with its reasoning attached" principle. Given a set
// of interview answers and an optional recommendation context (which packs
// were chosen, whether the project already carries custom skills), it must
// deterministically return exactly seven recommendations, in a fixed order,
// each carrying a non-empty "because" string and an id suffixed with
// "@claude-plugins-official". Three entries (context7, typescript-lsp,
// claude-md-management) are recommended unconditionally; one
// (claude-code-setup) is never recommended; the remaining three
// (github, security-guidance, skill-creator) vary by context/answers. Without
// this test, a change to plugin-map.ts could silently drop a plugin from the
// fixed list, flip a conditional recommendation's branch, return a
// recommendation with no justification shown to the user, or make the
// mapping non-deterministic across identical inputs -- none of which any
// other test in this repo would catch.
import { describe, expect, expectTypeOf, it } from "vitest";
import { recommendPlugins } from "../src/plugin-map.js";
import type {
  PluginRecommendation,
  PluginRecommendationContext,
} from "../src/plugin-map.js";
import type { InterviewAnswers } from "../src/kind-facet-map.js";

const BASE_ANSWERS: InterviewAnswers = {
  kind: "library",
  runtime: "node",
  testsMandatory: true,
  ciDepth: "standard",
  keepAgents: ["code-reviewer"],
};

const FIXED_ORDER = [
  "context7",
  "typescript-lsp",
  "claude-md-management",
  "github",
  "security-guidance",
  "skill-creator",
  "claude-code-setup",
] as const;

function find(
  recommendations: PluginRecommendation[],
  prefix: string,
): PluginRecommendation | undefined {
  return recommendations.find((r) => r.id.startsWith(`${prefix}@`));
}

describe("recommendPlugins", () => {
  it("is deterministic: the same answers and context always produce the same recommendations", () => {
    const context: PluginRecommendationContext = {
      chosenPacks: ["github"],
      hasCustomSkills: true,
    };
    const first = recommendPlugins(BASE_ANSWERS, context);
    const second = recommendPlugins({ ...BASE_ANSWERS }, { ...context });
    expect(second).toEqual(first);
  });

  it("is deterministic with no context argument at all", () => {
    const first = recommendPlugins(BASE_ANSWERS);
    const second = recommendPlugins({ ...BASE_ANSWERS });
    expect(second).toEqual(first);
  });

  it("returns exactly seven recommendations", () => {
    expect(recommendPlugins(BASE_ANSWERS)).toHaveLength(7);
  });

  it("returns the seven fixed plugin ids in a fixed order", () => {
    const recommendations = recommendPlugins(BASE_ANSWERS, {
      chosenPacks: ["github"],
      hasCustomSkills: true,
    });
    const prefixes = recommendations.map((r) => r.id.split("@")[0]);
    expect(prefixes).toEqual([...FIXED_ORDER]);
  });

  it("suffixes every id with the built-in marketplace name", () => {
    for (const rec of recommendPlugins(BASE_ANSWERS)) {
      expect(rec.id.endsWith("@claude-plugins-official")).toBe(true);
    }
  });

  it("gives every recommendation non-empty evidence", () => {
    for (const rec of recommendPlugins(BASE_ANSWERS, {
      chosenPacks: ["github"],
      hasCustomSkills: true,
    })) {
      expect(rec.because.length).toBeGreaterThan(0);
    }
  });

  describe("context7", () => {
    it("is recommended unconditionally, regardless of answers or context", () => {
      const withoutContext = find(recommendPlugins(BASE_ANSWERS), "context7");
      const withContext = find(
        recommendPlugins(
          { ...BASE_ANSWERS, kind: "service", ciDepth: "thorough" },
          { chosenPacks: ["github"], hasCustomSkills: true },
        ),
        "context7",
      );
      expect(withoutContext?.recommended).toBe(true);
      expect(withContext?.recommended).toBe(true);
    });

    it("carries no prerequisites", () => {
      const context7 = find(recommendPlugins(BASE_ANSWERS), "context7");
      expect(context7?.prerequisites).toBeUndefined();
    });
  });

  describe("typescript-lsp", () => {
    it("is recommended unconditionally, regardless of answers or context", () => {
      const withoutContext = find(
        recommendPlugins(BASE_ANSWERS),
        "typescript-lsp",
      );
      const withContext = find(
        recommendPlugins(
          { ...BASE_ANSWERS, kind: "frontend", ciDepth: "minimal" },
          { chosenPacks: [], hasCustomSkills: false },
        ),
        "typescript-lsp",
      );
      expect(withoutContext?.recommended).toBe(true);
      expect(withContext?.recommended).toBe(true);
    });

    it("names the typescript-language-server binary prerequisite", () => {
      const typescriptLsp = find(
        recommendPlugins(BASE_ANSWERS),
        "typescript-lsp",
      );
      expect(typescriptLsp?.prerequisites?.length).toBeGreaterThan(0);
      expect(
        typescriptLsp?.prerequisites?.some((p) =>
          p.includes("typescript-language-server"),
        ),
      ).toBe(true);
    });
  });

  describe("claude-md-management", () => {
    it("is recommended unconditionally, regardless of answers or context", () => {
      const withoutContext = find(
        recommendPlugins(BASE_ANSWERS),
        "claude-md-management",
      );
      const withContext = find(
        recommendPlugins(
          { ...BASE_ANSWERS, kind: "service" },
          { chosenPacks: ["github"], hasCustomSkills: true },
        ),
        "claude-md-management",
      );
      expect(withoutContext?.recommended).toBe(true);
      expect(withContext?.recommended).toBe(true);
    });
  });

  describe("github", () => {
    it("is not recommended when context is omitted", () => {
      const github = find(recommendPlugins(BASE_ANSWERS), "github");
      expect(github?.recommended).toBe(false);
    });

    it("is not recommended when chosenPacks is empty or absent", () => {
      const absent = find(recommendPlugins(BASE_ANSWERS, {}), "github");
      const empty = find(
        recommendPlugins(BASE_ANSWERS, { chosenPacks: [] }),
        "github",
      );
      expect(absent?.recommended).toBe(false);
      expect(empty?.recommended).toBe(false);
    });

    it("is not recommended when chosenPacks does not include github", () => {
      const github = find(
        recommendPlugins(BASE_ANSWERS, {
          chosenPacks: ["harness-extras", "publishing"],
        }),
        "github",
      );
      expect(github?.recommended).toBe(false);
    });

    it("is recommended when chosenPacks includes github", () => {
      const github = find(
        recommendPlugins(BASE_ANSWERS, { chosenPacks: ["github"] }),
        "github",
      );
      expect(github?.recommended).toBe(true);
    });

    it("gives different because text between the recommended and not-recommended states", () => {
      const notRecommended = find(recommendPlugins(BASE_ANSWERS), "github");
      const recommended = find(
        recommendPlugins(BASE_ANSWERS, { chosenPacks: ["github"] }),
        "github",
      );
      expect(notRecommended?.because).not.toBe(recommended?.because);
      // Recommended-true evidence names the github pack's gh-based skills.
      expect(recommended?.because).toMatch(/gh\b|dependabot|scan.alert/i);
      // Recommended-false evidence explains why it's not preselected.
      expect(notRecommended?.because).toMatch(
        /not (pre)?selected|github pack|not (chosen|installed)/i,
      );
    });
  });

  describe("security-guidance", () => {
    it("is recommended when kind is service, regardless of ciDepth", () => {
      const rec = find(
        recommendPlugins({
          ...BASE_ANSWERS,
          kind: "service",
          ciDepth: "minimal",
        }),
        "security-guidance",
      );
      expect(rec?.recommended).toBe(true);
    });

    it("is recommended when ciDepth is thorough, regardless of kind", () => {
      const rec = find(
        recommendPlugins({
          ...BASE_ANSWERS,
          kind: "library",
          ciDepth: "thorough",
        }),
        "security-guidance",
      );
      expect(rec?.recommended).toBe(true);
    });

    it("is not recommended for a library with minimal CI depth", () => {
      const rec = find(
        recommendPlugins({
          ...BASE_ANSWERS,
          kind: "library",
          ciDepth: "minimal",
        }),
        "security-guidance",
      );
      expect(rec?.recommended).toBe(false);
    });

    it("is not recommended for a frontend project with standard CI depth", () => {
      const rec = find(
        recommendPlugins({
          ...BASE_ANSWERS,
          kind: "frontend",
          ciDepth: "standard",
        }),
        "security-guidance",
      );
      expect(rec?.recommended).toBe(false);
    });

    it("names the Python 3.8+ prerequisite", () => {
      const rec = find(
        recommendPlugins({ ...BASE_ANSWERS, kind: "service" }),
        "security-guidance",
      );
      expect(rec?.prerequisites?.length).toBeGreaterThan(0);
      expect(rec?.prerequisites?.some((p) => /python/i.test(p))).toBe(true);
    });
  });

  describe("skill-creator", () => {
    it("is not recommended when context is omitted", () => {
      const rec = find(recommendPlugins(BASE_ANSWERS), "skill-creator");
      expect(rec?.recommended).toBe(false);
    });

    it("is not recommended when hasCustomSkills is falsy or absent", () => {
      const absent = find(recommendPlugins(BASE_ANSWERS, {}), "skill-creator");
      const falseValue = find(
        recommendPlugins(BASE_ANSWERS, { hasCustomSkills: false }),
        "skill-creator",
      );
      expect(absent?.recommended).toBe(false);
      expect(falseValue?.recommended).toBe(false);
    });

    it("is recommended when hasCustomSkills is true", () => {
      const rec = find(
        recommendPlugins(BASE_ANSWERS, { hasCustomSkills: true }),
        "skill-creator",
      );
      expect(rec?.recommended).toBe(true);
    });
  });

  describe("claude-code-setup", () => {
    it("is never recommended, regardless of any answers/context combination", () => {
      const combinations: [InterviewAnswers, PluginRecommendationContext][] = [
        [BASE_ANSWERS, {}],
        [
          { ...BASE_ANSWERS, kind: "service", ciDepth: "thorough" },
          { chosenPacks: ["github"], hasCustomSkills: true },
        ],
        [
          { ...BASE_ANSWERS, kind: "frontend", ciDepth: "minimal" },
          { chosenPacks: [], hasCustomSkills: false },
        ],
      ];
      for (const [answers, context] of combinations) {
        const rec = find(
          recommendPlugins(answers, context),
          "claude-code-setup",
        );
        expect(rec?.recommended).toBe(false);
      }
    });

    it("explains the omission by naming the /customize overlap", () => {
      const rec = find(recommendPlugins(BASE_ANSWERS), "claude-code-setup");
      expect(rec?.because).toMatch(/customize/i);
    });

    it("also points TypeScript-toolchain gaps specifically at the ts-advisor pack, alongside the /customize overlap reasoning", () => {
      const rec = find(recommendPlugins(BASE_ANSWERS), "claude-code-setup");
      expect(rec?.because).toMatch(/customize/i);
      expect(rec?.because).toMatch(/ts-advisor/i);
    });
  });

  it("type: PluginRecommendation's fields are readonly and prerequisites is optional", () => {
    expectTypeOf<PluginRecommendation>().toHaveProperty("id");
    expectTypeOf<PluginRecommendation["id"]>().toEqualTypeOf<string>();
    expectTypeOf<
      PluginRecommendation["recommended"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<PluginRecommendation["because"]>().toEqualTypeOf<string>();
    expectTypeOf<PluginRecommendation>().toHaveProperty("prerequisites");
    expectTypeOf<PluginRecommendation["prerequisites"]>().toEqualTypeOf<
      readonly string[] | undefined
    >();

    // readonly: assigning to any field must fail to typecheck. This branch
    // never runs (guarded by `false`) -- it exists purely for `tsc` to check.
    if (false as boolean) {
      const rec: PluginRecommendation = {
        id: "x@claude-plugins-official",
        recommended: true,
        because: "because",
      };
      // @ts-expect-error -- id is readonly
      rec.id = "y@claude-plugins-official";
      // @ts-expect-error -- recommended is readonly
      rec.recommended = false;
      // @ts-expect-error -- because is readonly
      rec.because = "different";
    }

    // prerequisites is optional: a PluginRecommendation with no
    // prerequisites key at all must still satisfy the type.
    const withoutPrerequisites: PluginRecommendation = {
      id: "context7@claude-plugins-official",
      recommended: true,
      because: "because",
    };
    expect(withoutPrerequisites.prerequisites).toBeUndefined();
  });
});
