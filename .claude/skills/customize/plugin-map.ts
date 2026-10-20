// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The plugin recommendation table `/customize` reads in Step 3 to pre-select
 * which built-in `claude-plugins-official` marketplace plugin(s) to offer,
 * and, separately, which service-integration plugins to offer (never
 * pre-selected) for the SDKs the project depends on, with the evidence
 * shown alongside each recommendation -- the same
 * "inference happens once, visibly, with its reasoning attached" principle
 * `pack-map.ts` applies to `templates/packs/` bundles. A stored, unit-tested
 * module rather than a judgment made afresh each run, so the same interview
 * answers and context always produce the same recommendation.
 *
 * Two plugins are offered for one kind only and are then appended last as an
 * eleventh entry: `plugin-dev` for the `plugin` kind (a repo that authors a
 * Claude Code plugin), and `frontend-design` for the `frontend` kind. For
 * every other kind each is absent rather than listed as not recommended, so
 * the first ten entries `/customize` offers in fixed batches keep their
 * order. m3l-groundwork itself enables `plugin-dev`, since it authors the
 * `/customize` plugin.
 *
 * Evaluated and deliberately not offered, recorded so they are not proposed
 * again:
 *
 * - `code-review` -- duplicates the built-in `/code-review` and the optional
 *   `claude-github` pack's PR-review Action.
 * - `code-simplifier` -- duplicates the built-in `/simplify`; its
 *   unrestricted-tools agent is blocked by the baseline's hub-and-spoke
 *   write guard on `src/`/`tests/` anyway.
 * - `feature-dev` -- duplicates plan mode, `starting-work` and the TDD loop;
 *   its `code-reviewer` competes with the baseline's.
 * - `pr-review-toolkit` -- overlaps the baseline's `code-reviewer` and
 *   `silent-failure-hunter` and the optional `quality` pack's
 *   `type-design-analyzer`.
 * - `hookify` -- runs `python3` on every tool call, and keeps its rules in
 *   gitignored `.local.md` files that bypass the graded, committed hooks and
 *   the hook cap.
 * - `remember` -- third-party under a source-available license that forbids
 *   modification and redistribution; it sends transcripts to `claude -p`,
 *   writes `.remember/`, and can push memory to a remote.
 * - `commit-commands` -- its `/commit` asks for neither Conventional Commits
 *   nor a Co-Authored-By trailer, `/commit-push-pr` commits, pushes and opens
 *   the PR in one turn, and `/clean_gone` force-deletes local branches whose
 *   remote is gone, and their worktrees, so it bypasses and competes with the
 *   baseline's `writing-commits`, `creating-prs` and `finishing-work`.
 * - `vercel` -- ships SessionStart and Skill hooks and, by default, sends
 *   telemetry that includes an install id.
 * - `stripe` -- its node hooks run on every prompt and every tool batch,
 *   spawn the `stripe` CLI and inject feedback prompts.
 * - `convex` -- a PreToolUse lint hook, a Stop hook that can run for up to
 *   180 seconds, polling shell monitors, default-on telemetry and an
 *   unpinned `npx convex@latest`.
 * - `linear` -- its SDK package name was not confirmed from vendor docs, so
 *   there is no verified dependency signal to offer it from.
 */
import type { InterviewAnswers } from "./kind-facet-map.js";

/** The marketplace every plugin in this table ships from. */
const MARKETPLACE = "claude-plugins-official";

/**
 * One plugin's recommendation: its fully-qualified `name@marketplace` id,
 * whether `/customize` pre-selects it, the reasoning shown to the user, and
 * any host prerequisite the plugin cannot install for itself.
 */
export interface PluginRecommendation {
  readonly id: string;
  readonly recommended: boolean;
  readonly because: string;
  readonly prerequisites?: readonly string[];
}

/**
 * What `/customize` knows beyond the interview answers by the time it
 * recommends plugins: which packs the user chose, whether the project
 * authors its own skills, and which packages it depends on. All are
 * optional; an absent field reads as "no" (or "none").
 */
export interface PluginRecommendationContext {
  readonly chosenPacks?: readonly string[];
  readonly hasCustomSkills?: boolean;
  /**
   * Package names from the project's `package.json` `dependencies` and
   * `devDependencies` combined. Absent reads as none.
   */
  readonly dependencies?: readonly string[];
  /**
   * True when the project already carries its own design system: a
   * design-token file, a CSS file with a Tailwind `@theme` block, or an
   * in-house design-system package in its dependencies. A bare Tailwind
   * config does not count, and a fresh bootstrap is false. Absent reads as
   * false.
   */
  readonly hasDesignSystem?: boolean;
}

function pluginId(name: string): string {
  return `${name}@${MARKETPLACE}`;
}

/**
 * `context7` is not optional for a project bootstrapped from this baseline:
 * `templates/core/.claude/agents/code-implementer.md` declares
 * `mcpServers: [context7]`, and an agent's MCP grant names a server that
 * some installed source must actually provide -- without the plugin enabled
 * the grant resolves to nothing and fails silently (the gap the
 * `agent-mcp-source` harness rubric rule flags). It works anonymously; an
 * API key only raises rate limits.
 */
function recommendContext7(): PluginRecommendation {
  return {
    id: pluginId("context7"),
    recommended: true,
    because:
      "the baseline's code-implementer agent declares mcpServers: " +
      "[context7], so without this plugin enabled that grant silently " +
      "resolves to nothing -- the agent loses the library-docs lookup it " +
      "was written to rely on. It works anonymously; a CONTEXT7_API_KEY is " +
      "optional and only raises the rate limit.",
  };
}

/**
 * Every project this bootstrapper produces is TypeScript, so a TypeScript
 * language server gives Claude go-to-definition, references and live
 * diagnostics on any of them. The plugin wires the server up but does not
 * ship the binary itself -- it must already be on `PATH`.
 */
function recommendTypescriptLsp(): PluginRecommendation {
  return {
    id: pluginId("typescript-lsp"),
    recommended: true,
    because:
      "every project this bootstrapper emits is TypeScript, so a language " +
      "server gives Claude real go-to-definition, find-references and " +
      "compiler diagnostics instead of text search, whatever the project " +
      "kind. The plugin only wires the server up -- the binary itself has " +
      "to be installed separately.",
    prerequisites: [
      "the typescript-language-server binary on PATH (for example via " +
        "`pnpm add -g typescript-language-server typescript`)",
    ],
  };
}

/**
 * The baseline ships a `CLAUDE.md` that is only useful while it stays true.
 * `harness-guidance` refreshes the harness against upstream in periodic
 * sweeps; `claude-md-management` covers the other half -- keeping the file
 * in step with what the project itself learns between those sweeps.
 */
function recommendClaudeMdManagement(): PluginRecommendation {
  return {
    id: pluginId("claude-md-management"),
    recommended: true,
    because:
      "the baseline's CLAUDE.md only helps while it stays accurate; this " +
      "plugin audits and updates it as the project changes, complementing " +
      "harness-guidance's periodic refresh sweeps, which check the harness " +
      "against upstream guidance rather than against the project's own " +
      "day-to-day drift.",
  };
}

/**
 * The `github` plugin is the natural companion to the `github` pack: that
 * pack's skills (`reviewing-dependabot-prs`, `triaging-scan-alerts`,
 * `watching-pr-checks`) are `gh`-CLI workflows, and the plugin gives Claude
 * structured GitHub access alongside them. Without the pack there is no
 * GitHub-operations workflow in the project for it to serve, so it is only
 * offered, not pre-selected.
 */
function recommendGithub(
  context: PluginRecommendationContext | undefined,
): PluginRecommendation {
  const recommended = context?.chosenPacks?.includes("github") ?? false;
  return {
    id: pluginId("github"),
    recommended,
    because: recommended
      ? "the github pack was chosen, and its skills are gh-CLI GitHub " +
        "workflows -- reviewing and batch-merging Dependabot PRs, triaging " +
        "code-scanning alerts to file:line, watching a PR's checks -- so " +
        "structured GitHub access through this plugin serves them directly."
      : "not preselected because the github pack was not chosen: without " +
        "its GitHub-operations skills there is no workflow here that needs " +
        "structured GitHub access. It stays on offer if the project works " +
        "heavily with issues and PRs anyway.",
  };
}

/**
 * `security-guidance` earns its cost where the attack surface or the
 * rigor bar is highest: a `service` handles untrusted network input, and a
 * `thorough` CI depth is the user asking for the stricter posture
 * explicitly. The cost is real and named rather than hidden -- Edit/Write
 * pattern hooks, a Stop-hook LLM review that spends tokens on every turn,
 * and a commit reviewer -- so it is not pre-selected elsewhere.
 */
function recommendSecurityGuidance(
  answers: InterviewAnswers,
): PluginRecommendation {
  const recommended =
    answers.kind === "service" || answers.ciDepth === "thorough";
  return {
    id: pluginId("security-guidance"),
    recommended,
    because: recommended
      ? "a service handles untrusted input, or thorough CI depth asks for " +
        "the stricter posture, so security review is worth its cost here. " +
        "That cost is real: pattern hooks on every Edit/Write, a Stop-hook " +
        "LLM review that spends tokens at the end of every turn, and a " +
        "commit reviewer."
      : "for a non-service project at standard or minimal CI depth, its " +
        "Edit/Write pattern hooks, per-turn Stop-hook LLM review (tokens " +
        "on every turn) and commit reviewer cost more than the added " +
        "scrutiny is likely to return -- still available if the project " +
        "handles sensitive data.",
    prerequisites: ["Python 3.8+ on PATH (its hooks are Python scripts)"],
  };
}

/**
 * `claude-security` is the on-demand counterpart to `security-guidance`: it
 * runs only when invoked, so unlike that plugin's per-turn Stop-hook LLM
 * review it costs nothing while idle, and is pre-selected for every project.
 */
function recommendClaudeSecurity(): PluginRecommendation {
  return {
    id: pluginId("claude-security"),
    recommended: true,
    because:
      "it runs on demand -- only when invoked -- so it costs nothing while " +
      "idle, unlike security-guidance's Stop-hook LLM review on every " +
      "turn. When run it scans the repo or a diff, challenges each finding " +
      "before reporting it, and can draft patches. Its post-push scan tip " +
      "can be turned off with CLAUDE_SECURITY_SCAN_TIP=off.",
    prerequisites: ["Python 3.9+ on PATH"],
  };
}

function dependsOn(
  context: PluginRecommendationContext | undefined,
  packageName: string,
): boolean {
  return context?.dependencies?.includes(packageName) ?? false;
}

/**
 * `agent-sdk-dev` scaffolds and verifies Claude Agent SDK applications, so it
 * is pre-selected only when the project depends on
 * `@anthropic-ai/claude-agent-sdk`.
 */
function recommendAgentSdkDev(
  context: PluginRecommendationContext | undefined,
): PluginRecommendation {
  const recommended = dependsOn(context, "@anthropic-ai/claude-agent-sdk");
  return {
    id: pluginId("agent-sdk-dev"),
    recommended,
    because: recommended
      ? "the project depends on @anthropic-ai/claude-agent-sdk, and this " +
        "plugin scaffolds new SDK apps (/new-sdk-app) and verifies existing " +
        "ones against the SDK's current guidance."
      : "only useful to a project that builds on the Claude Agent SDK; " +
        "@anthropic-ai/claude-agent-sdk is not among this project's " +
        "dependencies.",
  };
}

/**
 * `mcp-server-dev` carries skills for building MCP servers and MCP apps and
 * for MCPB packaging, so it is pre-selected only when the project depends on
 * `@modelcontextprotocol/sdk`.
 */
function recommendMcpServerDev(
  context: PluginRecommendationContext | undefined,
): PluginRecommendation {
  const recommended = dependsOn(context, "@modelcontextprotocol/sdk");
  return {
    id: pluginId("mcp-server-dev"),
    recommended,
    because: recommended
      ? "the project depends on @modelcontextprotocol/sdk, and this plugin " +
        "brings skills for building MCP servers and MCP apps and for " +
        "packaging them as MCPB bundles."
      : "only useful to a project that builds on the MCP SDK; " +
        "@modelcontextprotocol/sdk is not among this project's " +
        "dependencies.",
  };
}

/**
 * `skill-creator` scaffolds, evaluates and iterates on skills. The baseline's
 * own skills are maintained upstream by m3l-groundwork, not by the project,
 * so it only pays for itself in a project that writes skills of its own.
 */
function recommendSkillCreator(
  context: PluginRecommendationContext | undefined,
): PluginRecommendation {
  const recommended = context?.hasCustomSkills === true;
  return {
    id: pluginId("skill-creator"),
    recommended,
    because: recommended
      ? "this project authors its own skills, and skill-creator helps " +
        "draft, evaluate and tune them -- including their triggering " +
        "descriptions -- rather than iterating on them by hand."
      : "only useful to a project that authors its own skills; the " +
        "baseline's skills come maintained from upstream, so there is " +
        "nothing here for it to work on yet.",
  };
}

/**
 * `claude-code-setup`'s `claude-automation-recommender` skill is read-only:
 * it recommends hooks, subagents, skills, plugins and MCP servers for any
 * codebase but edits nothing. The overlap with `/customize` is partial.
 * Hooks, subagents, plugins and the skills those plugins supply are where the
 * two compete -- `/customize` already tailors hooks, subagents and plugins
 * against the baseline and edits the files, and its `harness-guidance` skill
 * has authority over skills, so the plugin's picks would duplicate or
 * contradict it (its skills table suggests skills from plugins this table
 * deliberately rejects, such as `commit`, `writing-rules` and `feature-dev`,
 * and it suggests a `code-reviewer` subagent the baseline already ships).
 * What it alone would add -- MCP server suggestions drawn mostly from the
 * project's dependencies and tooling signals, which `/customize` does not
 * make, plus project-domain skill ideas such as API docs, migrations or
 * component scaffolds -- is not enough to outweigh that conflict, so it is
 * never pre-selected; it is listed with that reason rather than silently
 * omitted, so the user can see why. TypeScript-toolchain gaps are a distinct
 * question from Claude Code automation and are answered instead by the
 * baseline `typescript-guidance` skill's `gaps` mode.
 */
function recommendClaudeCodeSetup(): PluginRecommendation {
  return {
    id: pluginId("claude-code-setup"),
    recommended: false,
    because:
      "its claude-automation-recommender skill is read-only: it suggests " +
      "hooks, subagents, skills, plugins and MCP servers but edits nothing. " +
      "It competes with /customize on hooks, subagents, plugins and the " +
      "skills those plugins supply, which /customize already tailors " +
      "against the baseline, so its picks would duplicate or contradict " +
      "them. What it alone would add is MCP server suggestions drawn mostly " +
      "from the project's dependencies, which /customize does not make, " +
      "plus project-domain skill ideas such as API docs or migrations. " +
      "TypeScript-toolchain gaps are answered instead by the baseline " +
      "typescript-guidance skill's gaps mode. Listed so the choice is " +
      "visible, not silently left out.",
  };
}

/**
 * `plugin-dev` carries the skills and agents for building a Claude Code
 * plugin itself -- manifests, hooks, commands, skills, MCP wiring -- so it is
 * pre-selected for the `plugin` kind, the only kind that authors one.
 */
function recommendPluginDev(): PluginRecommendation {
  return {
    id: pluginId("plugin-dev"),
    recommended: true,
    because:
      "this project authors a Claude Code plugin, and plugin-dev brings " +
      "guidance and validation for exactly that: the plugin manifest, " +
      "hooks, commands, skills, agents and MCP server wiring, plus the " +
      "marketplace entry it ships through.",
  };
}

/**
 * `frontend-design` is a single skill of visual design guidance -- palette,
 * type, layout, a list of "generated look" traits to avoid, and a
 * plan-then-build process -- with no hooks, commands or agents. It follows a
 * brief that pins down a visual direction, but by default its first pass
 * proposes its own palette and token system, which competes with a design
 * system the project already has. So it is pre-selected for the `frontend`
 * kind only when no existing design system was found.
 */
function recommendFrontendDesign(
  context: PluginRecommendationContext | undefined,
): PluginRecommendation {
  const recommended = !(context?.hasDesignSystem ?? false);
  return {
    id: pluginId("frontend-design"),
    recommended,
    because: recommended
      ? "it is one design-guidance skill -- palette, type, layout, " +
        "generated-look traits to avoid and a plan-then-build process -- " +
        "with no hooks or agents, and a frontend project has UI work to " +
        "apply it to. Pre-selected because no existing design system was " +
        "found in the project."
      : "not pre-selected because the project already has a design " +
        "system: by default this skill proposes its own palette and token " +
        "system, which competes with the project's existing one (it still " +
        "follows a brief that pins down a visual direction). It stays on " +
        "offer if that design system is only partial.",
  };
}

/**
 * Every built-in marketplace plugin's recommendation for the given interview
 * answers and context: always the same ten in the same order, plus an
 * eleventh appended last for two kinds only -- `plugin-dev` for the `plugin`
 * kind, `frontend-design` for the `frontend` kind.
 * Pre-selected unconditionally: `context7`, `typescript-lsp`,
 * `claude-md-management` and `claude-security`, plus `plugin-dev` whenever it
 * is present. Conditionally: `github` when the `github` pack was
 * chosen; `security-guidance` for a `service` or a `thorough` CI depth;
 * `skill-creator` when the project has its own skills; `agent-sdk-dev` and
 * `mcp-server-dev` when the project depends on the Claude Agent SDK or the
 * MCP SDK respectively; `frontend-design`, when present, unless the project
 * already has a design system (`hasDesignSystem`). Never:
 * `claude-code-setup`. A pure function -- identical inputs always produce an
 * equal result.
 *
 * @example
 * ```ts
 * import { recommendPlugins } from "./plugin-map.js";
 *
 * const recommendations = recommendPlugins(
 *   {
 *     kind: "service",
 *     runtime: "node",
 *     testsMandatory: true,
 *     ciDepth: "standard",
 *     keepAgents: ["code-reviewer"],
 *   },
 *   { chosenPacks: ["github"], dependencies: ["@modelcontextprotocol/sdk"] },
 * );
 * const preselected = recommendations.filter((r) => r.recommended);
 * ```
 */
export function recommendPlugins(
  answers: InterviewAnswers,
  context?: PluginRecommendationContext,
): PluginRecommendation[] {
  const fixed = [
    recommendContext7(),
    recommendTypescriptLsp(),
    recommendClaudeMdManagement(),
    recommendGithub(context),
    recommendSecurityGuidance(answers),
    recommendClaudeSecurity(),
    recommendSkillCreator(context),
    recommendClaudeCodeSetup(),
    recommendAgentSdkDev(context),
    recommendMcpServerDev(context),
  ];
  if (answers.kind === "plugin") return [...fixed, recommendPluginDev()];
  if (answers.kind === "frontend") {
    return [...fixed, recommendFrontendDesign(context)];
  }
  return fixed;
}

/**
 * One service-integration plugin: the exact package names and whole npm
 * scopes (written with their trailing `/`) that signal it, whether the
 * plugin ships skills beside its MCP server, an optional phrase saying how
 * the server serves the dependency, the caveat that closes its reasoning,
 * and its prerequisites.
 */
interface IntegrationSpec {
  readonly name: string;
  readonly exact: readonly string[];
  readonly scopes: readonly string[];
  readonly hasSkills: boolean;
  readonly serves?: string;
  readonly caveat: string;
  readonly prerequisites: readonly string[];
}

const LIVE_ACCOUNT =
  "Not pre-selected because the plugin connects Claude to a live account.";

const INTEGRATIONS: readonly IntegrationSpec[] = [
  {
    name: "playwright",
    exact: ["@playwright/test", "@playwright/mcp"],
    scopes: [],
    hasSkills: false,
    serves: " by driving a real browser",
    caveat:
      "Not pre-selected because its server downloads and runs unpinned " +
      "npm code at every launch.",
    prerequisites: [
      "Node.js 18 or newer",
      "the plugin's MCP server launches through " +
        "`npx @playwright/mcp@latest`, which is unpinned: it downloads and " +
        "runs npm code at every launch",
      "no account or sign-in is needed",
    ],
  },
  {
    name: "firebase",
    exact: ["firebase", "firebase-admin", "firebase-tools"],
    scopes: [],
    hasSkills: false,
    caveat: LIVE_ACCOUNT,
    prerequisites: [
      "Node.js and npm",
      "a Firebase (Google) account and a Firebase project",
      "`firebase login` (the server also has a login tool)",
      "the server launches through `npx -y firebase-tools@latest mcp`, " +
        "which is unpinned",
    ],
  },
  {
    name: "supabase",
    exact: [],
    scopes: ["@supabase/"],
    hasSkills: true,
    caveat:
      LIVE_ACCOUNT +
      " Note: the catalog entry's repository is under the " +
      "supabase-community org, although its manifest names Supabase as " +
      "author.",
    prerequisites: [
      "a Supabase account",
      "the MCP server signs in with OAuth 2.1 (a scoped personal access " +
        "token in a Bearer header is the CI alternative)",
    ],
  },
  {
    name: "neon",
    exact: ["@neon/ai-sdk-provider"],
    scopes: ["@neondatabase/"],
    hasSkills: true,
    caveat: LIVE_ACCOUNT,
    prerequisites: [
      "a Neon account",
      "OAuth sign-in on first use of the MCP tools",
    ],
  },
  {
    name: "prisma",
    exact: ["prisma", "@prisma/client"],
    scopes: [],
    hasSkills: false,
    caveat: LIVE_ACCOUNT,
    prerequisites: [
      "a Prisma account and workspace (sign-in for the remote server)",
      "the plugin also ships a local server that launches through " +
        "`npx -y prisma mcp`, which is unpinned",
    ],
  },
  {
    name: "sentry",
    exact: [],
    scopes: ["@sentry/"],
    hasSkills: true,
    caveat: LIVE_ACCOUNT,
    prerequisites: ["a Sentry account"],
  },
  {
    name: "cloudflare",
    exact: ["wrangler", "@cloudflare/ai-chat", "@cloudflare/sandbox"],
    scopes: [],
    hasSkills: true,
    caveat: LIVE_ACCOUNT,
    prerequisites: ["a Cloudflare account"],
  },
];

function integrationBecause(spec: IntegrationSpec, dependency: string): string {
  const surface = spec.hasSkills ? "MCP server and skills" : "MCP server";
  return (
    `${dependency} is among the project's dependencies, so this ` +
    `plugin's ${surface} would serve it${spec.serves ?? ""}. ${spec.caveat}`
  );
}

function matchesSpec(spec: IntegrationSpec, dependency: unknown): boolean {
  if (typeof dependency !== "string") return false;
  return (
    spec.exact.some((name) => name === dependency) ||
    spec.scopes.some((scope) => dependency.startsWith(scope))
  );
}

/**
 * The service-integration plugins worth offering for the project's
 * dependencies: `playwright`, `firebase`, `supabase`, `neon`, `prisma`,
 * `sentry` and `cloudflare`, each returned only when one of its verified
 * dependency signals is present, at most once, in that fixed order. None is
 * ever pre-selected (`recommended` is always false): each connects Claude to
 * a live account or runs unpinned code, which is the user's call to make.
 * Each `because` names the first matching dependency in the order the
 * context lists them, and `prerequisites` is always non-empty.
 *
 * An integration is offered only if its plugin ships an MCP server (and
 * sometimes skills) but no hooks and no default-on telemetry, and only on a
 * verified dependency signal: an exact package name or a whole npm scope,
 * never a bare prefix. Kept apart from {@link recommendPlugins}, whose ids
 * it never repeats. A pure function -- identical inputs always produce an
 * equal result, and the context is never mutated.
 *
 * @example
 * ```ts
 * import { recommendIntegrations } from "./plugin-map.js";
 *
 * const offers = recommendIntegrations({
 *   dependencies: ["@sentry/node", "prisma"],
 * });
 * const ids = offers.map((offer) => offer.id);
 * ```
 */
export function recommendIntegrations(
  context?: PluginRecommendationContext,
): PluginRecommendation[] {
  const dependencies: readonly unknown[] = context?.dependencies ?? [];
  const offers: PluginRecommendation[] = [];
  for (const spec of INTEGRATIONS) {
    const matched = dependencies.find((dependency) =>
      matchesSpec(spec, dependency),
    );
    if (typeof matched !== "string") continue;
    offers.push({
      id: pluginId(spec.name),
      recommended: false,
      because: integrationBecause(spec, matched),
      prerequisites: [...spec.prerequisites],
    });
  }
  return offers;
}
