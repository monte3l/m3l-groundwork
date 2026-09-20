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

1. Look for `.groundwork/inventory.json`. **Absent → this is a fresh
   bootstrap; skip straight to Step 1.** Everything below this step applies
   only when it exists.
2. **The deep read.** The CLI's survey is an index, not an interpretation —
   it flagged what it found but could not parse (`needsReading: true` on
   git-hook config, workflow files; anything in `survey.undetermined`) and
   what it could only index, not summarize (`docs`). Read all of it for
   real: the eslint config, the git-hook manager's actual stage commands,
   the CI workflow job steps, `CLAUDE.md`, `CONTRIBUTING.md`, and any
   docs/ADR files the survey indexed. Dispatch this as parallel read-only
   `Explore` agents, one per discovery area (shape/toolchain, harness, docs),
   so you aggregate their findings rather than reading everything yourself.
3. **Write the findings back** into `.groundwork/adoption-report.md`,
   replacing the CLI's index-level sections ("a `lefthook.yml` exists")
   with semantic ones ("pre-push runs lint and typecheck; tests do not
   gate").
4. **Confirm.** Give a short summary in chat, then ask **one**
   `AskUserQuestion` covering: (a) _did this miss anything about your
   project?_ — the free-text option is the point of this question, not a
   formality — (b) the conflict resolutions from the inventory's conflict
   table, batched by facet (toolchain config, harness) rather than one
   question per file — and (c) **which pack(s) to install**, from
   `inventory.packs`. For each pack, show its `budget`, its
   `wiringObservations` (facts about how it would land — e.g. "no
   `bin/lib/verify-steps.packs.json` found: no `bin/verify.mjs`-shaped gate
   runner detected"), and its `adoptNotes` verbatim; a pack whose gate
   dependency the project doesn't have is still offered for its other
   artifacts, with that limitation stated plainly rather than silently
   dropped. This is index-level evidence from the CLI, not a kind-based
   judgment — see Step 3's note on revisiting it once the interview confirms
   the project's kind.
5. **Record the confirmed decisions** to `.groundwork/adoption-decisions.json`
   so a compacted or resumed session doesn't silently lose them and re-ask.

## Step 1 — Interview

**Fresh bootstrap:** ask the following in **two** `AskUserQuestion` calls
(the tool caps a single call at four questions), each with a sensible
default marked "(Recommended)":

Call one (four questions):

1. **Project kind** — library / CLI / frontend or web app / service.
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
have an `exports` map and no `bin` field", not just a silent default. The
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

**Fresh bootstrap** applies directly, no research needed:

- **Project kind ≠ library**: if `check:exports` (publint/attw) doesn't
  apply to the chosen kind (CLI, frontend, service), remove the
  `check:exports` step from `bin/lib/verify-steps.mjs` and the
  corresponding `.github/workflows/ci.yml` line, and drop the `exports`
  field from `package.json` in favor of a `bin` field (CLI) or leave `main`/
  no public export map at all (service).
- **Runtime target = browser or both**: note that `tsconfig.base.json`'s
  `lib` and `moduleResolution` will very likely need to change — but leave
  the actual edit to Round 2's `typescript-guidance` sweep, which has full
  authority over that file and access to current bundler-resolution
  guidance you don't have without a live source.
- **Tests mandatory = warn only**: change the `test` lane in `lefthook.yml`
  and `ci.yml` from a hard failure to a non-blocking report.
- **CI depth = minimal**: drop the `test` lane's coverage gate from CI
  (still run locally); minimal keeps only format/lint/typecheck/build.
  **CI depth = thorough**: note this for Round 2 — `harness-guidance` may
  recommend additional current-best-practice lanes (e.g. a scheduled
  dependency audit) beyond what the baseline ships.
- **Agents not kept**: delete their `.claude/agents/<name>.md` file. Never
  delete `Explore`, `test-author`, or `code-implementer` even if unselected
  — they're load-bearing for the hub-and-spoke loop `CLAUDE.md` documents.
- **Packs**: nothing to do here. A fresh bootstrap's packs were installed
  (or not) by the CLI at `m3l-groundwork <dir> --pack <name>` invocation
  time, before this skill ever ran — there is no fresh-mode install path in
  `/customize` itself. To add a pack after the fact, re-run the CLI against
  this now-non-empty directory (it auto-detects adopt mode) and run
  `/customize` again; its Step 0 will offer the pack through the adopt path
  below.

**Adopt mode** re-expresses each of the same five outcomes against whatever
the project actually has, instead of a named baseline path — "tests must not
hard-fail `pre-push`" is applied to _the gate the inventory found_ (jest in
CI, husky locally, whatever it is), not to `lefthook.yml`/`ci.yml` by name.
Concretely, adopt-mode Round 1 applies exactly three things, all already
confirmed in Step 0.4:

- The **approved additions** — files `templates/core` (at
  `inventory.templateRoot`) would add that the project doesn't have and the
  user approved adding.
- The **approved conflict resolutions** — for each divergent file the user
  decided on, apply that decision (keep theirs / take groundwork's / merge
  the named keys).
- The **approved packs** — installed from `.groundwork/packs/<name>/` (the
  CLI's staged, self-contained copy — never `inventory.templateRoot`, which
  may not exist by the time this runs). Before installing, call
  `recommendPacks(answers)` from `pack-map.ts` (alongside this file, same
  copy mechanism as `kind-facet-map.ts`) with the now-confirmed
  `InterviewAnswers` and compare its verdict against Step 0.4's decision. For
  `harness-extras` this never disagrees (its recommendation doesn't vary by
  kind), but a future kind-scoped pack might — if it does, surface the
  conflict rather than silently overriding the user's Step 0.4 answer,
  mirroring Step 4's "the one exception" rule for guidance findings. To
  install: copy `.groundwork/packs/<name>/files/` into the project (respecting
  any approved per-file conflict decision the same way the baseline's own
  additions are applied), then translate `pack.json`'s `wiring` by hand
  against what Step 0.2's deep read already found — a `.claude/settings.json`
  hook fragment merges the same way the baseline's own hook entries would;
  `wiring.verifySteps` becomes a step in whatever this project's real gate
  runner is (a `package.json` script plus a line in its `lefthook.yml`/
  `.husky/pre-push`/CI workflow, written by hand to match its actual shape)
  — or, if the project has no such gate runner at all, install the pack's
  other artifacts and state plainly in Step 6 that the gate was not wired,
  rather than inventing a runner the project never asked for.

Nothing else is touched. A project file the user didn't approve a change to
stays exactly as it was.

Run `pnpm verify` (fresh) or the project's own equivalent (adopt) after
Round 1's edits to confirm the tailored result still passes before moving to
Round 2.

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

**In adopt mode**, a sweep's domain is the project's real files, classified
by `domain-map.ts`'s `classifyPath` (the same module and glob lists that
guard the emitted baseline — broadened to cover common non-baseline
equivalents like `.eslintrc.*`/`jest.config.*`/`.husky/**`). A config file
that classifies as `uncovered` is a **reportable coverage gap**, exactly the
adopt-mode analogue of the structural test that guards `templates/core` —
name it in Step 6's report rather than silently skipping it.

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

## Step 6 — Report

One-line-per-item summary: the five interview answers, what Round 1 changed
deterministically, what Round 2's two sweeps found and applied (or "skipped
— no network"), and the current state of both trackers (`last-verified=` and
outstanding drift, if any). **In adopt mode**, add: what Step 0 found that
the CLI's report missed (if anything), which conflicts were resolved and
how, any domain-map coverage gap Step 4 surfaced, and **which packs were
installed and what each wired** (or, for a pack whose gate had no runner to
attach to, that it was skipped and why).
