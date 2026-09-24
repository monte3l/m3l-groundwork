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

.changeset/             Changesets config, prerelease state (pre.json), and any
                         pending changesets. See "Releases".

.claude-plugin/         marketplace.json: lists the plugin as a relative-path
                         source into packages/plugin -- never npm -- for
                         `/plugin marketplace add`.

.github/                THIS repo's own CI (not the baseline's): ci.yml (five
                         verify lanes + e2e + the `verify` aggregator),
                         release.yml (see "Releases"), dependency-review.yml,
                         dependabot.yml

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
| `pnpm lint` / `lint:fix`              | ESLint over the whole repo (excludes `templates/**`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm format` / `format:check`        | Prettier write / check (covers `templates/**` too -- it's still committed text)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` / `test:coverage`         | Vitest unit tests, with or without the coverage gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test:e2e`                       | The real acceptance test, both modes: `bootstrap.e2e.test.ts` bootstraps a throwaway project into a temp dir with the built CLI and runs _that project's own_ `pnpm verify` (slow, ~15-20s, network-touching -- a real `pnpm install`); `adopt.e2e.test.ts` runs adopt mode against a fixture pre-existing project and asserts nothing outside `.groundwork/` and `.claude/skills/customize/` changed; `packs.e2e.test.ts` bootstraps with `--pack harness-extras` and asserts the emitted project's own `pnpm verify` (including the pack's gate) is green; `packs-statusline.e2e.test.ts` does the same for `--pack statusline` and also executes the emitted scripts against a real payload. `pack.e2e.test.ts` packs the CLI as a release would, unpacks the tarball outside the repo, and asserts it emits byte-identical output to the checkout (see "Releases"). None are part of `pnpm test`. |
| `pnpm knip`                           | Unused-dependency / unused-export hygiene, both packages; a `verify` step in the `lint` group                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm check:exports`                  | publint + attw against `packages/cli`'s packed tarball -- the one published package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm check:plugin-version`           | `plugin.json`'s version matches the CLI's, `packages/plugin/package.json` stays private, and `marketplace.json`'s entry names it correctly and carries no npm source or version pin of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
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
--group <name>`, plus an `e2e` job (`pnpm build` then `pnpm test:e2e`) and
  a `verify` aggregator -- the check the `main` ruleset gates on (see "Git
  Workflow"). The aggregator demands an explicit `success` from every
  lane, since testing only for `failure` reports green over a cancelled or
  skipped one. Two rules keep `gate-lane-parity` (the toolchain grader)
  working against this repo: **never name a step id in a workflow** (name a
  group), and **never matrix the lanes** -- `--group ${{ matrix.group }}`
  reads as dynamic, and because the grader concatenates every workflow file
  into one surface, that one line switches the check off for all of them.
  `pnpm eval` never runs in CI (paid model calls). **CodeQL is GitHub-managed
  default setup and has no file in this repo -- do not add a `codeql.yml`**,
  it collides with default setup. `bin/check-node-version.mjs` is live here
  now: every workflow takes Node from `node-version-file: .node-version`.
  `release.yml` follows the same two rules and adds a third: **it never writes
  the text `verify.mjs`**. The grader reads a workflow as text, so a bare or
  dynamic invocation there switches `gate-lane-parity` off for `ci.yml` too --
  measured, not assumed: the structural check count drops 42 to 37 and no
  finding is raised. Its `pack` job runs `pnpm verify` instead, which the
  scraper cannot see and which is a full run of every group anyway.
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

## Git Workflow

Single-maintainer project on GitHub (`monte3l/m3l-groundwork`, public).
Conventional Commits, enforced by the `commit-msg` hook
(`bin/lint-commit.mjs`) -- same convention `templates/core` emits into every
bootstrapped project. Add a `Co-Authored-By:` trailer when Claude authored or
substantially assisted a commit. The release workflow's version PR and commit
use `chore(release): version packages` so they satisfy the same convention.

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
moment the package is actually live**; see "staged, not direct" below. A
plugin-only change needs no release step at all: it is live for marketplace
users (`/plugin marketplace update`) the moment it lands on `main`;
`plugin.json`'s version just trails the CLI's for display.

**Prerelease mode is on** (`.changeset/pre.json`, tag `next`): the CLI's
versions are `0.1.0-next.N` on the `next` dist-tag, so the README says
`npx @monte3l/groundwork@next`. Leave it with `pnpm changeset pre exit` plus a
normal version PR, then drop `@next` from the README. Changesets itself warns
against sitting in pre mode on the default branch indefinitely.

**One-time setup, done by hand, that this design depends on.** npm cannot
configure a trusted publisher for a package that does not exist yet, so
`@monte3l/groundwork` was first published once as a `0.0.0` placeholder with a
temporary token (`@monte3l/groundwork-plugin` needs none of this -- it never
touches npm). That is also why `latest` points at `0.0.0` until the first
stable release. The trusted publisher is bound to the workflow filename
`release.yml` (the bare name, not a path): **renaming or moving that file
breaks publishing** until it is reconfigured on npmjs.com. The repo also needs
_Allow GitHub Actions to create and approve pull requests_ enabled, or the
version job cannot open its PR. The trusted publisher's **allowed actions is
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
  installs with `--ignore-scripts` and pins `npm@^11.15.0` (`npm stage publish`
  needs >= 11.15.0, Node >= 22.14.0 -- already covered by `.node-version`'s 24)
  rather than `latest`.
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

**Not done, worth knowing.** Staged publishing gates going live, but not the
tag/Release ordering problem above -- both are already created by the time a
maintainer even sees there's something to approve. A GitHub `environment`
with required reviewers on the `publish` job would gate the job itself, before
`npm stage publish` (and therefore the tag/Release) ever runs, closing that
gap -- at the cost of a second approval on top of npm's own, and needing to
stay in sync with whatever the trusted-publisher configuration expects.

## Testing

`pnpm test:coverage`'s v8 coverage gate is `perFile: true` at 80% across all
four metrics, same shape as `templates/core`'s own gate. A file with a
genuinely unexercised branch will fail this even if the aggregate looks
fine -- see `git.test.ts` (mocks `execFileSync` via `vi.hoisted`) and
`main-run.test.ts` (mocks `git.js`/`plugin.js`, exercises real
`emitTemplate()` against a real temp directory) for the patterns this repo
uses to close that kind of gap without mocking away the thing under test.

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
running the CLI from the checkout, where every path resolves regardless.

## Known gaps (deliberately out of scope so far)

- `templates/packs/` ships two packs. `statusline` (a five-row statusLine
  plus a `subagentStatusLine` renderer, recovered from the retired
  predecessor's transcripts and stripped of its project-specific segments)
  is the only one that uses `wiring.settingsTopLevel`. The other,
  `harness-extras` (a type-design
  analyzer agent, the compaction-handoff hook pair, `guard-readonly-bash`,
  a `check-file-budget` gate) -- the four artifacts the original build cut
  purely to fit a cap, not because they failed the generalization test. Two
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
- `.claude/` harness support (agents/hooks/skills for working _in this repo_
  specifically, as opposed to what it emits) does not exist yet. If this
  repo is ever edited from inside a Claude Code session that has its own
  PreToolUse write-time guards configured, a hook whose path-shape rule is
  scoped to something like `packages/*/src/**`/`**/tests/**` can false-
  positive here purely because this repo happens to share that directory
  shape (`packages/cli/src/`, `packages/plugin/tests/`) -- that is a
  property of whatever session is doing the editing, not of this repo.
  What _does_ already exist is `.claude/worktrees/`, created ad hoc whenever
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
