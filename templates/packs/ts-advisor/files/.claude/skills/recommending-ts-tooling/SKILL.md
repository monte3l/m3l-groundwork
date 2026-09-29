---
name: recommending-ts-tooling
description: >-
  Profiles this project's TypeScript toolchain offline, then researches
  current official guidance live before recommending TypeScript-ecosystem
  tooling the project is missing -- tsconfig flags, module resolution, typed
  linting, testing, packaging validation, dependency hygiene, pnpm
  supply-chain settings, scripts/verify gates, monorepo/catalogs, Node
  pinning, release automation. Every recommendation cites a source fetched in
  this run; a claim with no live citation is reported unverified, not
  recommended. Use for /recommending-ts-tooling, "what tooling are we
  missing", "recommend TypeScript tooling for this project", "are there gaps
  in our toolchain", or from /customize's Round 2 when this pack is
  installed. Not for "is our tsconfig current" or a question naming one
  specific flag/tool -- that is typescript-guidance's research mode, and not
  for a general Claude Code automation review -- that is claude-code-setup.
---

# recommending-ts-tooling

Recommends TypeScript-ecosystem **tooling the project doesn't have yet** --
never a verdict on tooling it already has, which is `typescript-guidance`'s
job (see "Authority split" below). Every recommendation is grounded on
official guidance fetched **live**, in this run -- a real historical example
of why: TypeScript 7.0 went GA on 2026-07-08 while `typescript-eslint` still
capped support below `6.1.0`, and pnpm 11 removed `onlyBuiltDependencies`.
Cross-project compatibility state like that shifts on its own schedule, not
this skill's -- anything baked into its own body as a fixed answer would go
stale within months. This skill ships no answers, only where to look and
what to ask.

**Hub-only.** Never dispatched as a spoke's own tool -- it launches parallel
`Explore` research agents itself (Phase 2), which a subagent cannot do
(`disallowedTools: Agent` on every spoke).

**Read-only.** This skill never edits a file. Its report ends by routing any
accepted recommendation through `starting-work` and the normal TDD pipeline
-- it proposes, it never implements.

## Authority split (read this before Phase 1)

`typescript-guidance` has full authority over every TypeScript-facing file
already in the project -- read its own `SKILL.md` "Authority" section for the
exact file list rather than trusting a restatement here, which would drift
out of sync with it over time. This skill never overlaps that authority:

- **This skill covers what's missing.** A recommendation names a flag,
  script, config block, or package the project does not have configured at
  all.
- **Drift in something that already exists is `typescript-guidance`'s
  question**, answered by its `refresh` mode (a whole-surface sweep) or its
  `research` mode (one named facet) -- never re-answered here.
- **Any compiler-flag or config change this skill proposes goes through
  `typescript-guidance research` before it is implemented**, not straight to
  `starting-work`. This skill's own live research is scoped to "does this
  exist, and what's the current recommended shape if we add it" -- it does
  not carry `typescript-guidance`'s full precedence/conflict-resolution
  machinery for an existing value.

If a Phase 1 signal turns out to be "this is configured but looks
stale" rather than "this is absent," say so and hand it to
`typescript-guidance` instead of writing a recommendation for it here.

## Phase 1 — Profile (offline)

Establish what the project already has before researching anything. No
network calls in this phase.

1. **Package surface.** `package.json`'s `scripts`, `dependencies` and
   `devDependencies`; `pnpm-workspace.yaml` if present (workspaces,
   `catalog`/`catalogs`).
2. **The resolved tsconfig chain.** Every `tsconfig*.json`, following
   `extends`, the same way the baseline's own toolchain grader resolves it
   (`bin/lib/toolchain-rules.mjs`'s tsconfig-chain resolution, if present) --
   don't re-derive resolution rules by hand if that file exists.
3. **Lint/test/hygiene config.** `eslint.config.{js,mjs,ts}` (or
   `.eslintrc.*`), `vitest.config.ts` (or another test runner's config),
   `knip.json`.
4. **Existing gates.** Run `node bin/check-toolchain.mjs` if it exists in
   this project, and read `.groundwork/inventory.json` if present (its
   `toolchainGrade`/`toolchainConformance` fields are exactly this profile,
   already computed).
5. **Budget.** Count `.claude/agents/*.md`, `.claude/skills/*/`,
   `.claude/hooks/*.{mjs,js}`, `.github/workflows/*.yml`, and
   `package.json`'s `scripts` keys, if this project tracks a cap on any of
   them (check `CLAUDE.md` for a stated limit, or an adoption report's own
   cap table for an adopted project) -- knowing there's no room left changes
   Phase 3's cost framing (prefer a `verify-steps` gate over a new
   `package.json` script when scripts are already at their cap).
6. **Verify-step wiring.** `bin/lib/verify-steps.mjs` /
   `bin/lib/verify-steps.packs.json`, or whatever this project's own gate
   runner actually is.

Map every signal you find to the areas in `references/area-catalog.md` --
that file names the signals to look for and the questions to research per
area; it holds no answers of its own. Areas with no signal at all (nothing
suggesting a monorepo, no release workflow) are still worth a light pass in
Phase 2, since "you have none of this and here's what to consider" is itself
a recommendation, not just silence.

## Phase 2 — Live research (mandatory)

**No recommendation reaches Phase 3 without a source fetched in this run.**
Skipping this phase because "the answer seems obvious" is exactly the
failure mode the allowlist-and-citation discipline exists to prevent.

1. Read `references/tooling-sources.md` (this pack's own allowlist) --
   its own header names the exact path to `typescript-guidance`'s
   TypeScript-owner allowlist file, reused rather than duplicated (see
   `pack.json`'s `adoptNotes` for the fallback if that file is missing).
2. Pick the **relevant** areas from `references/area-catalog.md` --
   relevant to what Phase 1 actually found, not every area unconditionally.
   If the user's request named one category, scope research to that
   category only.
3. **Launch all research agents in a single message**, always
   `subagent_type: "Explore"`, breadth `"very thorough"` -- one per relevant
   area. Each brief carries, verbatim:
   - the one area's signals-and-questions from `area-catalog.md`;
   - both allowlists (pasted verbatim), each with its own GitHub-path
     caveat kept separate -- a domain allowed by one file's caveat is not
     automatically allowed by the other's;
   - today's date;
   - "reject any non-allowlisted domain outright and say so, rather than
     substituting a blog post or an individual author's material";
   - "you hold no write tool -- findings travel only in your response";
   - the findings format below;
   - an ~8,000-character (~2,000-token) return cap.

   Findings format, one block per source:

   ```
   SOURCE: <URL>
   TIER: T1 | T2
   CLAIM: <the specific claim, quoted or tightly paraphrased>
   CONFLICT-WITH: <another SOURCE, if this claim contradicts it -- omit if none>
   ```

4. Read every agent's full inline findings. A failed or empty fetch for an
   area is a **coverage gap** for that area, reported as such in Phase 3 --
   never silently dropped, never backfilled from an unlisted source.

## Phase 3 — Report

1. **Codebase profile** -- a short summary of what Phase 1 found, so the
   reader can see the recommendations are grounded in this project, not
   generic advice.
2. **Recommendations** -- 1-2 per relevant area by default, 3-5 for a single
   area the user asked about by name. Each one gives:
   - **Why** -- the specific project signal that makes this relevant (not
     "this is generally good practice").
   - **What** -- the concrete config block, script, or package to add.
   - **Source** -- the URL, fetched today, with its tier.
   - **Cost** -- cap impact (a new skill/hook/script/agent against the
     budget from Phase 1 step 5), and whether it's a `verify-steps` gate or
     a `package.json` script.
3. **No claim without a live citation.** A signal Phase 2 could not verify
   against an allowlisted source is reported as "unverified -- not
   recommended," named explicitly rather than omitted.
4. **No web tools available at all** (offline, sandboxed): skip straight to
   reporting the Phase 1 profile alone, say plainly that no live research
   ran, and recommend nothing -- an unverified recommendation is worse than
   none.
5. **Hand off implementation.** End the report by pointing any accepted
   recommendation at `starting-work` (branch first) and the normal
   test-author -> code-implementer -> review-spoke TDD pipeline. This skill
   never writes the change itself.

## Recommendation discipline

- **Never recommend adding a tool or preset that live research shows doesn't
  yet support the project's current toolchain version.** The TS 7.0 /
  `typescript-eslint` example above is exactly this case: recommending a
  preset that can't actually be installed against the project's already-pinned
  TypeScript version is worse than recommending nothing. Name the
  incompatibility as a blocker instead. This is about what you're proposing
  to **add** -- second-guessing a version the project has already pinned is
  `typescript-guidance`'s territory, not this skill's (see "Authority split").
- **When the project's own scripts are at their cap**, prefer a
  `verify-steps` gate (`["node", "bin/check-x.mjs"]`, no `package.json`
  script needed) over adding a new script -- same reasoning
  `templates/packs/README.md`'s wiring contract documents for a pack's own
  gate.
