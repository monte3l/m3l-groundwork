---
name: customize
description: >-
  Tailors a project bootstrapped or adopted by m3l-groundwork: for a fresh
  bootstrap, interviews the owner (project kind, runtime target, test
  strictness, CI depth, which reviewer agents to keep) and applies
  deterministic edits; for an adopted pre-existing project, first reconciles
  the CLI's `.groundwork/` survey against the real repository, confirms what
  to add, how to resolve conflicts, and which optional `templates/packs/`
  pack(s) to install. Either way it then runs a live guidance pass over
  official TypeScript and Anthropic sources to validate and refine the
  result against current upstream recommendations. Use for /customize,
  "tailor this project", "adopt this project", "set up this scaffold for my
  project", or right after a fresh or adopted m3l-groundwork bootstrap.
---

# customize

The baseline this project was bootstrapped or adopted with is universal and
frozen at publish time. This skill runs in three rounds, and the ordering is
the whole design:

- **Round 0 — the baseline.** Already in place for a fresh bootstrap; for an
  adopted project, "the baseline" is instead whatever `.groundwork/` recorded
  about the project's own existing files (see Step 0).
- **Round 1 — interview-driven tailoring.** Deterministic, from the answers
  below. Prunes what the project doesn't need and selects what it does.
  Still working from frozen knowledge.
- **Round 2 — guidance-driven refinement.** Two live sweeps over official
  sources that compare, refine, and validate everything Rounds 0 and 1
  produced against what upstream actually recommends **today**. This is the
  most important round, because it is the only one whose knowledge is not
  frozen.

## Authority

Round 2's two sweeps each have authority over their **entire** domain, not a
narrow slice of it — this holds identically for a fresh bootstrap and an
adopted project; only the domain's _contents_ differ (the known baseline vs.
the project's real files):

- `typescript-guidance` (refresh mode) may amend every TypeScript facet —
  `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts` (config
  **and** the testing approach itself), packaging, the TypeScript-toolchain
  entries in `package.json`, and the toolchain steps in
  `.github/workflows/*.yml`.
- `harness-guidance` (refresh mode) may amend the whole `.claude/` surface —
  `settings.json`, hooks, agents, skills, rules, and this `CLAUDE.md`.

The interview below scopes **priority, not authority**: it tells Round 2
which facets deserve the deepest dedicated research, never which facets it
may or may not touch.

## Step 0 — Reconcile (adopt mode only)

**Read [`step-0-reconcile.md`](step-0-reconcile.md) in full before acting on
this step, and again after any compaction or resume** — it holds the whole
procedure, and a compacted session keeps only the start of this file.

In outline:

1. Look for `.groundwork/inventory.json`. No `.groundwork/` at all means a
   fresh bootstrap: skip to Step 1. A `.groundwork/` with no inventory means an
   interrupted CLI run, and an unreadable inventory is invalid: in both cases
   stop and change nothing, and never treat the project as a fresh bootstrap.
2. **The deep read.** The CLI's survey is an index, not an interpretation:
   read the real files it flagged `needsReading`, and reconcile its facts
   against the repository.
3. **Write the findings back** into `.groundwork/adoption-report.md`.
4. **Confirm** the additions, the conflict resolutions and which packs to
   install, in one `AskUserQuestion` round. Nothing is written to a project
   file before this.
5. **Record the confirmed decisions** to `.groundwork/adoption-decisions.json`
   so a compacted or resumed session does not re-ask them. After a compaction,
   read that file first.

## Step 1 — Interview

**Fresh bootstrap:** ask the following in **two** `AskUserQuestion` calls
(the tool caps a single call at four questions), each with a sensible
default marked "(Recommended)":

Call one (four questions):

1. **Project kind** — library / CLI / frontend or web app / service /
   Claude Code plugin.
2. **Runtime target** — Node / browser / both.
3. **Tests mandatory in the pre-push gate?** — yes (default; matches the
   baseline) / warn only.
4. **CI depth** — minimal / standard (default; matches the baseline) /
   thorough.

Call two (one question):

5. **Which baseline agents to keep** — multi-select over `Explore`,
   `test-author`, `code-implementer`, `code-reviewer`,
   `silent-failure-hunter` (all kept by default).

**Adopt mode:** ask the same five questions, but this becomes a
_confirmation_ round rather than a cold ask. Pre-select each answer from
Step 0's findings and **show the evidence alongside it** — "library — you
have an `exports` map and no `bin` field", not just a silent default. When
`survey.harness.pluginLayout` is set, pre-select **Claude Code plugin** and
show the manifest and components as the evidence. With no `package.json`
evidence and no plugin manifest, do not pre-select a kind: ask it cold. The
user confirms or corrects each one. This is why the CLI's survey deliberately
never names a `ProjectKind` itself (see its own `types.ts`): the inference
happens once, here, visibly, with its reasoning attached — not buried in an
offline heuristic no one reviews.

Packs are **not** re-asked here — Step 0.4 already collected that decision
(adopt mode) or the CLI already installed at bootstrap time via `--pack`
(fresh mode, nothing left to ask). Step 3 below is where a confirmed kind can
revise a pack decision made before the interview ran.

## Step 2 — Plan facets (deterministic)

Read `kind-facet-map.ts`, alongside this file in the same skill
directory — a small, pure, unit-tested module (its canonical, tested source
lives in the m3l-groundwork repo at `packages/plugin/src/kind-facet-map.ts`;
this is a verbatim copy the bootstrapper placed here so the skill is
self-contained). Its `planFacets(answers)` function is the kind-to-facet
table: the same five answers always produce the same facet-emphasis plan
for both sweeps. You do not need to run it as code — it's short enough to
apply by inspection.

State the resulting plan in your response before proceeding — this is what
Round 2's two skill invocations will be told to emphasize.

## Step 3 — Round 1: deterministic tailoring

**Read [`step-3-round-1.md`](step-3-round-1.md) in full before applying any
Round 1 edit, and again after any compaction or resume** — it holds every
tailoring rule, and a compacted session keeps only the start of this file.

In outline: a fresh bootstrap applies the interview's answers directly, with
no research. It prunes by project kind, runtime target, test strictness, CI
depth and which reviewer agents to keep; its packs were already installed by
the CLI. An adopted project re-expresses the same five outcomes against its own
files, applies only what Step 0 confirmed, and installs the staged packs the
user chose. Both modes then settle plugin recommendations. Run `pnpm verify`
(fresh) or the project's own equivalent (adopt) after Round 1's edits, before
moving to Round 2.

**Naming rule for `CLAUDE.md`, in Rounds 1 and 2.** Any text you add that
names a `.claude/` file uses its full path (`.claude/rules/tests.md`, never
`tests.md`): the harness grader's `claudemd-refs` check is a literal substring
match on that path, and fails every rule file `CLAUDE.md` does not name.

## Step 4 — Round 2: the guidance pass

Invoke both guidance skills in **refresh mode**, in parallel:

```
Skill(skill: "typescript-guidance", args: "mode: refresh")
Skill(skill: "harness-guidance", args: "mode: refresh")
```

Each sweep reads its own tracker (`docs/research/typescript-refresh.md` /
`docs/research/harness-refresh.md`), fans out its five fixed facets — using
Step 2's plan to decide which facet gets the deepest attention this run,
not which facets it's allowed to touch — and enters plan mode with a
remediation plan if it finds drift.

Also offer `typescript-guidance`'s `gaps` mode here, for gaps rather than
drift — what TypeScript-ecosystem tooling the project is missing entirely, as
opposed to either sweep's "is what's already configured still current." It
is not a third mandatory sweep: run it only if the user wants a tooling-gap
pass alongside the two refreshes.

**In adopt mode**, a sweep's domain is the project's real files, classified
by `domain-map.ts`'s `classifyPath` (the same module and glob lists that
guard the emitted baseline — broadened to cover common non-baseline
equivalents like `.eslintrc.*`/`jest.config.*`/`.husky/**`). A config file
that classifies as `uncovered` is a **reportable coverage gap**, exactly the
adopt-mode analogue of the structural test that guards `templates/core` —
name it in Step 7's report rather than silently skipping it.

**Applying findings.** A Round 2 finding carrying an allowlisted source URL
outranks both the baseline and Round 1, and should be applied. Name in your
final summary every place the findings disagreed with what Round 0/1
shipped — that disagreement list is the feature: it's the evidence the
baseline had gone stale.

**The one exception.** Where a finding would undo an **explicit interview
answer** from Step 1 — the user said tests must not gate `pre-push`,
guidance says they should — surface the conflict and leave the user's
answer standing. Guidance refines the _how_; the interview sets the _what_.
Record the conflict in the relevant tracker either way, so it isn't silently
rediscovered next sweep.

## Step 5 — No network

If neither guidance skill can reach its sources (offline, sandboxed, no
`WebFetch`/`WebSearch` available): **skip Round 2 entirely, say so plainly,
write no tracker update, and leave Rounds 0 and 1 standing.** A tracker
stamped with a `last-verified` date and no real sweep behind it is worse
than an honest `unset` — the next sweep would trust a lie. Report exactly
which round the customization stopped at.

## Step 6 — Final gate

After Round 2 (or after Round 1 if Step 5 skipped it), grade what you
changed. Round 1's check ran before Round 2 edited anything.

- **Fresh:** run `pnpm verify` again.
- **Adopt, the project has `bin/check-harness.mjs`:** run
  `node bin/check-harness.mjs`.
- **Adopt, no such file, schema 5 or later:** only when **all four** of the
  grader's files are in `stagedBaseline.files` (`bin/check-harness.mjs`,
  `bin/lib/harness-rules.mjs`, `bin/lib/frontmatter.mjs`,
  `bin/lib/report.mjs`; a file the project already has is a conflict and is
  not staged) and `git rev-parse --show-toplevel` run in the project equals the
  project root (the grader grades that git root, so a nested package or a
  directory that is not a git repository would grade the wrong tree or fail).
  The files were hash-checked in Step 0. Copy them without the `.staged`
  suffix to `.groundwork/grade/bin/` (keeping `lib/`), run
  `node .groundwork/grade/bin/check-harness.mjs` from the project root, then
  delete `.groundwork/grade/`. Never write the grader into the project's own
  `bin/`.
- **Otherwise:** state in Step 7 that the harness was not graded, and why.

Fix any structural failure this run introduced. Report one that was already
there without fixing it unasked.

## Step 7 — Report

One-line-per-item summary: the five interview answers, what Round 1 changed
deterministically, what Round 2's two sweeps found and applied (or "skipped
— no network"), and the current state of both trackers (`last-verified=` and
outstanding drift, if any). **In adopt mode**, add: what Step 0 found that
the CLI's report missed (if anything), which conflicts were resolved and
how, any domain-map coverage gap Step 4 surfaced, and **which packs were
installed and what each wired** (or, for a pack whose gate had no runner to
attach to, that it was skipped and why).

Also list **which plugins were enabled** (each newly-`true`
`enabledPlugins` entry, with the exact `claude plugin install <id> --scope
project` follow-up command it still needs) and which were offered but
declined, plus any prerequisite named against an enabled plugin
(e.g. `typescript-language-server` on `PATH`, or the Python version a
plugin's `prerequisites` names) as a follow-up the
user still has to satisfy.
