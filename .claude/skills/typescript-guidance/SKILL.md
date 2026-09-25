---
name: typescript-guidance
description: >-
  Dual-mode TypeScript guidance skill. `research` mode answers a single
  TypeScript/toolchain question from owner-normative upstream sources only
  (typescriptlang.org, the devblog, microsoft/TypeScript releases,
  nodejs.org type stripping, typescript-eslint.io, attw, publint). `refresh`
  mode sweeps this project's whole TypeScript-facing surface — tsconfig,
  eslint, packaging, and the test config/approach — against a living
  tracker and produces a remediation plan. Use for /typescript-guidance,
  "what does the TypeScript team say about X", "are we behind on
  TypeScript", "is our tsconfig still current", or before changing a
  compiler flag. Not how this project's config is wired today — that's
  CLAUDE.md and the config files themselves.
---

# typescript-guidance

One skill, two modes, sharing one allowlist
(`references/typescript-sources.md`) so they can't drift apart. Pick the
mode from how you were invoked: a specific question → `research`; a
periodic or `/customize`-driven sweep → `refresh`.

**Must only run in the main (hub) agent, never inside a subagent** — it ends
in `EnterPlanMode` (refresh) or an `AskUserQuestion` (either mode,
occasionally), neither of which a subagent can do.

**No files are written by this skill itself** in research mode by default;
refresh mode writes to exactly one file, the tracker, in Step 5.

## Authority (read this before either mode)

This skill has authority over **every TypeScript-facing file in the
project** — `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`,
`vitest.config.ts` (config **and** the testing approach itself, not just
its config shape), `package.json`'s TypeScript-toolchain entries, packaging
(`exports`, `check-exports.mjs`), and the toolchain steps in
`.github/workflows/*.yml`. An interview-derived emphasis (from
`/customize`'s kind-to-facet table) tells this skill which facet to research
**most deeply**, never which facets it may or may not touch. A facet with
low priority still gets swept; it just gets less dedicated attention per run.

## Research mode

1. **Scope the topic.** Read the topic from the invocation or the
   surrounding task; at most **one** clarifying question, otherwise infer
   and proceed. Derive **3–5 orthogonal facets** — one per Explore agent.
   Derive a kebab-case slug for the optional Step 5 snapshot.
2. **Fan out.** Read `references/typescript-sources.md` first, then spawn
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
   TIER: T1 | T2
   CLAIM: <the specific claim, quoted or tightly paraphrased>
   CONFLICT-WITH: <another SOURCE, if this claim contradicts it — omit if none>
   ```

3. **Aggregate & synthesize.** Read every agent's full inline findings —
   digests are for triage, not synthesis. Assign `S1, S2, …` deduping; merge
   agreement into single consensus points tagged with all supporting ids;
   flag contradictions. Precedence when two sources disagree: T1 outranks
   T2; within T1, a devblog release post outranks the Handbook (the Handbook
   lags a release); nodejs.org is co-normative for the runtime boundary — a
   genuine Microsoft/Node disagreement must be surfaced, never silently
   arbitrated.
4. **Ask a clarifying question only if genuinely needed** — only when two
   current, equally authoritative sources conflict in a way that changes the
   invoking task.
5. **Offer an optional snapshot.** Default is inline-only. On explicit
   confirmation, write `docs/research/typescript/<topic-slug>.md`, assembled
   from Step 2's findings + Step 3's synthesis (not re-fetched), with a `>
**Provenance** —` header naming today's date and the sources consulted.

## Refresh mode

1. **Read the tracker & establish anchors.** Read
   `docs/research/typescript-refresh.md`, its header
   `<!-- typescript-refresh: last-verified=<date> typescript-version=<version> -->`
   — deliberately the newest **upstream** version last verified, distinct
   from `package.json`'s own `typescript` pin, which this tracker exists to
   check against, not restate. Missing tracker/facet → first run, `NEW`
   only. Then read the allowlist file; state today's date; derive a run
   directory `<scratchpad>/ts-refresh-<date>/`.
2. **Build the delta.** `WebFetch` the devblog index and
   `github.com/microsoft/TypeScript/releases`; extract entries newer than
   the recorded version. An unreachable source is a coverage gap, not a
   blocker. Pass this delta into all five briefs below — it is not a sixth
   facet.
3. **Fan out five fixed facets in one message** — fixed, not derived per
   run, so sweeps stay comparable and the tracker stays diffable:

   | Facet id                     | Emitted surface it validates                                                            |
   | ---------------------------- | --------------------------------------------------------------------------------------- |
   | `compiler-config-flags`      | `tsconfig.base.json`, `tsconfig.json`                                                   |
   | `modules-esm-node-interop`   | `guard-js-extension.mjs`, `guard-no-commonjs.mjs`, the `import-x/extensions` rule       |
   | `packaging-declaration-emit` | `check-exports.mjs`, the `exports` map, `isolatedDeclarations`                          |
   | `lint-typing-rules`          | `eslint.config.js`'s preset composition                                                 |
   | `testing-language-features`  | `vitest.config.ts`, the coverage gate, the choice of runner and testing approach itself |

   Each brief carries: the facet row, Step 2's delta, the tracker's prior
   claims for that facet, the allowlist + GitHub caveat + date anchor, the
   exact filename to write (`<run-dir>/<facet-id>.md`), and this verdict
   format per claim:

   ```
   CLAIM: <the tracker's prior claim, or "NEW" if none existed>
   VERDICT: UNCHANGED | CHANGED | GONE
   NOW: <the current upstream position, with tier>
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

## Why this exists, separately from "how is our config wired"

Research mode answers "what does upstream say about X." Nothing else in the
baseline asks the inverse — "is what's already configured still what
upstream recommends" — because every lint/typecheck/test gate is a closed
loop checking the repo against its own prior decisions. A stale pin one
major behind upstream passes every one of those gates cleanly; only a live
sweep against the actual upstream surfaces it.
