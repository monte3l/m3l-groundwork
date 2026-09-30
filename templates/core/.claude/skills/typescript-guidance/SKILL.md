---
name: typescript-guidance
description: >-
  Three-mode TypeScript guidance skill. `research` mode answers a single
  TypeScript/toolchain question from owner-normative upstream sources only
  (typescriptlang.org, the devblog, microsoft/TypeScript releases,
  nodejs.org type stripping, typescript-eslint.io, attw, publint). `refresh`
  mode sweeps this project's whole TypeScript-facing surface — tsconfig,
  eslint, packaging, the test config/approach — against a living tracker and
  produces a remediation plan. `gaps` mode profiles the toolchain offline,
  then researches live before recommending tooling the project does NOT have
  yet, each recommendation with a source fetched that run. Use for
  /typescript-guidance, "what does the TypeScript team say about X", "are we
  behind on TypeScript", "is our tsconfig still current", "what tooling are
  we missing", or before changing a compiler flag. Not for a general Claude
  Code automation review, and not how this project's config is wired today
  — that's CLAUDE.md and the config files.
---

# typescript-guidance

One skill, three modes, sharing one allowlist
(`references/typescript-sources.md`) so they can't drift apart. Pick the
mode by what's actually being asked, not by surface phrasing. First, is the
thing not configured at all? "What are we missing", "any gaps in our
toolchain", "should we add typed linting" are `gaps` even when they name one
tool, because absence decides it. Otherwise a question that names one flag,
one setting, or one narrow facet — even when phrased as "is X still
current" — stays `research`, because there's one thing to look up and
answer. A request that names no specific facet, that asks
about the whole TypeScript-facing surface ("our tsconfig", "our toolchain",
"are we behind"), or that's periodic/`/customize`-driven, is `refresh`. A
request about tooling the project **doesn't have at all** is `gaps`,
whereas "X is configured, is it still right" is `research` or `refresh`,
never `gaps`. When genuinely torn between `research` and `refresh`, default
to `research` — it's cheaper and faster — and say in the answer that a full
`refresh` sweep is available if the question turns out to implicate more
than the one facet asked about.

**Must only run in the main (hub) agent, never inside a subagent** — it ends
in `EnterPlanMode` (refresh) or an `AskUserQuestion` (research or refresh,
occasionally), and every mode launches parallel `Explore` research agents,
none of which a subagent can do (`disallowedTools: Agent` on every spoke).

**No files are written by this skill itself** in research mode by default;
refresh mode writes to exactly one file, the tracker, in Step 5; `gaps` mode
never writes a file — it proposes, and hands any accepted recommendation to
`starting-work` and the normal TDD pipeline.

## Authority (read this before any mode)

This skill has authority over **every TypeScript-facing file in the
project** — `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`,
`vitest.config.ts` (config **and** the testing approach itself, not just
its config shape), `package.json`'s TypeScript-toolchain entries, packaging
(`exports`, `check-exports.mjs`), and the toolchain steps in
`.github/workflows/*.yml`. An interview-derived emphasis (from
`/customize`'s kind-to-facet table) tells this skill which facet to research
**most deeply**, never which facets it may or may not touch. A facet with
low priority still gets swept; it just gets less dedicated attention per run.

`gaps` mode never overlaps that authority. It covers what's **missing** — a
flag, script, config block or package the project doesn't have configured at
all. Drift in something that already exists is `research`'s or `refresh`'s
question and is never re-answered under `gaps`; if a `gaps` profile turns out
to be "configured but looks stale", say so and switch mode instead of
writing a recommendation. Any compiler-flag or config change `gaps`
proposes goes through `research` before it is implemented: `gaps`' live
research is scoped to "does this exist, and what's the current recommended
shape if we add it", and doesn't carry `research`'s full precedence and
conflict-resolution machinery for an existing value.

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
   facet id, and this verdict format per claim:

   ```
   CLAIM: <the tracker's prior claim, or "NEW" if none existed>
   VERDICT: UNCHANGED | CHANGED | GONE
   NOW: <the current upstream position, with tier>
   REPO-IMPACT: <which emitted file(s) this affects, or "none">
   ```

   Return value: **the full verdict list inline, inside the ~8,000-character
   cap** -- `Explore` holds no write tool, so it cannot write a file. Put
   every non-"none" REPO-IMPACT claim first so a truncation drops only
   the no-impact ones. The hub saves each returned report to
   `<run-dir>/<facet-id>.md` itself; that is what step 4 reads.

4. **Aggregate.** Read every saved facet report in full. Four buckets:
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

## Gaps mode

Recommends TypeScript-ecosystem **tooling the project doesn't have yet** and
never rules on tooling it already has. Every recommendation is grounded on
official guidance fetched **live**, in this run: cross-project compatibility
state (a new TypeScript major before `typescript-eslint` supports it, a
package-manager major dropping a setting) shifts on its own schedule, so
anything baked into this file as a fixed answer would go stale within months.
This mode ships no answers, only where to look and what to ask.

1. **Profile (offline; no network calls).** Establish what the project
   already has before researching anything:
   - `package.json`'s `scripts`, `dependencies`, `devDependencies`, and
     `pnpm-workspace.yaml` (workspaces, `catalog`/`catalogs`) if present;
   - the resolved tsconfig chain — every `tsconfig*.json` following
     `extends`, using `bin/lib/toolchain-rules.mjs`'s tsconfig-chain
     resolution if it exists rather than re-deriving the rules by hand;
   - lint/test/hygiene config — `eslint.config.*` (or `.eslintrc.*`),
     `vitest.config.ts` (or another runner's), `knip.json`;
   - existing gates — run `node bin/check-toolchain.mjs` if present, and
     read `.groundwork/inventory.json` if present (its `toolchainGrade` and
     `toolchainConformance` are exactly this profile, already computed);
   - budget — count `.claude/agents/*.md`, `.claude/skills/*/`,
     `.claude/hooks/*.{mjs,js}`, `.github/workflows/*.yml` and
     `package.json`'s `scripts` keys if the project states a cap on any of
     them (`CLAUDE.md`, or an adoption report's cap table): with no room
     left, prefer a `verify-steps` gate over a new `package.json` script;
   - verify-step wiring — `bin/lib/verify-steps.mjs` /
     `bin/lib/verify-steps.packs.json`, or whatever gate runner exists.

   Map every signal to the areas in `references/area-catalog.md`, which names
   the signals to look for and the questions to research per area and holds
   no answers of its own. An area with no signal at all (no monorepo hints,
   no release workflow) still gets a light pass: "you have none of this,
   here is what to consider" is itself a recommendation, not silence.

2. **Research live (mandatory).** No recommendation reaches the report
   without a source fetched in this run. Read `references/tooling-sources.md`
   (the ecosystem-tooling allowlist) and `references/typescript-sources.md`
   (the TypeScript-owner allowlist, reused rather than duplicated). Pick the
   areas from `area-catalog.md` that the profile made relevant — or only the
   one category the user named. **Launch all agents in a single message**,
   always `subagent_type: "Explore"`, breadth `"very thorough"`, one per
   relevant area. Each brief carries: that area's signals-and-questions
   verbatim; both allowlists pasted verbatim, each with its own GitHub-path
   caveat kept separate (a domain allowed by one file's caveat is not
   automatically allowed by the other's); today's date; "reject any
   non-allowlisted domain outright and say so, rather than substituting a
   blog post or an individual author's material"; "you hold no write tool —
   findings travel only in your response"; research mode's findings format
   above; and an ~8,000-character (~2,000-token) return cap. Read every
   agent's full inline findings. A failed or empty fetch for an area is a
   **coverage gap**, reported as such — never dropped, never backfilled from
   an unlisted source.
3. **Report.** In this order:
   - **Codebase profile** — a short summary of what step 1 found, so the
     reader can see the recommendations are grounded in this project.
   - **Recommendations** — 1–2 per relevant area (3–5 for a single area the
     user named). Each gives: **Why** (the specific project signal, not
     "generally good practice"), **What** (the concrete config block, script
     or package to add), **Source** (the URL, fetched today, with its tier),
     and **Cost** (cap impact, and whether it's a `verify-steps` gate or a
     `package.json` script).
   - **Unverified claims** — a signal step 2 could not verify against an
     allowlisted source is named as "unverified — not recommended", not
     omitted.
   - **No web tools at all** (offline, sandboxed): report the profile alone,
     say plainly that no live research ran, and recommend nothing — an
     unverified recommendation is worse than none.
   - **Hand-off** — point any accepted recommendation at `starting-work`
     (branch first) and the normal test-author → code-implementer →
     review-spoke pipeline. This mode never writes the change itself.

**Recommendation discipline.** Never recommend adding a tool or preset that
live research shows doesn't yet support the project's current toolchain
version: recommending something that can't be installed against the
already-pinned TypeScript is worse than recommending nothing, so name the
incompatibility as a blocker instead. (Second-guessing a version the project
already pinned is `research`'s territory, not this mode's.) When the
project's scripts are at their cap, prefer a `verify-steps` gate
(`["node", "bin/check-x.mjs"]`, no `package.json` script needed) over a new
script.

## Why this exists, separately from "how is our config wired"

Research mode answers "what does upstream say about X." Nothing else in the
baseline asks the inverse — "is what's already configured still what
upstream recommends" — because every lint/typecheck/test gate is a closed
loop checking the repo against its own prior decisions. A stale pin one
major behind upstream passes every one of those gates cleanly; only a live
sweep against the actual upstream surfaces it. For the same reason, a
missing tool trips no gate at all — nothing fails when a check that was
never installed doesn't run — which is what `gaps` mode is for.
