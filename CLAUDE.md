# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this is

**m3l-groundwork** — a two-phase TypeScript + Claude Code project
bootstrapper. **Phase A** (`packages/cli`) is deterministic: an offline Node
CLI with two modes, auto-detected from the target directory (`mode.ts`).
**Fresh mode** writes a baseline Claude Code harness and TypeScript
toolchain into an empty directory, correct for any TypeScript project.
**Adopt mode** points at an already-established project instead: it surveys
it read-only (`src/survey/`), diffs the baseline against what's actually
there (`conflicts.ts`), and writes only a report (`.groundwork/`) -- it never
touches a project file. **Phase B** (`packages/plugin`) is adaptive: a
`/customize` skill that, for a fresh bootstrap, interviews the user and
tailors the baseline; for an adopted project, first reconciles the CLI's
survey against the real repo and confirms what to change (its own Step 0).
Either way it then runs a live guidance pass over official TypeScript and
Anthropic sources so the result reflects current upstream recommendations
rather than what was true when this repo last shipped.

`templates/packs/` adds optional bundles on top of the baseline -- artifacts
cut from `templates/core` purely to hold its hard caps, not because they
failed the generalization test. The CLI installs a pack directly in fresh
mode (`--pack <name>`); in adopt mode it only surveys which packs apply and
stages their payload at `.groundwork/packs/`, and `/customize`'s Step 0
installs from there after confirmation -- the same fresh/adopt split as
everything else Phase A does. See `templates/packs/README.md` for the
wiring contract (a pack never edits YAML or JavaScript).

Do not confuse this repo's own toolchain with **the baseline it emits**
(`templates/core/`) — the two share the same design (same tsconfig strict
flags, same eslint rule set, same lefthook shape) but are separate,
independently-verified artifacts. A change to `eslint.config.js` at this
repo's root affects only how _this repo_ lints itself; a change to
`templates/core/eslint.config.js` affects every project bootstrapped from
here after the change.

## Tech Stack

TypeScript, `strict: true`, ESM only, `tsc` (no bundler), `pnpm`. Node 24+
(`.node-version` is the authority; `check:node-version` gates drift). Two
workspace packages (`packages/cli`, `packages/plugin`), each with a
tooling `tsconfig.json` (src + tests, no emit) and a build-only
`tsconfig.build.json` (src only, emits `dist/`).

## Repository Layout

```
packages/cli/          Phase A: the offline bootstrapper CLI
  src/                   main.ts, mode.ts, tokens.ts, emit.ts, git.ts, plugin.ts,
                          conflicts.ts, inventory.ts, report.ts, jsonc.ts,
                          caps.ts, packs.ts, merge-json.ts, assets.ts (the one
                          place that locates templates/ and the plugin payload)
  src/harness/            the harness grader: frontmatter.ts, rules.ts, grade.ts,
                          conformance.ts, types.ts
  src/toolchain/          the toolchain grader: rules.ts, grade.ts, conformance.ts,
                          types.ts, tsconfig-chain.ts (the extends resolver the
                          survey shares)
  src/survey/             survey.ts + one collector per discovery area
                          (survey-shape, survey-toolchain, survey-harness,
                          survey-docs), fs-walk.ts, types.ts
  bin/                    m3l-groundwork.mjs -- the published entry point
  scripts/                vendor-assets.mjs -- prepack/postpack: copies templates/
                          and the plugin payload into the package for a pack
  tests/                  unit tests + bootstrap.e2e.test.ts + adopt.e2e.test.ts
                          + packs.e2e.test.ts + pack.e2e.test.ts (the published
                          tarball, run from outside the repo)

packages/plugin/        Phase B: the /customize skill
  skills/customize/       SKILL.md (Step 0 is the adopt-mode reconcile step)
  src/                    kind-facet-map.ts, domain-map.ts, pack-map.ts, index.ts
  tests/                  unit tests for all three

.claude/                THIS repo's own harness (not the baseline's): agents/,
                         hooks/, rules/, skills/, settings.json -- installed by
                         self-adopting `templates/core`'s harness plus the
                         `statusline` pack. See "Agent Operating Model".
                         worktrees/ is unrelated -- see "Known gaps".

.changeset/             Changesets config, prerelease state (pre.json), and any
                         pending changesets. See "Releases".

.claude-plugin/         marketplace.json: lists the plugin as a relative-path
                         source into packages/plugin -- never npm -- for
                         `/plugin marketplace add`.

.github/                THIS repo's own CI (not the baseline's): ci.yml (five
                         verify lanes + e2e + node-current + the `verify`
                         aggregator), release.yml (see "Releases"),
                         dependency-review.yml, scorecard.yml, gitleaks.yml,
                         claude.yml, claude-pr-review.yml, dependabot.yml,
                         ISSUE_TEMPLATE/, pull_request_template.md

design/                 m3l-design, vendored -- see design/README.md and
                         "Design system" below. source/ is a verbatim copy;
                         tokens.css is generated from it by
                         bin/build-design-tokens.mjs.

docs/architecture.md    A human-facing distillation of this file's own
                         architecture notes -- for anyone reading the project
                         rather than editing it.
docs/assurance-case.md  The OpenSSF Best Practices Silver `assurance_case`:
                         threat model, trust boundaries, a Saltzer & Schroeder
                         argument, and a CWE Top 25 mitigation table.
docs/research/          THIS repo's own trackers (not the baseline's):
                         typescript-refresh.md / harness-refresh.md, read and
                         written by /customize's Round 2 guidance sweeps when
                         run against this repo itself.
GOVERNANCE.md            Decision model, roles, and access continuity --
                         OpenSSF Best Practices Silver's governance criteria.
ROADMAP.md               What's planned and what's explicitly out of scope --
                         OpenSSF Best Practices Silver's documentation_roadmap.

templates/core/         THE BASELINE -- exactly what the CLI emits. Its own
                         toolchain, .claude/ harness, CI workflows, and
                         placeholder src/tests. See its own CLAUDE.md.

templates/packs/        Optional add-on bundles installed on top of the
                         baseline. `harness-extras/` and `statusline/` ship today; see its
                         own README.md for the wiring contract and "Known
                         gaps" below for the deferred candidates.
```

## Commands

Run any task with `pnpm <script>`.

| Script                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                          | `tsc -b` both packages' `tsconfig.build.json`, emits `dist/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm typecheck`                      | `tsc -b --force` over both packages' tooling projects (src + tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm lint` / `lint:fix`              | ESLint over the whole repo (excludes `templates/**`), `--max-warnings 0` -- a warning fails the gate the same as an error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm format` / `format:check`        | Prettier write / check (covers `templates/**` too -- it's still committed text)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` / `test:coverage`         | Vitest unit tests, with or without the coverage gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test:e2e`                       | The real acceptance test, both modes: `bootstrap.e2e.test.ts` bootstraps a throwaway project into a temp dir with the built CLI and runs _that project's own_ `pnpm verify` (slow, ~15-20s, network-touching -- a real `pnpm install`); `adopt.e2e.test.ts` runs adopt mode against a fixture pre-existing project and asserts nothing outside `.groundwork/` and `.claude/skills/customize/` changed; `packs.e2e.test.ts` bootstraps with `--pack harness-extras` and asserts the emitted project's own `pnpm verify` (including the pack's gate) is green; `packs-statusline.e2e.test.ts` does the same for `--pack statusline` and also executes the emitted scripts against a real payload. `pack.e2e.test.ts` packs the CLI as a release would, unpacks the tarball outside the repo, and asserts it emits byte-identical output to the checkout (see "Releases"). None are part of `pnpm test`. |
| `pnpm knip`                           | Unused-dependency / unused-export hygiene, both packages; a `verify` step in the `lint` group                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm check:exports`                  | publint + attw against `packages/cli`'s packed tarball -- the one published package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm check:plugin-version`           | `plugin.json`'s version matches the CLI's, `packages/plugin/package.json` stays private, and `marketplace.json`'s entry names it correctly and carries no npm source or version pin of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm check:plugin-manifest`          | Runs Anthropic's `claude plugin validate --strict` against the marketplace manifest and `packages/plugin`; skips cleanly with a warning when the `claude` CLI isn't installed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm changeset` / `version:packages` | Add a changeset; version the packages (what the release workflow runs -- see "Releases")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm check:node-version`             | `.node-version` is authoritative; forbids a hardcoded pin in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm check:harness`                  | Grades `templates/core`'s Claude Code harness (`.claude/` + `CLAUDE.md`) with the emitted gate's own rule module: structural defects fail, rubric findings warn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm check:toolchain`                | Grades `templates/core`'s TypeScript toolchain (tsconfig chain, ESLint and vitest config, verify-step wiring, toolchain pins) with the emitted gate's own rule module: structural defects fail, rubric findings warn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm eval`                           | **Paid, never in `verify`.** Runs Anthropic's `claude plugin eval` on `/customize`, on a generated wrapper over `templates/core`'s skills (triggering accuracy), and on `typescript-guidance` against a deliberately degraded project (the `toolchain` suite); needs `claude`, credentials, network. Skips cleanly without `claude`. See "Behavioural evals" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm verify`                         | Every gate above (via `bin/lib/verify-steps.mjs`). `node bin/verify.mjs --group <name>` runs one of the five groups -- exactly what `lefthook`'s `pre-push` and each `ci.yml` lane invoke; `--step <id>` is for local debugging only and must never appear in either YAML file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm prepare`                        | Installs the lefthook git hooks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Run `pnpm verify` (or just push -- `lefthook`'s `pre-push` runs the same
steps) before considering any task here done.

## Architecture notes

- **Token substitution is a plain string replace, not a template engine**
  (`packages/cli/src/tokens.ts`). `applyTokens` swaps `__KEY__` literals in
  both file content and path segments.
- **Where `templates/` and the plugin payload live is decided in exactly one
  place: `resolveAsset()` in `packages/cli/src/assets.ts`.** Never write a
  `join(here, "..", "..", "..")` walk again -- in a published tarball that
  escapes the package. `templatesCoreDir()`, `packsRootDir()` and
  `pluginDir()` are one-liners over it. It probes the **source checkout first**
  (a positive marker: `pnpm-workspace.yaml` plus a `package.json` named
  `m3l-groundwork` three directories up) and only then the copy vendored
  beside `dist/`; the order is what stops a vendored copy left by a crashed
  `pnpm pack` from being read stale on a dev machine, and the marker is what
  stops an unscoped install from treating the consumer's own project root as
  ours. `scripts/vendor-assets.mjs` (`prepack`/`postpack`) does the copying.
- **npm-family tooling strips `.gitignore`, `.npmrc` and `.npmignore` from a
  tarball whatever `files` says** (measured: `pnpm pack` keeps `.gitignore` but
  drops `.npmrc`; `npm pack` drops all three). The vendored copy therefore
  stores them as `_gitignore`, `_npmrc`, `_npmignore`, and every walker over
  the template tree restores the real name via `restoreDotfilePath`
  (`emit.ts`, `conflicts.ts`). **A new walker over `templates/` must do the
  same**, or a published install silently loses those files. The name list and
  both directions of the mapping live in `assets.ts`; `vendor-assets.mjs`
  imports them from the build, so `pnpm build` must precede `pnpm pack`.
  `templates/core/package.json` is _not_ escaped -- `caps.ts` reads it
  directly -- so publint prints a known, harmless warning that its `exports`
  field is ignored.
- **The CLI has zero runtime dependencies it can avoid**, and makes no
  network call beyond the package install it runs at the end of fresh mode
  (`packages/cli/src/git.ts`'s `runInstall`; adopt mode makes none at all).
  If a change to `packages/cli` needs a new dependency, stop and
  reconsider -- this is a hard constraint, not a style preference. It's why
  `src/survey/` parses JSONC by hand (`jsonc.ts`) and never parses YAML at
  all -- `lefthook.yml`/workflow files are indexed and excerpted, flagged
  `needsReading: true`, and left for `/customize`'s Step 0 to actually read.
- **Adopt mode's contract is "the survey is an index, not an
  interpretation."** Every `survey-*.ts` collector records facts it can
  establish offline -- which files exist, their verbatim content, which
  keys are set -- and never infers a verdict (there is no `ProjectKind`
  anywhere in `packages/cli`; that inference happens once, visibly, in
  `/customize`'s Step 1, with its evidence shown). Anything a collector
  can't parse goes into `ProjectSurvey.undetermined` rather than being
  silently dropped -- a survey that looks complete but isn't is worse than
  one that admits a gap. Adopt mode writes exactly two files
  (`.groundwork/inventory.json`, `.groundwork/adoption-report.md`) plus one
  guarded, purely-additive copy of the `/customize` skill
  (`installCustomizeSkillGuarded` in `plugin.ts`) -- never a project file.
  `adopt.e2e.test.ts` is the test of that guarantee; don't weaken it.
- **`/customize`'s two guidance skills (`typescript-guidance`,
  `harness-guidance`, both in `templates/core/.claude/skills/`) each have
  full authority over their entire domain**, not just the facets an
  interview answer happens to emphasize -- see both skills' own "Authority"
  section and `packages/plugin/skills/customize/SKILL.md`'s "Round 2". The
  interview scopes research _priority_, never _what a sweep is allowed to
  touch_. Don't narrow a sweep's scope to "just the facet the user asked
  about" when adjusting either skill.
- **`packages/plugin/src/domain-map.ts` is a structural guarantee, not
  documentation.** `packages/plugin/tests/domain-map.test.ts` walks the
  _real_ `templates/core` tree on every test run and asserts every file is
  claimed by exactly one of `typescript-guidance`'s domain,
  `harness-guidance`'s domain, or an explicit neutral allowlist. Adding a
  new file under `templates/core/` that doesn't match any of the three glob
  lists in `domain-map.ts` fails this test -- that's the point: it's how a
  new template file gets caught before it becomes a silent blind spot for
  both guidance sweeps. Update the glob lists in the same commit that adds
  the file, not as a follow-up.
- **The harness grader has two implementations that must not drift.**
  `packages/cli/src/harness/` (TypeScript: `frontmatter.ts`, `rules.ts`,
  `grade.ts`) feeds adopt mode's `## Harness grade` report section and the
  inventory's `harnessGrade`; `templates/core/bin/lib/{frontmatter,harness-rules}.mjs`
  plus `bin/check-harness.mjs` is the emitted ESM twin every bootstrapped
  project runs as a `pnpm verify` step. `tests/harness/harness-parity.test.ts`
  runs both over the real baseline and a deliberately broken harness and
  asserts identical grades -- change a rule in one, change the other in the
  same commit or that test fails. The gate is a `CORE_STEPS` entry
  (`cmd: ["node", "bin/check-harness.mjs"]`) with **no** `package.json`
  script, which is how it costs zero cap budget in a baseline already at
  every cap. Structural rules fail; rubric rules only warn, and
  `CURRENT_MODELS` in `rules.ts` needs bumping when the model lineup moves.
  The root `bin/check-harness.mjs` imports the emitted rule module directly
  rather than a copy, so this repo grades `templates/core` with exactly what
  ships.
- **The toolchain grader has the same two-implementations shape, for the same
  reason, and the same rule.** `packages/cli/src/toolchain/{rules,grade}.ts`
  feeds adopt mode's `## Toolchain grade` report section and the inventory's
  `toolchainGrade` (`schemaVersion` 4);
  `templates/core/bin/lib/toolchain-rules.mjs` plus `bin/check-toolchain.mjs` is
  the emitted twin every bootstrapped project runs as a `pnpm verify` step, and
  the root `bin/check-toolchain.mjs` imports that emitted module rather than a
  third copy. `tests/toolchain/toolchain-parity.test.ts` runs both over the real
  baseline, an empty directory and broken projects, and asserts identical grades
  -- change a rule in one, change the other in the same commit. Like the harness
  gate it is a `CORE_STEPS` entry with **no** `package.json` script, so it costs
  zero cap budget. It grades a **rubric**, not a diff against `templates/core`:
  the baseline is expected to score zero structural findings and 100% rubric
  (asserted by a test), and a project's deviation is reported against the rule.
  Three properties are load-bearing. **Absence is never a defect**: a rule whose
  subject does not exist (no `vitest.config.ts`, no verify steps) returns
  `{ checked: 0 }`, because adopt mode runs it against arbitrary projects.
  **It never executes project code**: `eslint.config.js`, `vitest.config.ts` and
  `verify-steps.mjs` are read by regex over comment-stripped source, and a scrape
  that cannot tell the answer returns `{ checked: 0 }` rather than a failure. And
  **it does not restate what `tsc` or ESLint already reject** -- a structural rule
  that only fires once `tsc` has failed adds nothing, which is why removed
  options are a rubric warning about the _next_ major
  (`tsconfig-option-lifecycle`), not a gate. For the same reason it keeps no
  table of "current" package majors: whether a pin has fallen behind upstream is
  `typescript-guidance`'s question, answered by a live sweep, and a closed-loop
  gate restating it would go stale silently. The
  tsconfig `extends` resolver (`toolchain/tsconfig-chain.ts`) is shared with
  `survey-toolchain.ts`, so the survey's `effectiveFlags` and the grade cannot
  disagree.
- **Behavioural evals (`pnpm eval`, `bin/eval.mjs`) are a separate, paid layer
  from `check:harness`** and are deliberately not in `pnpm verify` or
  `pre-push`: they make real model calls. Three suites, all driven by
  `claude plugin eval`. The third, `toolchain`, runs `typescript-guidance` against
  a bootstrapped project degraded only in ways `tsc` and ESLint cannot see
  (`evals/core-toolchain/toolchain-repair/`): the fixture captures the gate's
  output to `toolchain-gate.txt`, so the case needs no shell tool in the sandbox,
  and graders check the skill names the findings, edits nothing, and holds the
  floor rather than silencing the gate. The eval sandbox has **no web tools**, so
  the case cannot measure upstream research; it measures use of the gate's
  findings and honesty about that limit (a claim about upstream it could not have
  fetched fails). The judge reads only the final message, hence the prompt's
  request for one self-contained summary. Its `fixture.sh` is a template -- it uses
  `__M3L_CLI__`, substituted by `writeToolchainPlugin` when the case is copied.
  `packages/plugin/evals/` grades `/customize` itself
  (`fresh-interview`, `adopt-reconcile`); each case's `fixture.sh` runs this
  repo's own **built** CLI to make a genuine fresh/adopted project, so
  `pnpm eval` runs `pnpm build` first. `evals/core-harness/triggers.json` is a
  `{skill, query, should_trigger}` corpus that `bin/lib/eval-lib.mjs` turns
  into a throwaway plugin wrapping `templates/core`'s skills plus one case per
  entry; `eval-lib.test.ts` fails if a baseline skill ships without a positive
  and a negative entry. The interview is graded by an `llm` rubric rather than
  a `tool_used: AskUserQuestion` grader because that tool is not available in
  the eval sandbox (Claude falls back to plain-text questions). Under
  `--ablation with-without` a `tool_used: Skill` grader stops counting toward
  the score, so the suites default to `--ablation none`. `--check` ratchets
  against `evals/baseline.json` and `--update` rewrites it -- record it at
  `--runs 3` or more, because a one-run baseline flakes.
- **`templates/core`'s caps bind the baseline only, verified by counting
  (`packages/cli/src/caps.ts`'s `countBaselineCaps`/`CAP_LIMITS`), not
  every installed pack on top of it:** ≤5 agents, ≤8 skills (7 in
  `templates/core/.claude/skills/` - `/customize` via the installed plugin
  = 8), ≤10 hooks, ≤3 CI workflows, ≤12 root `package.json` scripts, 0
  gates that exist only to check documentation about the repo itself.
  Adding a new agent/skill/hook/workflow/script to `templates/core` means
  removing or merging an existing one first -- `caps.ts` is the one place
  the cap numbers and the counting logic live, so `report.ts` (the
  adoption-report table) and `main.ts` (the fresh-mode post-`--pack`
  summary) can't state a different number for the same cap. A pack
  declares its own `budget` delta in `pack.json`, checked by a structural
  test against its own `files/` tree's actual contents -- see
  `templates/packs/README.md`.
- **`bin/lib/verify-steps.mjs` is the single source of truth `pnpm verify`,
  every `lefthook.yml` `pre-push` lane, and every CI job reads from --
  keyed by _group_ (`format`/`lint`/`typecheck`/`build`/`test`), not by
  individual step id.** Both YAML files name a group, never a step, which
  is what lets a pack register a gate (appended to
  `bin/lib/verify-steps.packs.json`, a plain JSON array) without either
  YAML file changing. The same pattern applies in the emitted baseline
  (`templates/core/bin/lib/verify-steps.mjs`, which adds `CORE_STEPS` and the
  pack-contributed steps this repo's own list has no use for). Add a new
  gate to `VERIFY_STEPS` here (or `CORE_STEPS` in the baseline), not as a
  bespoke script invocation in either YAML file.
- **Continuous integration (`.github/`).** `ci.yml` has five lane jobs
  (`format`/`lint`/`typecheck`/`build`/`test`), each `node bin/verify.mjs
--group <name>`, plus an `e2e` job (`pnpm build` then `pnpm test:e2e`), a
  `node-current` job (a full `pnpm verify` + `pnpm test:e2e` on whatever
  Node.js currently calls its Current release line, so a drift against the
  pinned `.node-version` surfaces before that line becomes the next LTS --
  a separate job, never a matrix, for the same `gate-lane-parity` reason as
  below), and a `verify` aggregator -- the check the `main` ruleset gates on
  (see "Git Workflow"). The aggregator demands an explicit `success` from
  every lane, since testing only for `failure` reports green over a
  cancelled or skipped one. Two rules keep `gate-lane-parity` (the
  toolchain grader) working against this repo: **never name a step id in a
  workflow** (name a group), and **never matrix the lanes** --
  `--group ${{ matrix.group }}` reads as dynamic, and because the grader
  concatenates every workflow file into one surface, that one line
  switches the check off for all of them. `pnpm eval` never runs in CI
  (paid model calls). **CodeQL is GitHub-managed default setup and has no
  file in this repo -- do not add a `codeql.yml`**, it collides with
  default setup. `bin/check-node-version.mjs` is live here now: every
  lane that runs the pinned toolchain takes Node from
  `node-version-file: .node-version`; `node-current` is the one
  deliberate, documented exception, and the gate's own regex (which only
  rejects a hardcoded _digit_) already allows it. `release.yml` follows
  the same two rules and adds a third: **it never writes the text
  `verify.mjs`**. The grader reads a workflow as text, so a bare or
  dynamic invocation there switches `gate-lane-parity` off for `ci.yml` too
  -- measured, not assumed: the structural check count drops 42 to 37 and
  no finding is raised. Its `pack` job runs `pnpm verify` instead, which
  the scraper cannot see and which is a full run of every group anyway.
  Every action in every workflow (including `scorecard.yml` below) is
  pinned by commit SHA with a `# vX.Y.Z` comment naming the tag pinned to
  -- Dependabot (`.github/dependabot.yml`) opens a PR to move the pin
  forward, the same as it would for a floating tag, so this costs nothing
  in maintenance and closes the "a compromised upstream tag" class of
  supply-chain risk a floating `@v7` doesn't. `scorecard.yml` runs
  `ossf/scorecard-action` weekly (plus on push to `main` and
  `workflow_dispatch`) and publishes results for the README badge; it is
  read-only and not a required check. The README's Socket badge
  (`badge.socket.dev`) is a deliberate complement, not a duplicate: it
  scores the _published package's_ behavior (install scripts,
  obfuscation, requested permissions), where Scorecard scores the
  _repo's_ practices. Bundlephobia and Snyk were considered and
  rejected: Bundlephobia measures browser-bundle size, which doesn't
  apply to a bin-only CLI with no importable entry point (see
  `packages/cli/package.json`'s `exports`), and Snyk overlaps with both
  Socket and `dependency-review.yml`/Dependabot for a package that has
  zero runtime dependencies to begin with -- one vulnerability-scanning
  badge is enough. `gitleaks.yml` runs `gitleaks/gitleaks-action` (secret
  scanning) on the same push/PR/weekly/dispatch shape as `scorecard.yml`,
  and is not a required check today (see "Known gaps" -- adding it to
  `main`'s ruleset needs at least one successful run on `main` first). Its
  `GITLEAKS_VERSION` is pinned above the action's own stale built-in
  default and Dependabot doesn't track it, so bump it by hand
  periodically; `GITLEAKS_LICENSE` (a free org license, required because
  this repo is org-owned) is an org-level secret set up outside this repo.
- **`claude.yml` and `claude-pr-review.yml` run Anthropic's official
  `anthropics/claude-code-action`** (SHA-pinned, same convention as every
  other action here), both running but failing cleanly on an auth error
  until the one-time setup below is done. `claude.yml` is interactive
  `@claude`-mention mode: it never opens a PR itself (it commits to a branch
  and links back to a PR-creation page), so it never bypasses the
  human-opened-PR rule above. `claude-pr-review.yml` reviews every
  opened/updated PR with `contents: read` only -- Claude posts a comment, it
  cannot push code, submit a formal GitHub review, or approve a PR, so it
  cannot satisfy or bypass `main`'s required checks or its 0-approval rule
  either way. `claude-pr-review.yml` pins
  `claude_args: --model claude-opus-5-5 --fallback-model claude-sonnet-5`
  (there is no `model:`/`fallback_model:` input -- both are deprecated
  action inputs, per claude-code-action's own docs/usage.md, in favor of
  configuring both through `claude_args`); `claude.yml` is left on the
  action's default. Two reasons for pinning at all, not one: no official
  source states whether the action's undocumented default can change
  silently between action releases, which matters for an unattended,
  repeated job the way it doesn't for `claude.yml`'s interactive, humanly-
  invoked sessions; and Opus 5.5 is Anthropic's own explicit recommendation
  for agentic code review specifically (a third-party eval measured a 72%
  known-bug catch rate against the prior Opus generation's 56%, with fewer
  false alarms). The fallback only triggers on an overload/unavailable/
  non-retryable-server-error response, never on an auth, billing,
  rate-limit, or policy failure -- a real, currently-unfixed gap
  (anthropics/claude-code-action#594, redirected to and auto-closed
  `not_planned` as anthropics/claude-code#8413) -- but it's worth having
  for the failure mode it does cover, and Sonnet 5 is a separate model pool
  from Opus so it isn't overloaded by the same demand spike.
  `claude-pr-review.yml`'s own `if:` excludes bot-authored PRs
  (the changesets version-PR, Dependabot) and fork PRs explicitly, rather
  than relying on the action's own internal bot/permission checks, so a run
  that would just fail on missing secrets never starts -- the fork-PR half
  of that check is now also backstopped by "Git Workflow"'s
  collaborators-only pull request policy, but the explicit `if:` stays as
  defense in depth. `claude.yml` has no PR to gate (it only triggers on
  issues and comments, which stay open to everyone even under
  collaborators-only PRs), so its `if:` instead requires the triggering
  actor's `author_association` to be `OWNER`, `MEMBER` or `COLLABORATOR`.
  **One-time setup,
  done by hand:** install the [Claude GitHub App](https://github.com/apps/claude),
  then `claude setup-token` locally and
  `gh secret set CLAUDE_CODE_OAUTH_TOKEN` -- this repo uses a Claude
  subscription's OAuth token, not a stored API key or Workload Identity
  Federation. `templates/packs/claude-action` ships the mention-mode
  workflow as an optional pack for bootstrapped projects, defaulting to a
  stored API key instead (the more universal choice for a project of
  unknown ownership) with the other two auth options documented as
  comments in the file.
- **A pack never edits YAML or JavaScript.** It extends three JSON files
  the baseline already reads at runtime (`.claude/settings.json`,
  `package.json`'s `scripts`, `bin/lib/verify-steps.packs.json`) via the pure
  merge functions in `packages/cli/src/merge-json.ts`. `.claude/settings.json`
  has two disjoint merges: `mergeSettingsHooks` owns the `hooks` block
  (entry-by-entry), and `mergeSettingsTopLevel` plants whole top-level keys
  such as `statusLine` (identical is a no-op, different is a hard collision --
  an adopted project's own `statusLine` is never overwritten). This is what keeps
  pack installation inside `packages/cli`'s zero-runtime-dependency,
  no-YAML-parsing constraints in both fresh mode (the CLI installs
  directly) and adopt mode (the CLI only surveys; `/customize` installs
  from the staged `.groundwork/packs/<name>/` copy after reading the
  project's real gate runner) -- see `templates/packs/README.md`.
- **Design system: `design/` is this repo's own vendored copy of
  m3l-design, this repo only -- `templates/**` stays brand-neutral.**
  `design/source/` is a verbatim copy of the m3l-design Claude Design
  artifact (DTCG 2025.10 tokens, component CSS, brand book, fonts) --
  see `design/README.md` for provenance and the re-sync rule (never
  hand-edit `source/`). `design/tokens.css` is generated from it by
  `bin/build-design-tokens.mjs`, whose resolver (`bin/lib/design-tokens.mjs`)
  is a small, zero-dependency DTCG resolver: it follows
  `m3l.resolver.json`'s own `resolutionOrder` (primitives -> semantic ->
  theme -> motion -> components) -- checked, not just assumed:
  `loadDesignSystem` asserts the manifest still declares that exact set/
  modifier/context shape and order before any theme resolves, so a re-sync
  that reorders or renames one of them fails loudly instead of silently
  merging in the wrong precedence -- resolves `{alias}` references with
  cycle/missing-alias errors, and flattens the resolved tree into the same
  dashed-name convention m3l-design's own flattened `tokens.json` uses
  (`color-surface-default`, `button-primary-bg`, ...) -- that vendored
  `tokens.json` is kept only as a parity oracle
  (`packages/cli/tests/design-tokens.test.ts`), never read by the build
  itself; the DTCG files are canonical, per `design/README.md`. Every
  formatter (`formatColor`, `formatDimension`, `formatEasing`,
  `formatShadow`) validates its input's shape and throws `DesignTokenError`
  rather than interpolating `undefined` into the generated CSS -- see
  `deriveTypeTreatment`, the typography distillation, for the same
  fail-loud rule applied to letter-spacing/word-spacing/shared-flag
  agreement across styles. `node bin/build-design-tokens.mjs --check` is
  the `design-tokens` step in `bin/lib/verify-steps.mjs`'s `lint` group (a
  `CORE_STEPS`-shaped entry with no `package.json` script, same pattern as
  the harness/toolchain gates) -- it fails on drift rather than writing, so
  a change to `design/source/dtcg/` must be followed by re-running the
  plain (no-flag) command and committing `design/tokens.css` in the same
  change. It is run through this repo's own Prettier config before being
  written, so `pnpm format:check` and this step never disagree about its
  formatting. The same generator also emits `packages/cli/src/palette.ts` --
  the six terminal status/text colors, light and dark, `packages/cli/src/term.ts`
  paints console output with (`paint()`, `supportsColor()`): color only when
  the stream is a TTY, never when `NO_COLOR` is set, always when `FORCE_COLOR`
  is; truecolor SGR when `COLORTERM` is `truecolor`/`24bit`, else the nearest
  of the 16 standard ANSI colors by RGB distance; theme follows `COLORFGBG`
  when present, defaults to dark otherwise. Piped/non-TTY output is
  byte-identical to plain text -- every string-matched test keeps passing
  without needing to know about color at all. `bin/lib/term.mjs` is the
  root-tooling twin (`bin/verify.mjs`, `bin/lib/report.mjs`,
  `bin/lint-commit.mjs`, `bin/eval.mjs`, `.claude/hooks/statusline-layout.mjs`):
  it resolves its own palette straight from `design/source/dtcg/` rather than
  importing a generated file, since root tooling has no build step to emit
  one into -- not compared against `term.ts` by a parity test, unlike the
  harness/toolchain grader twins, since a drift here is cosmetic (two
  terminals' output), not a behavioral contract.

## Git Workflow

Single-maintainer project on GitHub (`monte3l/m3l-groundwork`, public).
**Pull request creation is collaborators-only**
(`pull_request_creation_policy: collaborators_only`, a repo setting, not a
ruleset rule -- read it with `gh api repos/monte3l/m3l-groundwork --jq
.pull_request_creation_policy`), added 2026-09-26 after a fork account
opened several PRs that had the shape of automated "good first issue"
farming (a thin, low-signal profile bulk-forking many unrelated repos in a
tight window). Issues stay open to everyone; a contribution starts as an
issue, and a collaborator opens the PR (see CONTRIBUTING.md's "Small tasks
for newcomers"). This also simplifies the fork-PR secrets question:
`gitleaks.yml`'s license secret and `claude-pr-review.yml`'s OAuth token no
longer need to handle a fork-originated PR run at all, since one can't
exist.
Conventional Commits, enforced by the `commit-msg` hook
(`bin/lint-commit.mjs`) -- same convention `templates/core` emits into every
bootstrapped project. Add a `Co-Authored-By:` trailer when Claude authored or
substantially assisted a commit. The release workflow's version PR and commit
use `chore(release): version packages` so they satisfy the same convention.
Every commit also needs a DCO `Signed-off-by:` trailer (`git commit -s`),
enforced by the same hook via `commitlint.config.js`'s `trailer-exists` rule
-- see [`CONTRIBUTING.md`](CONTRIBUTING.md#developer-certificate-of-origin).
This is local-only enforcement: a squash merge and the release bot's own
commit don't pass through the hook, which is why the PR template also
carries a sign-off checkbox.

CI runs on every push and PR to `main` (see "Continuous integration" above),
and a repository ruleset named `main` enforces the rest. It targets
`~DEFAULT_BRANCH` with an empty `bypass_actors` list -- nobody, the org owner
included, can push to `main` directly, force-push it, or delete it while the
ruleset is active. Every change lands through a pull request whose `verify`
(the aggregator), `Dependency Review` and `CodeQL` checks are green, whose
review threads are resolved, and whose commits are all signed. Each required
check is pinned to its producing app (`integration_id`), so a same-named
status from anywhere else can't satisfy it.

Three choices are deliberate, not defaults. **Approvals are 0**: one
maintainer cannot approve their own PR, so requiring one would only force a
standing bypass. **Rebase-merge is not an allowed method**: GitHub rewrites
those commits and has no key to sign them, so under required signatures the
button would always error; merge and squash remain. **Branches need not be
up to date before merging** (`strict` is off): with weekly Dependabot PRs,
no auto-merge and no merge queue, strict mode would re-run every lane, e2e
included, once per remaining PR after every merge.

Signing is machine-local: `commit.gpgsign` is in `~/.gitconfig` but
`user.signingkey` is tracked nowhere in this repo, so on a fresh box
`git commit` fails outright (`gpg failed to sign the data`) until the key is
configured. Fix the key -- never `commit.gpgsign=false`, which produces
commits the ruleset rejects only at merge time. Nothing in this repo's own
hooks blocks a local commit to `main` the way `guard-branch-isolation.mjs`
does for `templates/core`'s _emitted_ projects (that guard ships in the
baseline; it doesn't apply to building the bootstrapper itself); the ruleset
is the remote-side catch and only bites at push time, so branch first.

The ruleset is configured with `gh api`, not committed as JSON: GitHub never
reads a checked-in export, so it would drift silently, and a gate to keep it
in sync would be exactly the "checks documentation about the repo itself"
kind that `templates/core`'s caps pin at zero. Read the live state with
`gh api repos/monte3l/m3l-groundwork/rules/branches/main`. Maintenance that
needs a force-push means `PUT`ting the ruleset to `enforcement=disabled` and
back (a logged toggle), not adding a bypass actor.

## Agent Operating Model

This repo runs on `templates/core`'s own harness -- installed onto its own
root by adopting itself (see "Known gaps" for how), same shape as every
project it bootstraps, with one adaptation: `packages/*/src/**` and
`packages/*/tests/**` in every path-shape rule below, not a flat `src/`/`tests/`,
matching this repo's real two-package layout.

**Hub-and-spoke is mandatory and hook-enforced, deliberately, with no
project-level opt-out.** The hub plans and dispatches to spokes, and never
writes `packages/*/src/` or `packages/*/tests/` itself -- enforced
unconditionally by `.claude/hooks/guard-hub-src-writes.mjs` (blocks any
Write/Edit whose PreToolUse payload carries no `agent_type`, i.e. every
direct top-level edit) and `guard-branch-isolation.mjs` (the same block
specifically on `main`), plus `disallowedTools: Agent` on every spoke. This
was a deliberate choice among real alternatives (installing the harness
minus these two hooks, or holding off entirely) confirmed with the
maintainer during the self-adoption's Step 0 -- not a default nobody looked
at. For a piece of work with a clear contract:

1. `test-author` writes failing tests from the contract (RED phase), and
   confirms they fail for the right reason.
2. `code-implementer` makes them pass with the minimal correct
   implementation, then refactors while green (GREEN phase).
3. Read-only review spokes (`code-reviewer` always; `silent-failure-hunter`
   when the diff has error-handling paths) run in parallel over the diff.
   Must-fix findings route back to `code-implementer`, and the loop repeats
   until clean.

**A Claude Code Enterprise/managed deployment sits above this and can
silently disable it.** Anthropic's settings precedence puts managed
settings (a `managed-settings.json` file, an MDM policy, or a
claude.ai-console-managed remote policy) above every project file with no
override, and two managed-only keys -- `allowManagedHooksOnly` and
`allowManagedPermissionRulesOnly` -- make Claude Code skip this repo's own
`.claude/settings.json` hooks and permission rules entirely rather than
merge with them (see
[Claude Code's managed-settings docs](https://code.claude.com/docs/en/managed-settings)).
Nothing in this repo's own files can detect or gate against that -- the
managed file lives outside any project's working tree, at an OS-level path
(`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
`/etc/claude-code/managed-settings.json` on Linux, an equivalent under
`Program Files` on Windows), so `bin/check-harness.mjs` has no on-disk fact
to check and this is a documented limit, not a gate. Run `/status` before
trusting hub-and-spoke enforcement on a machine you don't control: its
"Setting sources" line names every active source, and if
`guard-hub-src-writes.mjs`/`guard-branch-isolation.mjs` aren't among what's
actually running, treat this section as an unenforced checklist rather than
an enforced gate until confirmed otherwise.

Full dispatch-sizing and recovery guidance:
`.claude/rules/agent-dispatch.md` (auto-loads when editing
`.claude/skills/**` or `.claude/agents/**`). Path-scoped rules auto-load on
matching files the same way: `.claude/rules/src.md` on `packages/*/src/**`,
`.claude/rules/tests.md` on `**/tests/**`/`**/*.test.ts`,
`.claude/rules/refactoring.md` on both (behavior-preserving changes).

**Forbidden patterns, hook-enforced:** `any` implied by CommonJS constructs,
a missing `.js` extension on a relative import, a hand-edit to `dist/` or
`coverage/`, a `packages/*/src/`/`tests/` write while on `main`, a real
secret written to disk (`guard-secret-writes.mjs`). **Conscious-care only,
no automated guard:** no `any` in a public API, never swallow an error
silently, no top-level side effects, never `git push --force`.

## Releases

Only `@monte3l/groundwork` (the CLI, `packages/cli`) ships to npm.
`@monte3l/groundwork-plugin` (`/customize`, `packages/plugin`) is `private`
and never published there -- it distributes only through the Claude Code
marketplace, `.claude-plugin/marketplace.json`'s single entry, whose `source`
is a **relative path** into `packages/plugin` in this same repo, not an npm
source -- the documented, no-registry way to ship a Claude Code plugin that
lives in the same repo as its CLI, and there is no equivalent reason to run
the plugin through a registry the way `npx @scope/pkg` needs one for the CLI.

**The flow.** A PR with a user-visible change to the CLI adds a changeset
(`pnpm changeset`) -- the plugin never takes one, since it has no release of
its own. A push to `main` runs `release.yml`, whose `select-mode` job decides:
with a changeset pending it opens a `chore(release): version packages` PR
(`pnpm version:packages` = `changeset version`, then
`bin/sync-plugin-version.mjs` copying the new CLI version into `plugin.json`,
then a lockfile refresh); with none pending and an unpublished version it
publishes. Publishing is `pack` (the full `pnpm verify`, then `pnpm test:e2e`,
then `changesets/action/pack`) followed by `publish`, the only job holding
`id-token: write`. The CLI gets provenance, a git tag and a GitHub Release
with its changelog -- **at the moment `npm stage publish` succeeds, not at the
moment the package is actually live**; see "staged, not direct" below.
`publish` also fetches the exact tarball `pack` already built and tested
back out of its own artifact (never rebuilt), runs
`actions/attest-build-provenance` on it, and attaches it to the GitHub
Release with `gh release upload` -- a second, independent proof alongside
npm provenance itself; see `SECURITY.md`'s "Verifying releases". A
plugin-only change needs no release step at all: it is live for marketplace
users (`/plugin marketplace update`) the moment it lands on `main`;
`plugin.json`'s version just trails the CLI's for display.

**Prerelease mode is on** (`.changeset/pre.json`, tag `rc`): the CLI shipped
one `0.x` line (`0.1.0-next.0`/`.1`, on the `next` dist-tag) before the public
API was defined, then switched tags (`pnpm changeset pre exit` immediately
followed by `pnpm changeset pre enter rc`, both in one commit -- splitting
them across commits lets `changeset version` run in the intervening `exit`
state and skip the prerelease suffix entirely) alongside a `major` changeset.
Changesets' prerelease counter does not reset across a tag switch, so the
first `rc` version continued from the `next` line's counter rather than
starting at `.0` or `.1` -- read `pnpm changeset status --verbose` before
relying on a specific number. The CLI's versions are now `1.0.0-rc.N` on the
`rc` dist-tag, so the README says `npx @monte3l/groundwork@rc`; `@next`
users must switch explicitly, since a prerelease range never crosses from
`0.1.0-next.N` to `1.0.0-rc.N` on its own. The public API (see the README's
"Versioning policy") is frozen as of the first `rc`: only `patch` changesets
land for the rest of the series, and any further API change waits for a
`1.1` after GA. Leave `rc` mode with `pnpm changeset pre exit` plus a normal
version PR once the promotion checklist is met, then drop `@rc` from the
README (and repoint the `next` dist-tag, and any marketplace channel, to the
stable release -- see the release plan for the full GA checklist).
Changesets itself warns against sitting in pre mode on the default branch
indefinitely.

**One-time setup, done by hand, that this design depends on.** npm cannot
configure a trusted publisher for a package that does not exist yet, so
`@monte3l/groundwork` was first published once as a `0.0.0` placeholder with a
temporary token (`@monte3l/groundwork-plugin` needs none of this -- it never
touches npm). That is also why `latest` points at `0.0.0` until the first
stable release. The trusted publisher is bound to the workflow filename
`release.yml` (the bare name, not a path): **renaming or moving that file
breaks publishing** until it is reconfigured on npmjs.com. The version job's
PR is opened with a GitHub App installation token, not the default
`GITHUB_TOKEN` (see "The version PR authenticates as a GitHub App" below),
so despite an earlier version of this doc, the repo's own
_Allow GitHub Actions to create and approve pull requests_ toggle
(`can_approve_pull_request_reviews`) is not actually needed for that step --
see "Known gaps" for turning it off. The trusted publisher's **allowed actions is
staged-only** (`npm stage publish`, no direct `npm publish`) -- npm's own
default for any trusted publisher created since 2026-09-03, and its explicit
recommendation over direct publish; see "staged, not direct" below for what
that costs and why it was kept rather than switched off.

**The version PR authenticates as a GitHub App, not the default
`GITHUB_TOKEN`.** `main`'s branch ruleset (see "Git Workflow" above) requires
`verify`, `Dependency Review` and `CodeQL` on every PR, with an empty
bypass list -- including this one. A PR opened with the default
`GITHUB_TOKEN` never triggers `pull_request`-event workflows (GitHub's own
anti-recursion rule), so those three checks would never post and the PR could
never merge. `release.yml`'s `version` job instead mints a one-hour
installation token from a GitHub App installed on just this repo
(`actions/create-github-app-token@v3`, reading the `APP_CLIENT_ID` /
`APP_PRIVATE_KEY` repo secrets) and passes it as `changesets/action/version`'s
`github-token`. That makes the PR behave like any human-opened one: the same
three checks run and satisfy the ruleset through its normal path, and the
`version` job's own `permissions:` stays `contents: read` -- the App token
does the actual writing, scoped to exactly `contents: write` +
`pull-requests: write` on the App itself. This is what both GitHub's own docs
("GITHUB_TOKEN") and changesets' own automating guide recommend for this
exact situation -- an App token over a PAT (shorter-lived, not tied to a
person) or a ruleset bypass (which would skip the checks rather than
satisfy them, undermining the empty `bypass_actors` list "Git Workflow"
describes).

**Things that look wrong but are deliberate.**

- **Staged, not direct.** `@monte3l/groundwork`'s trusted publisher only allows
  `npm stage publish`, not `npm publish` -- npmjs.com's own recommended,
  stronger setting, and its default for any trusted publisher created after
  2026-09-03 (this one was). A maintainer must separately run
  `npm stage approve <id>` (2FA, on the CLI or npmjs.com -- **never
  automatable**, by npm's own design) before a version is actually
  installable. `npm stage list --package @monte3l/groundwork` finds the id;
  the `publish` job's last step tries this too, best-effort, but that job
  never holds a login session so it may print nothing. The alternative --
  checking "allow npm publish" -- was considered and rejected: this package
  is a solo-maintainer pre-1.0 CLI, not the "high-impact, widely-used"
  case npm is targeting, but the version PR is already a real, reviewed gate
  before anything reaches `publish` at all, and the `publish` job's own
  containment (no build/test code, `--ignore-scripts`) already limits what a
  compromised token could do -- staging adds a second, stronger gate on top
  of a design that already had one. That trade means accepting the ordering
  cost above: the git tag and GitHub Release exist for a few minutes to
  however long approval takes, before `npm install` actually resolves the
  version.
- **`bin/pnpm-publish-shim.mjs` reroutes `pnpm publish` to `npm stage
publish`.** Two stacked reasons, not one: changesets publishes through
  `pnpm publish` in a pnpm workspace, and pnpm 12's native publish is
  rejected by npmjs.com's OIDC exchange (403 "OIDC permission denied"; still
  unfixed through pnpm 12.5.1 when this was written) -- and separately, a
  _direct_ `npm publish` would get the identical 403 for the unrelated
  staged-only reason above. The shim translates only changesets' exact
  invocation and refuses any flag it does not recognise; everything else
  passes through to pnpm. Delete the pnpm-OIDC half of this once pnpm's
  publish authenticates; the staged-vs-direct half stays regardless.
- **Changesets, not a hand-written publish script, owns the publish plan, tags
  and Releases.** Tarballs are packed in one job and published in another so the
  OIDC token is never present where build or test code runs. The `publish` job
  installs with `--ignore-scripts` and pins an exact `npm@` version (`npm
stage publish` needs >= 11.15.0, Node >= 22.14.0 -- already covered by
  `.node-version`'s 24), not a range or `latest` -- OpenSSF Scorecard's
  Pinned-Dependencies check flags a floating install the same way it flags
  an unpinned Action, and this job holds the OIDC token.
- **No package-manager cache in `release.yml`**, and no `cancel-in-progress`: a
  restored cache is an input an attacker can poison in the jobs that publish,
  and a half-published release is worse than a queued one.

**Versions that must agree.** `packages/plugin/.claude-plugin/plugin.json`'s
version tracks `packages/cli/package.json`'s (`bin/sync-plugin-version.mjs`
edits the text in place, not re-serializing JSON, so Prettier stays
satisfied). `check-plugin-version` (the `lint`-group gate,
`bin/check-plugin-version.mjs`) fails on that drift, and separately asserts
`packages/plugin/package.json` stays `private` and that
`.claude-plugin/marketplace.json`'s entry names the plugin correctly, points
at a non-npm source, and carries no version pin of its own -- three structural
guards against this design quietly regrowing the npm-publish shape it
deliberately dropped.

**The `npm-publish` environment closes the tag/Release ordering gap.**
`release.yml`'s `publish` job has `environment: npm-publish`, a GitHub
environment (created once, by hand, via `gh api` -- not committed as JSON,
same reasoning as the branch ruleset above) with one required reviewer (the
maintainer, self-review allowed since there's only one) and deployments
restricted to `main`. This pauses the job itself -- before the git tag, the
GitHub Release, or `npm stage publish` exist -- rather than only gating
`npm stage approve` afterward, which is the second, independent approval
this design accepts on top of npm's own staged-publish gate. Read the live
state with `gh api repos/monte3l/m3l-groundwork/environments/npm-publish`.

## Testing

`pnpm test:coverage`'s v8 coverage gate is `perFile: true` at OpenSSF Best
Practices' Gold-level bar -- 90% statements/lines, 80% branches/functions --
applied to all four metrics rather than only the two the criteria name,
same shape as `templates/core`'s own gate. A file with a genuinely
unexercised branch will fail this even if the aggregate looks fine -- see
`git.test.ts` (mocks `execFileSync` via `vi.hoisted`) and `main-run.test.ts`
(mocks `git.js`/`plugin.js`, exercises real `emitTemplate()` against a real
temp directory) for the patterns this repo uses to close that kind of gap
without mocking away the thing under test.

**Property-based tests** (`fast-check`, files named `*.property.test.ts`) run
alongside example-based ones inside `pnpm test` -- this is the project's
dynamic-analysis tool for OpenSSF Best Practices' Gold-level
`dynamic_analysis` criterion, so it runs on every push/PR and in
`release.yml`'s `pack` job before any release, not as a one-off manual pass.
They generate input across a parser's or boundary function's full domain
(`jsonc.ts`, `tokens.ts`, `assets.ts`'s dotfile mapping, `merge-json.ts`) and
differentially fuzz the harness grader's `frontmatter.ts` implementation
against its emitted JavaScript twin (the toolchain grader's own property
tests check it never throws and degrades to `{checked:0}` rather than
guessing, not a twin diff). See
[`docs/security-review.md`](docs/security-review.md) and `SECURITY.md`'s
"Dynamic analysis" for the full write-up, and `.claude/rules/tests.md` for
where a property test belongs alongside its example-based sibling.

`bootstrap.e2e.test.ts` is the only test that spawns real child processes
(the built CLI, then `pnpm install`/`pnpm verify` inside the emitted
project) -- it's excluded from `pnpm test`'s default run
(`vitest.config.ts`'s `**/*.e2e.test.ts` exclude) and only runs via
`pnpm test:e2e`. Run it after any change to `packages/cli/src/`,
`templates/core/`, or `packages/plugin/skills/customize/` -- it has already
caught real bugs a unit-test mock would have hidden (a wrong
`@commitlint/load` import shape, an absolute-path double-join in
`check-exports.mjs`, missing ESLint scope for `.claude/hooks/**`, a
coverage-exclude pattern that silently zeroed out the only file in a fresh
scaffold). Don't skip it before calling a change to the emitted baseline
done.

## Definition of Done

`pnpm verify` passes here; `pnpm test:e2e` passes if the change touched
`packages/cli/src/`, `templates/core/`, or the `/customize` skill; the
baseline's caps (above) still hold if a `.claude/` file was added or
removed from `templates/core`. Anything that changes what the CLI's tarball
ships or how it locates its data is proved by `pack.e2e.test.ts`, not by
running the CLI from the checkout, where every path resolves regardless. If
you touched this repo's _own_ `.claude/` (agents, hooks, skills, rules,
`settings.json` at root, not `templates/core/`), `node bin/check-harness.mjs`
must stay green the same way it does for the baseline: structural failures
gate, rubric findings only warn.

**A new tracked file outside `templates/**` needs an SPDX header** (a
`SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors` +
`SPDX-License-Identifier: MIT` line comment, near the top -- see
`bin/check-license-headers.mjs`) if its extension is `.ts`/`.mjs`/`.js`/
`.sh`/`.yml`/`.yaml`, or a glob in `REUSE.toml` otherwise (JSON, Markdown,
and the handful of dotfiles listed there never carry an inline header).
`node bin/check-license-headers.mjs --fix` inserts it. A file under neither
umbrella fails the `license-headers` verify step outright -- add a glob to
`REUSE.toml` in the same commit rather than widening the header-extension
set for one file.

## Known gaps (deliberately out of scope so far)

- `templates/packs/` ships three packs. `statusline` (a five-row statusLine
  plus a `subagentStatusLine` renderer, recovered from the retired
  predecessor's transcripts and stripped of its project-specific segments)
  is the only one that uses `wiring.settingsTopLevel`. `harness-extras` (a
  type-design analyzer agent, the compaction-handoff hook pair,
  `guard-readonly-bash`, a `check-file-budget` gate) -- the four artifacts
  the original build cut purely to fit a cap, not because they failed the
  generalization test. `claude-action` ships Anthropic's official
  `anthropics/claude-code-action` in mention-mode, and needs an auth secret
  the pack cannot create -- see its `adoptNotes`. Two
  more candidates from that same build (recorded in its
  `EXTRACTION-MANIFEST.md`, written to a scratchpad during the original
  build, not checked into this repo) remain deferred: a `github-ops` pack
  (`reviewing-dependabot-prs`, `triaging-scan-alerts` -- the most
  m3l-coupled of the original nine candidates) and a `publishing` pack (a
  release workflow, `check-publish-version`, `check-dts-deps` -- needs a
  registry/scope/`publishConfig` story the baseline doesn't have yet; this repo
  now has one to copy -- see "Releases" -- but `templates/core` is also at its
  three-workflow cap).
- **No standalone "add a pack to an already-bootstrapped project" flag.**
  Today that path is: re-run the CLI against the now-non-empty directory
  (it auto-detects adopt mode), then run `/customize`. Works, but is
  indirect -- a dedicated additive install mode is real future work.
- **CI does not use `pnpm/setup`**, though pnpm's docs now recommend it: it
  has no version-file input and reads Node from `package.json`'s
  `devEngines.runtime`, which would create a second Node pin beside
  `.node-version`. Hardcoding `runtime: node@N` in YAML is worse -- it
  evades `check-node-version.mjs`, whose regex only matches `node-version:`.
  Adopting it means teaching that gate (and its `templates/core` twin) about
  both forms first.
- **`.claude/` harness support for working _in this repo_ (as opposed to what
  it emits) is now installed** -- see "Agent Operating Model" below for what
  and why. It arrived by running this repo's own published CLI against
  itself (`npx @monte3l/groundwork@next .`, adopt mode) and its own
  `/customize` skill, the same path any adopter follows -- self-hosting as
  the first real end-to-end proof of both, not a hand-rolled install. Root's
  own `bin/check-harness.mjs` grades it (58 structural checks, 100% rubric)
  with the exact rule module `templates/core`'s twin uses.
  What _does_ already exist independently is `.claude/worktrees/`, created ad hoc whenever
  a background agent runs with `isolation: "worktree"`: a full second
  checkout of this repo, uncommitted state included. `.prettierignore`,
  `eslint.config.js` and both vitest configs exclude it explicitly -- without
  that, prettier fails on a sibling session's in-progress formatting and
  every test in the repo runs twice. Add the same exclusion to any new
  file-discovery config (a future ESLint plugin config, a coverage include
  list) rather than assuming the existing excludes cover it.
- **Adopt mode's `inventory.json` records `templateRoot` as an absolute
  path.** If the CLI ran from a location that no longer exists by the time
  `/customize` runs (a deleted temp checkout, a different machine), the
  approved additions can't be read; `/customize`'s Step 0 should report this
  and ask for a re-run rather than guessing at the baseline's contents. Now that
  the CLI is published this points into the installed package -- under `npx`,
  npm's `_npx` cache -- which persists until the cache is cleaned but is not a
  path the user chose.
- **Adopt mode's post-merge cap counts (in `report.ts`) are an estimate, not
  a reconciliation.** It assumes no name overlap between the baseline's
  agents/skills/hooks and the project's own -- good enough to flag "you may
  go over budget," not precise enough to be the final word; `/customize`'s
  Step 0 confirmation round settles it for real.
- **A 2026-09-26 GitHub-settings audit found real gaps this repo's own docs
  hadn't caught up to; some are fixed, several are still pending a manual
  `gh api` call or a dashboard toggle** (both org-write and secret-write
  actions need a human, not an agent, in this project's own tooling).
  Applied: `pull_request_creation_policy: collaborators_only` (see "Git
  Workflow"), and `gitleaks.yml`/the `claude.yml` `author_association`
  guard landed in the same change as this entry. Still pending, tracked
  here rather than left to drift like the ruleset already warns against:
  turn off `can_approve_pull_request_reviews` (repo and org --
  `PUT .../actions/permissions/workflow`; safe, since the release version
  PR uses a GitHub App token, not `GITHUB_TOKEN` -- see "Releases");
  require approval for all external contributors' workflow runs, not just
  first-time ones (`PUT .../actions/permissions/fork-pr-contributor-approval`
  with `all_external_contributors`); enforce SHA pinning and an actions
  allowlist (`sha_pinning_required: true`, `allowed_actions: selected`,
  covering `gitleaks/gitleaks-action` alongside the existing third-party
  actions); a tag-protection ruleset on `refs/tags/**` (deletion/
  non-fast-forward/update, empty `bypass_actors`) -- there is currently
  none, only the branch ruleset; restrict the org's `CLAUDE_CODE_OAUTH_TOKEN`
  and `GITLEAKS_LICENSE` secrets to the repos that actually use them
  (currently org-wide visibility); set the org's default repository
  permission below `admin`; and scope the Cloudflare and Claude GitHub App
  installations to selected repositories instead of every org repo. Once
  `gitleaks.yml` has a clean run on `main`, add it to the `main` ruleset's
  `required_status_checks` the same way `verify`/`Dependency Review`/
  `CodeQL` are pinned by `integration_id`.
