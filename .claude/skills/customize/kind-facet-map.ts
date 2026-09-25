// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The kind-to-facet table `/customize` reads to plan its guidance-sweep
 * research priority. Three terms recur throughout this file:
 *
 * - A "kind" is a `ProjectKind`: the project archetype the interview
 *   classifies the project as (library, cli, frontend or service).
 * - A "guidance sweep" is the live research pass `/customize` runs over
 *   official TypeScript and Anthropic sources, once per domain (TypeScript
 *   toolchain, Claude Code harness).
 * - A "facet" is one fixed research topic within a domain -- for example
 *   `compiler-config-flags` is a TypeScript facet and `hooks-lifecycle` is a
 *   harness facet. A guidance sweep always covers every facet of its domain,
 *   whether or not the interview emphasized it.
 *
 * This table is a stored, unit-tested module -- not a judgment made afresh
 * each run -- so the same interview answers always produce the same facet
 * plan.
 *
 * Scope note (load-bearing): this table scopes research PRIORITY only. It
 * decides which facets get the most emphasis, never what a guidance sweep
 * is allowed to touch. Both guidance skills
 * (templates/core/.claude/skills/typescript-guidance and harness-guidance)
 * retain full authority to amend anything in their domain, regardless of what
 * this table emphasizes -- see their SKILL.md "Authority" sections. A facet
 * with low priority here still gets swept. It just isn't the one a dedicated
 * research agent digs into deepest.
 */

export type ProjectKind = "library" | "cli" | "frontend" | "service";
export type RuntimeTarget = "node" | "browser" | "both";
export type CiDepth = "minimal" | "standard" | "thorough";

export interface InterviewAnswers {
  readonly kind: ProjectKind;
  readonly runtime: RuntimeTarget;
  readonly testsMandatory: boolean;
  readonly ciDepth: CiDepth;
  readonly keepAgents: readonly string[];
}

/** The five fixed TypeScript facets -- fixed, not derived per-run, so sweeps stay comparable. */
export const TYPESCRIPT_FIXED_FACETS = [
  "compiler-config-flags",
  "modules-esm-node-interop",
  "packaging-declaration-emit",
  "lint-typing-rules",
  "testing-language-features",
] as const;
export type TypeScriptFacetId = (typeof TYPESCRIPT_FIXED_FACETS)[number];

/** The five fixed harness facets -- likewise fixed. */
export const HARNESS_FIXED_FACETS = [
  "models-tiering",
  "cc-features-settings",
  "agent-subagent-design",
  "skills-context-engineering",
  "hooks-lifecycle",
] as const;
export type HarnessFacetId = (typeof HARNESS_FIXED_FACETS)[number];

export interface FacetEmphasis<Id extends string> {
  readonly facetId: Id;
  readonly emphasis: string;
}

export interface FacetPlan {
  readonly typescript: readonly FacetEmphasis<TypeScriptFacetId>[];
  readonly harness: readonly FacetEmphasis<HarnessFacetId>[];
}

interface KindEmphasis {
  readonly configModules: string;
  readonly packagingLint: string;
  readonly testing: string;
}

const TYPESCRIPT_EMPHASIS_BY_KIND: Record<ProjectKind, KindEmphasis> = {
  library: {
    configModules: "nodenext resolution, declaration emit",
    packagingLint:
      "isolatedDeclarations, exports-map correctness, ESM-only vs dual, typed-lint preset for a published API",
    testing: "Node-process testing, type-level assertions",
  },
  cli: {
    configModules: "Node runtime target, bin field and shebang packaging",
    packagingLint: "packaging for an executable, typed-lint preset",
    testing: "process/stdio testing",
  },
  frontend: {
    configModules: "bundler resolution, lib/DOM types for a bundled target",
    packagingLint:
      "bundler-driven vs tsc-driven emit, typed-lint preset for JSX/component code",
    testing: "browser mode vs jsdom, component testing",
  },
  service: {
    configModules:
      "Node module resolution and runtime target, no declaration emit",
    packagingLint: "emit for a deployed server, typed-lint preset",
    testing: "integration-test isolation",
  },
};

function runtimeEmphasis(runtime: RuntimeTarget): string {
  switch (runtime) {
    case "node":
      return "Node module resolution and runtime target";
    case "browser":
      return "bundler/browser module resolution";
    case "both":
      return "Node + browser dual module resolution";
  }
}

function ciDepthEmphasis(depth: CiDepth): string {
  switch (depth) {
    case "minimal":
      return "minimal CI surface, current recommended baseline lanes";
    case "standard":
      return "standard CI surface, current recommended lane set";
    case "thorough":
      return "thorough CI surface, current recommended additional lanes";
  }
}

function agentEmphasis(
  keepAgents: readonly string[],
  kind: ProjectKind,
): string {
  const base =
    keepAgents.length > 0
      ? `current subagent/reviewer patterns for: ${keepAgents.join(", ")}`
      : "current subagent/reviewer patterns (no reviewer spokes kept)";
  // The one kind-keyed exception noted in the harness-guidance skill: a
  // frontend/web project's reviewer patterns genuinely differ (visual
  // verification), where every other Anthropic-facing facet does not vary
  // by project kind at all.
  return kind === "frontend"
    ? `${base}; include visual verification patterns`
    : base;
}

/**
 * Deterministically maps interview answers to a facet research plan. Same
 * `answers` in, same `FacetPlan` out, always -- this is what "the kind-to-facet
 * table" means concretely.
 */
export function planFacets(answers: InterviewAnswers): FacetPlan {
  const kindEmphasis = TYPESCRIPT_EMPHASIS_BY_KIND[answers.kind];

  const typescript: readonly FacetEmphasis<TypeScriptFacetId>[] = [
    { facetId: "compiler-config-flags", emphasis: kindEmphasis.configModules },
    {
      facetId: "modules-esm-node-interop",
      emphasis: runtimeEmphasis(answers.runtime),
    },
    {
      facetId: "packaging-declaration-emit",
      emphasis: kindEmphasis.packagingLint,
    },
    { facetId: "lint-typing-rules", emphasis: kindEmphasis.packagingLint },
    { facetId: "testing-language-features", emphasis: kindEmphasis.testing },
  ];

  const harness: readonly FacetEmphasis<HarnessFacetId>[] = [
    {
      facetId: "models-tiering",
      emphasis: "current model/effort tiering for this agent roster",
    },
    {
      facetId: "cc-features-settings",
      emphasis: ciDepthEmphasis(answers.ciDepth),
    },
    {
      facetId: "agent-subagent-design",
      emphasis: agentEmphasis(answers.keepAgents, answers.kind),
    },
    {
      facetId: "skills-context-engineering",
      emphasis: "current skill/description budget guidance",
    },
    {
      facetId: "hooks-lifecycle",
      emphasis: "current hook event/matcher/exit-code contract",
    },
  ];

  return { typescript, harness };
}
