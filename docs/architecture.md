# Architecture

A high-level map of how m3l-groundwork is put together, for anyone reading
the project rather than editing it. [`CLAUDE.md`](../CLAUDE.md) is the
detailed, agent-facing reference this document distills from -- follow its
links for anything not covered here.

## The two-phase split

```
                 ┌─────────────────────────────────────────────────┐
                 │  Phase A -- packages/cli  (deterministic, offline) │
                 └─────────────────────────────────────────────────┘
  target dir ──▶  mode.ts (auto-detect)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   FRESH mode               ADOPT mode
   (empty/missing dir)      (existing project dir)
        │                       │
   emit.ts writes           survey/*.ts reads the
   templates/core/          project READ-ONLY, never
   + any --pack             writes it
        │                       │
   git init, pnpm            conflicts.ts diffs the
   install                   baseline against reality
        │                       │
        ▼                       ▼
   a working project      .groundwork/inventory.json
   with the harness        + adoption-report.md
   already installed        + guarded /customize copy

                 ┌─────────────────────────────────────────────────┐
                 │  Phase B -- packages/plugin  (adaptive, in Claude)│
                 └─────────────────────────────────────────────────┘
   /customize skill, run inside the bootstrapped or adopted project:
     - fresh: interviews the owner, tailors the baseline deterministically
     - adopted: Step 0 reconciles the survey against the real repo first
     - either way: a live guidance sweep over current TypeScript and
       Anthropic sources (typescript-guidance / harness-guidance skills)
```

The split exists because determinism and freshness can't live in one
artifact. Phase A has to be reproducible: same input, same output, no
network call beyond the final install, no LLM in the loop. Phase B has to
go and look at what TypeScript and Anthropic currently recommend, which by
definition can't be baked into a deterministic CLI shipped on some past
date.

## Phase A internals

- **`mode.ts`** decides fresh vs. adopt from the target directory's
  contents; `--fresh`/`--adopt` override it.
- **`emit.ts`** walks a template tree and writes it into the target,
  applying `tokens.ts`'s plain `__KEY__` string substitution -- not a
  templating engine, deliberately (see [`CLAUDE.md`](../CLAUDE.md)).
- **`survey/*.ts`** (adopt mode) is an index, not an interpretation: each
  collector records verifiable facts (which files exist, their content,
  which keys are set) and never infers a verdict. Anything a collector
  can't parse goes into `ProjectSurvey.undetermined` rather than being
  silently dropped.
- **The harness and toolchain graders** (`src/harness/`, `src/toolchain/`)
  each have two implementations that must stay identical: the TypeScript
  version that feeds the adoption report, and an emitted ESM twin every
  bootstrapped project runs as its own `pnpm verify` step. A parity test
  runs both against the same fixtures and fails if they disagree.
- **`packs.ts`** loads and installs optional bundles from
  `templates/packs/`. A pack only ever adds files and extends three JSON
  files the baseline already reads (`merge-json.ts`) -- never YAML, never
  JavaScript. Fresh mode installs a requested pack directly; adopt mode
  only surveys and stages it under `.groundwork/packs/` for `/customize` to
  install after confirmation.
- **`assets.ts`** is the one place that locates `templates/` and the plugin
  payload, whether running from the source checkout or a published npm
  tarball -- see its own header comment for why the probe order matters.

## Phase B internals

`packages/plugin/skills/customize/SKILL.md` drives the interview (fresh) or
reconciliation (adopted), then hands off to two guidance skills that each
have full authority over their entire domain (`typescript-guidance`,
`harness-guidance`), not just the facets an interview answer happened to
emphasize. `packages/plugin/src/domain-map.ts` is the structural guarantee
that every file `templates/core/` ships is claimed by exactly one of those
two domains or an explicit neutral allowlist -- checked by a test that
walks the real template tree on every run.

## Single source of truth for gates

`bin/lib/verify-steps.mjs` is what `pnpm verify`, `lefthook`'s `pre-push`,
and every CI lane job read, keyed by group (`format`/`lint`/`typecheck`/
`build`/`test`) rather than by individual step. The emitted baseline
(`templates/core/bin/lib/verify-steps.mjs`) has the identical shape, plus
`CORE_STEPS` and pack-contributed steps. Neither YAML file (`ci.yml`,
`lefthook.yml`) ever names an individual step id -- that's what lets a new
gate join every lane at once without touching either file, and it's also
what a structural check (`gate-lane-parity`, part of the toolchain grader)
verifies by scraping both files as text.

## Trust boundaries and threat model

See [`docs/assurance-case.md`](assurance-case.md) for the security-focused
view of this same architecture: what's trusted, what's untrusted input, and
how each boundary is enforced.
