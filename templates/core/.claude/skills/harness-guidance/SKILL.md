---
name: harness-guidance
description: >-
  Dual-mode Claude Code harness guidance skill. `research` mode answers a
  single Claude Code / Anthropic-guidance question from official sources
  only (anthropic.com, claude.com, code.claude.com, docs.claude.com, the
  Claude Code CHANGELOG). `refresh` mode sweeps this project's whole
  `.claude/` surface — settings, hooks, agents, skills, rules — against a
  living tracker and produces a remediation plan. Use for
  /harness-guidance, "what does Anthropic recommend for X", "is our harness
  up to date with Anthropic", "model pins current". Not how this project's
  harness is wired today — that's CLAUDE.md and the `.claude/` files
  themselves.
---

# harness-guidance

One skill, two modes, sharing one allowlist
(`references/official-sources.md`) so they can't drift apart. Pick the mode
from how you were invoked: a specific question → `research`; a periodic or
`/customize`-driven sweep → `refresh`.

**Must only run in the main (hub) agent, never inside a subagent** — it ends
in `EnterPlanMode` (refresh) or dispatches other agents (either mode), which
a subagent cannot do (`disallowedTools: Agent`).

**No files are written by this skill itself** in research mode by default;
refresh mode writes to exactly one file, the tracker, in Step 5.

## Authority (read this before either mode)

This skill has authority over the **whole `.claude/` surface** —
`settings.json` and its hook wiring, every hook, every agent (frontmatter,
model tiering, tool grants), every skill, every rule, and the emitted
`CLAUDE.md`. It is **not** kind-scoped the way the interview's other answers
are: the harness a project needs does not vary by whether it's a library or
a frontend app, with one deliberate exception below. An interview-derived
emphasis (from `/customize`'s kind-to-facet table) tells this skill which
facet to research **most deeply**, never which facets it may or may not
touch.

**The one kind-keyed exception:** a `frontend`/web-app project's reviewer
patterns genuinely differ (visual verification of a UI is a real, distinct
concern) — every other facet below is identical regardless of project kind.

## Research mode

1. **Scope the topic.** Read the topic from the invocation or the
   surrounding task; at most **one** clarifying question, otherwise infer
   and proceed. Derive **3–5 orthogonal facets** — one per Explore agent.
   Derive a kebab-case slug for the optional Step 5 snapshot.
2. **Fan out.** Read `references/official-sources.md` first, then spawn
   **all agents in a single message**. Each brief carries: one facet; the
   allowlist + GitHub caveat pasted verbatim; today's date; "do not stop at
   the first matching source — fetch every distinct one"; "reject any
   non-allowlisted domain outright and say so"; "you hold no write tool —
   findings travel only in your response"; the findings format below; and a
   ~8,000-character (~2,000-token) return cap. Always `subagent_type:
"Explore"`, breadth `"very thorough"`.

   Findings format, one block per source:

   ```
   SOURCE: <URL>
   CLAIM: <the specific claim, quoted or tightly paraphrased>
   CONFLICT-WITH: <another SOURCE, if this claim contradicts it — omit if none>
   ```

3. **Aggregate & synthesize.** Read every agent's full inline findings —
   digests are for triage, not synthesis. Assign `S1, S2, …` deduping; merge
   agreement into single consensus points tagged with all supporting ids;
   flag contradictions — current docs outrank an older blog post; a
   model-specific guide outranks a general one.
4. **Ask a clarifying question only if genuinely needed** — only when two
   current, equally authoritative sources conflict in a way that changes the
   invoking task.
5. **Offer an optional snapshot.** Default is inline-only. On explicit
   confirmation, write `docs/research/harness/<topic-slug>.md`, assembled
   from Step 2's findings + Step 3's synthesis (not re-fetched), with a `>
**Provenance** —` header naming today's date and the sources consulted.

## Refresh mode

1. **Read the tracker & establish anchors.** Read
   `docs/research/harness-refresh.md`, its header
   `<!-- harness-refresh: last-verified=<date> claude-code-version=<version> -->`.
   Missing tracker/facet → first run, `NEW` only. Then read the allowlist
   file; state today's date; derive a run directory
   `<scratchpad>/harness-refresh-<date>/`.
2. **Build the delta.** `WebFetch` the Claude Code CHANGELOG, extract
   entries newer than the recorded version. An unreachable source is a
   coverage gap, not a blocker. Pass this delta into all five briefs below
   — it is not a sixth facet.
3. **Fan out five fixed facets in one message** — fixed, not derived per
   run, so sweeps stay comparable and the tracker stays diffable:

   | Facet id                     | Emitted surface it validates                                         |
   | ---------------------------- | -------------------------------------------------------------------- |
   | `models-tiering`             | agent frontmatter `model`/`effort` fields                            |
   | `cc-features-settings`       | `settings.json` shape, permissions, hook event coverage              |
   | `agent-subagent-design`      | the 5 agents, tool grants, `disallowedTools`, the hub-and-spoke loop |
   | `skills-context-engineering` | the skills, frontmatter, description length                          |
   | `hooks-lifecycle`            | the 10 hooks, event names, matchers, the exit-code contract          |

   Each brief carries: the facet row, Step 2's delta, the tracker's prior
   claims for that facet, the allowlist + GitHub caveat + date anchor, the
   exact filename to write (`<run-dir>/<facet-id>.md`), and this verdict
   format per claim:

   ```
   CLAIM: <the tracker's prior claim, or "NEW" if none existed>
   VERDICT: UNCHANGED | CHANGED | GONE
   NOW: <the current official position>
   REPO-IMPACT: <which emitted file(s) this affects, or "none">
   ```

   Return value: **write the full file, return only a compact digest**
   (counts per verdict + every non-"none" REPO-IMPACT line + the file path).

4. **Aggregate.** Read every scratchpad file in full. Four buckets:
   confirmed drift with repo impact (verify each against the cited file
   itself before trusting it — an agent can misread a page), guidance
   changes with no impact, dead/moved URLs, coverage gaps.
5. **Update the tracker in place** (not a new dated file) — this skill's
   only write outside plan mode. Bump the header date + version, update
   every checked claim's text/URL/date, add `NEW` sources, update the
   outstanding-drift table.
6. **`EnterPlanMode`** with a remediation plan, one section per
   confirmed-drift item. No drift → skip plan mode, report a clean sweep,
   still update the tracker.

## Why this exists, separately from "how is our harness wired"

Research mode answers "what does Anthropic recommend for X." Nothing else in
the baseline asks the inverse — "is what's already built still what
Anthropic currently recommends" — because a locally-passing `check:agents`/
`check:hooks`-style check only verifies internal consistency, never freshness
against the outside world. A retired model pin or a deprecated hook pattern
passes every internal-consistency check cleanly; only a live sweep against
Anthropic's own current docs surfaces it.
