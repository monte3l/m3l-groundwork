// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The plugin recommendation table `/customize` reads in Step 3 to pre-select
 * which built-in `claude-plugins-official` marketplace plugin(s) to offer,
 * with the evidence shown alongside each recommendation -- the same
 * "inference happens once, visibly, with its reasoning attached" principle
 * `pack-map.ts` applies to `templates/packs/` bundles. A stored, unit-tested
 * module rather than a judgment made afresh each run, so the same interview
 * answers and context always produce the same recommendation.
 *
 * Evaluated and deliberately not offered, recorded so they are not proposed
 * again:
 *
 * - `plugin-dev` -- only for projects that author Claude Code plugins;
 *   m3l-groundwork itself enables it, a bootstrapped TypeScript project has
 *   no plugin to build, and `skill-creator` covers skill authoring.
 * - `code-review` -- duplicates the built-in `/code-review` and the optional
 *   `github` pack's PR-review Action.
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
 * `claude-code-setup` recommends automations (hooks, skills, MCP servers,
 * subagents) for a codebase -- which is exactly the job `/customize` is
 * already doing, against a baseline designed for it. Running both would
 * produce two competing sets of suggestions, so it is never pre-selected;
 * it is listed with that reason rather than silently omitted, so the user
 * can see why. TypeScript-toolchain gaps are a distinct question from Claude
 * Code automation and are answered instead by the baseline
 * `typescript-guidance` skill's `gaps` mode.
 */
function recommendClaudeCodeSetup(): PluginRecommendation {
  return {
    id: pluginId("claude-code-setup"),
    recommended: false,
    because:
      "its automation recommender overlaps what /customize is already " +
      "doing -- tailoring hooks, skills and agents to this project against " +
      "the baseline -- so enabling it would produce a second, competing " +
      "set of suggestions. TypeScript-toolchain gaps are a separate " +
      "question from Claude Code automation, and are answered instead by " +
      "the baseline typescript-guidance skill's gaps mode with " +
      "live-researched, cited recommendations. " +
      "Listed so the choice is visible, not silently left out.",
  };
}

/**
 * Every built-in marketplace plugin's recommendation for the given interview
 * answers and context, always the same ten in the same order. Pre-selected
 * unconditionally: `context7`, `typescript-lsp`, `claude-md-management` and
 * `claude-security`. Conditionally: `github` when the `github` pack was
 * chosen; `security-guidance` for a `service` or a `thorough` CI depth;
 * `skill-creator` when the project has its own skills; `agent-sdk-dev` and
 * `mcp-server-dev` when the project depends on the Claude Agent SDK or the
 * MCP SDK respectively. Never: `claude-code-setup`. A pure function --
 * identical inputs always produce an equal result.
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
  return [
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
}
