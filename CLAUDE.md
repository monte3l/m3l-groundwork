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
                          caps.ts, packs.ts, merge-json.ts, palette.ts, term.ts,
                          assets.ts (the one place that locates templates/ and
                          the plugin payload)
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
                          + packs.e2e.test.ts + packs-github.e2e.test.ts
                          + pack.e2e.test.ts (the published tarball, run
                          from outside the repo)

packages/plugin/        Phase B: the /customize skill
  skills/customize/       SKILL.md (Step 0 is the adopt-mode reconcile step)
  src/                    kind-facet-map.ts, domain-map.ts, pack-map.ts,
                          plugin-map.ts, index.ts
  tests/                  unit tests for all four

.claude/                THIS repo's own harness (not the baseline's): agents/,
                         hooks/, rules/, skills/, settings.json -- installed by
                         self-adopting `templates/core`'s harness plus the
                         `harness-extras` pack's statusline half. See "Agent
                         Operating Model". worktrees/ is unrelated -- see
                         "Known gaps".

.changeset/             Changesets config, prerelease state (pre.json), and any
                         pending changesets. See "Releases".

.claude-plugin/         marketplace.json: lists the plugin as a relative-path
                         source into packages/plugin -- never npm -- for
                         `/plugin marketplace add`.

.github/                THIS repo's own CI (not the baseline's): ci.yml (five
                         verify lanes + e2e + node-current + the `verify`
                         aggregator), release.yml (see "Releases"), docs.yml
                         (builds the docs site and deploys it to Cloudflare
                         Workers Static Assets -- see .claude/rules/docs-site.md
                         and docs/cloudflare-docs.md), environments.yml (weekly
                         cleanup of stale GitHub Deployments/Environments --
                         see .claude/rules/environments.md),
                         dependency-review.yml, scorecard.yml, gitleaks.yml,
                         security-audit.yml (daily `pnpm audit`, opens one
                         issue on a high-severity advisory),
                         claude.yml, claude-pr-review.yml, dependabot.yml,
                         deploy-tools/ (pins the exact wrangler version
                         docs.yml's deploy job installs, same pattern as
                         release-tools/), environments.json (the cleanup
                         policy), ISSUE_TEMPLATE/, pull_request_template.md

design/                 m3l-design, vendored -- see design/README.md and
                         .claude/rules/design-system.md. source/ is a
                         verbatim copy; tokens.css is generated from it by
                         bin/build-design-tokens.mjs. local/ is this repo's
                         own docs-site layout CSS, the one sanctioned
                         divergence from the vendored system (see
                         design/README.md's "design/local/").

docs/architecture.md    A human-facing distillation of this file's own
                         architecture notes -- for anyone reading the project
                         rather than editing it.
docs/assurance-case.md  The OpenSSF Best Practices Silver `assurance_case`:
                         threat model, trust boundaries, a Saltzer & Schroeder
                         argument, and a CWE Top 25 mitigation table.
docs/security-review.md The Gold-level `dynamic_analysis` write-up -- see
                         "Testing" below.
docs/glossary.md        Term definitions shared across the other docs pages.
docs/cloudflare-docs.md The docs-site deploy target -- see
                         .claude/rules/docs-site.md.
docs/environment-janitor.md
                         The environment-cleanup GitHub App's permissions and
                         one-time setup -- see .claude/rules/environments.md.
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
                         baseline. `harness-extras/`, `github/`,
                         `publishing/`, `supply-chain/`, `worktrees/`, and
                         `ts-advisor/` ship
                         today; see its own README.md for the wiring
                         contract and "Known gaps" below for the deferred
                         candidates.
```

## Commands

Run any task with `pnpm <script>`.

| Script                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                          | `tsc -b` both packages' `tsconfig.build.json`, emits `dist/`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm typecheck`                      | `tsc -b --force` over both packages' tooling projects (src + tests)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm lint` / `lint:fix`              | ESLint over the whole repo (excludes `templates/**`), `--max-warnings 0` -- a warning fails the gate the same as an error                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm format` / `format:check`        | Prettier write / check (covers `templates/**` too -- it's still committed text)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test` / `test:coverage`         | Vitest unit tests, with or without the coverage gate                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm test:e2e`                       | The real acceptance test: `bootstrap.e2e.test.ts`, `adopt.e2e.test.ts`, `packs.e2e.test.ts`, `packs-github.e2e.test.ts` and `pack.e2e.test.ts` -- slow and network-touching (real `pnpm install`s and a packed tarball). None are part of `pnpm test`; see "Testing" below for what each one guards.                                                                                                                                                                                                             |
| `pnpm knip`                           | Unused-dependency / unused-export hygiene, both packages; a `verify` step in the `lint` group                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm check:exports`                  | publint + attw against `packages/cli`'s packed tarball -- the one published package                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm check:plugin-version`           | `plugin.json`'s version matches the CLI's, `packages/plugin/package.json` stays private, and `marketplace.json`'s entry names it correctly and carries no npm source or version pin of its own                                                                                                                                                                                                                                                                                                                   |
| `pnpm check:plugin-manifest`          | Runs Anthropic's `claude plugin validate --strict` against the marketplace manifest and `packages/plugin`; skips cleanly with a warning when the `claude` CLI isn't installed                                                                                                                                                                                                                                                                                                                                    |
| `pnpm changeset` / `version:packages` | Add a changeset; version the packages (what the release workflow runs -- see "Releases")                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm check:node-version`             | `.node-version` is authoritative; forbids a hardcoded pin in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm check:harness`                  | Grades `templates/core`'s Claude Code harness (`.claude/` + `CLAUDE.md`) with the emitted gate's own rule module: structural defects fail, rubric findings warn                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm check:toolchain`                | Grades `templates/core`'s TypeScript toolchain (tsconfig chain, ESLint and vitest config, verify-step wiring, toolchain pins) with the emitted gate's own rule module: structural defects fail, rubric findings warn                                                                                                                                                                                                                                                                                             |
| `pnpm check:license-headers`          | Every tracked file outside `templates/**` carries an SPDX header or is exempted by `REUSE.toml`; `-- --fix` inserts a missing header (see "Definition of Done")                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm eval`                           | **Paid, never in `verify`.** Runs Anthropic's `claude plugin eval` on `/customize`, on a generated wrapper over `templates/core`'s skills (triggering accuracy), on that same wrapper widened with every `templates/packs/*/files/.claude/skills` merged in (cross-pack triggering, including negatives against `typescript-guidance`), and on `typescript-guidance` against a deliberately degraded project; needs `claude`, credentials, network. Skips cleanly without `claude`. See `.claude/rules/evals.md` |
| `pnpm verify`                         | Every gate above (via `bin/lib/verify-steps.mjs`). `node bin/verify.mjs --group <name>` runs one of the five groups -- exactly what `lefthook`'s `pre-push` and each `ci.yml` lane invoke; `--step <id>` is for local debugging only and must never appear in either YAML file                                                                                                                                                                                                                                   |
| `pnpm test:watch`                     | Vitest in watch mode for local iteration -- not a `verify` step                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm prepare`                        | Installs the lefthook git hooks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
- **`pack-map.ts` and `plugin-map.ts` are the same "infer once, visibly,
  with reasoning attached" pattern applied to two different install
  surfaces.** `recommendPacks` (`pack-map.ts`) recommends which
  `templates/packs/*` bundle(s) to install; `recommendPlugins`
  (`plugin-map.ts`) recommends which locally-installed, built-in
  `claude-plugins-official` marketplace plugin(s) to enable -- both pure
  functions of the interview answers (plus, for `plugin-map.ts`, which
  packs were chosen and whether the project authors its own skills), each
  with its own unit-tested table so a recommendation's evidence is never
  invented fresh at `/customize` run time.
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
- **Behavioural evals (`pnpm eval`) are a separate, paid layer from
  `check:harness`**, deliberately excluded from `pnpm verify`/`pre-push`
  since they make real model calls. Full detail: `.claude/rules/evals.md`
  (auto-loads on `evals/**`, `packages/plugin/evals/**`, `bin/eval.mjs`).
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
- **Continuous integration (`.github/`) and the two Claude Code Actions
  workflows.** `ci.yml` runs five verify lanes plus `e2e`/`node-current`
  behind a `verify` aggregator (the check `main`'s ruleset gates on --
  see "Git Workflow"); `claude.yml`/`claude-pr-review.yml` run Anthropic's
  official action, model-pinned and scoped to read-only PR comments. Full
  detail, including the `gate-lane-parity` rules that must never be broken
  and the one-time GitHub App setup: `.claude/rules/ci.md` (auto-loads on
  `.github/**`, `lefthook.yml`, `bin/verify.mjs`, `bin/lib/verify-steps.mjs`).
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
  Never hand-edit `design/source/`; after a DTCG change, re-run
  `node bin/build-design-tokens.mjs` and commit `design/tokens.css` in the
  same change (`--check` is the `lint`-group verify step). The same
  generator also emits `packages/cli/src/palette.ts`, the terminal palette
  `packages/cli/src/term.ts` paints console output with. Full detail:
  `.claude/rules/design-system.md` (auto-loads on `design/**`,
  `bin/build-design-tokens.mjs`, `packages/cli/src/{palette,term}.ts`).
- **The docs site** (`.github/workflows/docs.yml`, deployed from `main` to
  `https://groundwork.monte3l.com` on Cloudflare Workers Static Assets) is a
  restricted, zero-dependency GFM-to-HTML renderer that throws rather than
  guessing at markdown outside the ten rendered pages' inventory. Full
  detail: `.claude/rules/docs-site.md` (auto-loads on `bin/build-docs.mjs`,
  `bin/lib/markdown.mjs`, `.github/workflows/docs.yml`).
- **Environment cleanup** (`.github/workflows/environments.yml`) removes
  stale GitHub Deployments/Environments this repo's own CI leaves behind,
  since GitHub never removes one on its own. Full detail:
  `.claude/rules/environments.md` (auto-loads on
  `.github/workflows/environments.yml`, `bin/cleanup-environments.mjs`).

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

CI runs on every push and PR to `main` (see `.claude/rules/ci.md`), and a
repository ruleset named `main` enforces the rest. It targets
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
commits the ruleset rejects only at merge time. `guard-branch-isolation.mjs`
**is** installed on this repo's own root (see "Agent Operating Model" below)
and blocks a `packages/*/src/`/`packages/*/tests/` write while `HEAD` is
`main` -- but nothing in this repo's own hooks blocks committing any other
file straight to `main` locally; the ruleset is the remote-side catch and
only bites at push time, so branch first regardless.

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
   when the diff has error-handling paths; `baseline-impact-reviewer` when
   the diff touches `templates/core/` or `templates/packs/`, checking the
   baseline's own structural contracts -- caps, `domain-map.ts` coverage,
   dotfile escaping, pack budgets -- that the other two don't know about)
   run in parallel over the diff. Must-fix findings route back to
   `code-implementer`, and the loop repeats until clean.

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
`.claude/rules/refactoring.md` on both (behavior-preserving changes),
`.claude/rules/docs.md` on this repo's own markdown (`templates/**`
excluded, since it ships brand-neutral into every bootstrapped project) --
the m3l-design content conventions (bold not italics, GitHub alerts for a
must-not-miss point, plain copy, tabular data in tables) -- and six more
covering this repo's own area-specific surfaces: `.claude/rules/ci.md`,
`.claude/rules/releases.md`, `.claude/rules/design-system.md`,
`.claude/rules/docs-site.md`, `.claude/rules/environments.md`, and
`.claude/rules/evals.md`. Each names its own trigger paths in its
frontmatter and is cross-referenced from the section above it replaced.

**Forbidden patterns, hook-enforced:** `any` implied by CommonJS constructs,
a missing `.js` extension on a relative import, a hand-edit to `dist/` or
`coverage/` (`guard-protected-paths.mjs`), a `packages/*/src/`/`tests/`
write while on `main`, a real secret written to disk
(`guard-secret-writes.mjs`), an unsigned `git push` when `commit.gpgsign`
is on (`guard-git-push-signed.mjs`), and stacking `run_in_background: true`
with a shell-level detach construct in the same Bash call
(`guard-double-background.mjs`). **Conscious-care only, no automated
guard:** no `any` in a public API, never swallow an error silently, no
top-level side effects, never `git push --force`.

## Releases

Only `@monte3l/groundwork` (the CLI, `packages/cli`) ships to npm.
`@monte3l/groundwork-plugin` (`/customize`, `packages/plugin`) is `private`
and distributes only through the Claude Code marketplace
(`.claude-plugin/marketplace.json`'s relative-path `source`), never npm.
A PR with a user-visible CLI change adds a changeset (`pnpm changeset`); a
push to `main` runs `release.yml`, which opens a version PR or publishes.
Prerelease `rc` mode is on -- only `patch` changesets land until GA.

A few invariants matter even when this file isn't open: **renaming or
moving `release.yml` breaks npm's trusted publisher**; publishes are
**staged, not direct** (`npm stage approve` is a separate, non-automatable
2FA step -- the git tag and GitHub Release exist before the package is
actually installable); the version PR authenticates as a GitHub App, not
`GITHUB_TOKEN`, because `main`'s ruleset requires checks a bot-token PR
can't trigger; and a plugin-only change needs no changeset or release step
at all.

Full detail -- the publish flow, the prerelease/GA plan, the one-time npm
and GitHub App setup, `bin/pnpm-publish-shim.mjs`'s OIDC workaround, and the
`npm-publish` environment gate: `.claude/rules/releases.md` (auto-loads on
`.github/workflows/release.yml`, `.changeset/**`, `.claude-plugin/**`,
`packages/*/package.json`).

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
`settings.json` at root, not `templates/core/`), grade it the same way the
baseline's `bin/check-harness.mjs` grades `templates/core` -- there is no
`package.json` script for this (only the emitted baseline gets one), so use
the `grade-own-harness` skill (`/grade-own-harness`), which points the same
rule module at the repo root instead. Structural failures gate, rubric
findings only warn -- same rule as the baseline.

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

- `templates/packs/` ships six packs, each covering one theme rather than
  one theme per artifact. `harness-extras` is Claude Code session
  ergonomics: a type-design analyzer agent, the compaction-handoff hook
  pair, `guard-readonly-bash`, a `check-file-budget` gate (the four
  artifacts the original baseline build cut purely to fit a cap, not
  because they failed the generalization test), plus a five-row statusLine
  and a `subagentStatusLine` renderer (recovered from the retired
  predecessor's transcripts and stripped of its project-specific segments,
  originally its own `statusline` pack, folded in here because both halves
  are language- and harness-level rather than domain-level). It's the only
  pack that uses `wiring.settingsTopLevel`, and in adopt mode a project that
  already defines `statusLine`/`subagentStatusLine` skips just those keys
  and the three statusline scripts rather than failing the whole install.
  `github` (renamed from `claude-action`) is GitHub-hosted collaboration:
  Anthropic's official `anthropics/claude-code-action` in mention-mode, a
  second Action that posts an automated Claude review comment on every PR,
  and three `gh`-CLI skills recovered from the predecessor build's
  `EXTRACTION-MANIFEST.md` (its "best first-pack candidates", generalized
  rather than shipped verbatim) -- `reviewing-dependabot-prs` (classify and
  batch-merge open Dependabot PRs), `triaging-scan-alerts` (triage open
  code-scanning alerts to file:line, report only, never edits code), and
  `watching-pr-checks` (check a PR's CI status, hand off to a project's own
  `/triaging-ci` on a real failure). Both workflows need an auth secret the
  pack cannot create -- see its `adoptNotes`. `publishing` is a release
  pipeline, adapted from this repo's own working implementation (see
  "Releases"): `release.yml` (changesets
  version-PR / staged, provenance-attested npm publish via trusted
  publishing OIDC), `check-publish-version.mjs` (no-ops on `private: true`
  or an unreachable registry), `check-dts-deps.mjs` (a published `.d.ts`
  file must not import a package that's only a devDependency),
  `check-license-headers.mjs` (generalized from this
  repo's own copy with a `__PROJECT_NAME__` token in place of a hardcoded
  copyright holder, and with the `templates/**` brand-neutrality exemption
  dropped -- an emitted project has no such tree of its own) and a
  `REUSE.toml` template. Fresh mode only: the release flow encodes
  decisions (registry access, npm trusted-publisher setup, a GitHub App for
  the version PR) too project-specific for an automated adopt-mode install
  -- see its `adoptNotes`. It cannot wire `@changesets/cli` itself either,
  since the wiring contract only extends `package.json`'s `scripts`, never
  its `dependencies`/`devDependencies` -- its shipped `.changeset/README.md`
  says so. `supply-chain` is the OpenSSF supply-chain half, split out of
  `publishing` because it is useful to any GitHub project, published or not:
  `gitleaks.yml` (secret scanning, with a `.gitleaks.toml`) and
  `scorecard.yml`, two read-only workflows and nothing else -- adopt-capable
  and recommended for every project kind. The SPDX license-header gate stays
  in `publishing`: it fails an established project's `pnpm verify` until a
  one-time backfill touches every file, so it cannot be an adopt-mode
  install. `worktrees` enforces that all src/tests development happens
  inside an isolated git worktree, on any branch, for any caller
  (`guard-worktree-only.mjs`, stricter than the baseline's own
  `guard-branch-isolation.mjs`/`guard-hub-src-writes.mjs`, which only block
  on `main` and only block the hub respectively), plus a
  `working-in-worktrees` skill (start/status/sync/finish/fan-out), an
  `ensure-worktree-deps.mjs` `SessionStart` backstop that installs
  dependencies into a freshly created worktree, and a `.worktreeinclude`
  copying `.env`/`.env.local`/`.env.*.local` into every worktree Claude Code creates. It's
  the pack this repo's
  own `.claude/hooks/post-edit-verify.mjs` and `finishing-work`/
  `starting-work` worktree-awareness (see `.claude/hooks/post-edit-verify.mjs`'s
  own header comment) were a prerequisite for, not a replacement of -- those
  fixes make the harness _correct_ inside a worktree that already exists;
  this pack is what makes worktree-only development the _default_ workflow.
  `recommended: false` in `pack-map.ts` deliberately, since it changes the
  day-to-day workflow rather than adding a nicety -- see its `adoptNotes`.
  `ts-advisor` is a read-only `recommending-ts-tooling` skill: profiles the
  project's TypeScript toolchain offline (scripts, dependencies, the
  resolved tsconfig chain, eslint/vitest/knip config, cap counts, verify-step
  wiring), then fans out live `Explore` research over official upstream
  tooling sources before recommending what's missing -- tsconfig flags,
  module resolution, typed linting, testing, packaging validation,
  dependency hygiene, pnpm supply-chain settings, scripts/verify gates,
  monorepo/catalogs, Node pinning, release automation. Every recommendation
  carries a source fetched in that run; an unverifiable claim is reported as
  such, never recommended anyway. It reuses `typescript-guidance`'s own
  TypeScript-owner allowlist for that tier rather than duplicating it, and
  ships a sibling allowlist (`references/tooling-sources.md`) for the rest of
  the ecosystem. No hooks, no settings, no scripts, no gate -- a pure file
  drop of one skill plus its reference material. It never rules on config
  that already exists -- that stays `typescript-guidance`'s authority (see
  the skill's own "Authority split" section); this pack covers only what's
  absent.
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
  it emits) is now installed** -- see "Agent Operating Model" above for what
  and why. It arrived by running this repo's own published CLI against
  itself (`npx @monte3l/groundwork@next .`, adopt mode) and its own
  `/customize` skill, the same path any adopter follows -- self-hosting as
  the first real end-to-end proof of both, not a hand-rolled install. Grade
  it with the same rule module `templates/core`'s `bin/check-harness.mjs`
  uses (see "Definition of Done" for the command) -- 0 structural findings
  expected.
  What _does_ already exist independently is `.claude/worktrees/**`,
  created ad hoc whenever a background agent runs with
  `isolation: "worktree"`: a full second checkout of this repo, uncommitted
  state included. `.gitignore`, `.prettierignore`, `eslint.config.js` and both
  vitest configs exclude it explicitly -- without that, prettier fails on a
  sibling session's in-progress formatting and every test in the repo runs
  twice. Add the same exclusion to any new file-discovery config (a future
  ESLint plugin config, a coverage include list) rather than assuming the
  existing excludes cover it. `templates/core` carries the same four
  exclusions, plus `.gitignore` entries for `.env`/`.env.local`/
  `.env.*.local` (never commit secrets, regardless of whether a project adds
  its own `.worktreeinclude` file) so an emitted project gets the same
  protection from day one -- see
  `packages/cli/tests/survey/fs-walk.test.ts` and
  `packages/cli/tests/post-edit-verify.test.ts` for the regression coverage.
  `.claude/hooks/post-edit-verify.mjs` (both this repo's own copy and
  `templates/core`'s) resolves the git working-tree root that actually
  contains the edited file (`resolveVerifyRoot`) rather than trusting
  `CLAUDE_PROJECT_DIR`, which Claude Code pins to the session's original
  root and does not move into a worktree -- see the hook's own
  header comment. `finishing-work` and `starting-work` know about a linked
  worktree too (checking `git worktree list --porcelain` before deleting a
  branch, and handing off to the optional `worktrees` pack's own skill for
  the branch step when it's installed), but nothing here yet **enforces**
  worktree-only development or automates per-worktree dependency
  installation -- that is the `worktrees` pack, tracked as separate,
  not-yet-landed work.
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
  hadn't caught up to.** Both org-write and secret-write actions need a
  human, not an agent, in this project's own tooling, so most items below
  are still pending a manual `gh api` call or a dashboard toggle -- tracked
  here rather than left to drift like the ruleset already warns against.
  Applied so far: `pull_request_creation_policy: collaborators_only` (see
  "Git Workflow") and `gitleaks.yml`/the `claude.yml` `author_association`
  guard, both landed in the same change as this entry.

  A 2026-09-29 re-audit read the live settings and found every item below
  still pending, plus four more: `prevent_self_review` is `false` on the
  `npm-publish` environment, the org's defaults for new repositories have no
  security feature on, the standard labels (`dependencies`, `security`) don't
  exist, and rebase-merge is still enabled at repo level (the ruleset blocks
  it, so it only confuses). Immutable releases are deliberately **not** on
  the list: `release.yml` uploads assets after the Release exists, which
  immutability would block. The exact commands are in
  [`docs/github-blueprint.md`](docs/github-blueprint.md); the repo-scope ones
  are also scripted in `monte3l/.github` (`bin/apply-repo-baseline.sh`,
  `--check` first). An agent's attempt to apply them was refused by Claude
  Code's permission classifier, which confirms the rule above: run them
  yourself. When you do, the SHA-pinning allowlist must cover sub-path
  actions (`changesets/action/pack@...`), so allow `changesets/action/*` as well as
  `changesets/action@*`.

  | Pending item                                                                            | How to apply                                                                                                                              | Why it's safe                                                                                         |
  | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | Turn off `can_approve_pull_request_reviews` (repo and org)                              | `PUT .../actions/permissions/workflow`                                                                                                    | The release version PR uses a GitHub App token, not `GITHUB_TOKEN` -- see `.claude/rules/releases.md` |
  | Require approval for all external contributors' workflow runs, not just first-time ones | `PUT .../actions/permissions/fork-pr-contributor-approval` with `all_external_contributors`                                               | Closes the gap left by first-time-only approval                                                       |
  | Enforce SHA pinning and an actions allowlist                                            | `sha_pinning_required: true`, `allowed_actions: selected`, covering `gitleaks/gitleaks-action` alongside the existing third-party actions | Matches what's already done by hand                                                                   |
  | Add a tag-protection ruleset on `refs/tags/**`                                          | Deletion/non-fast-forward/update, empty `bypass_actors`                                                                                   | There is currently none, only the branch ruleset                                                      |
  | Restrict `CLAUDE_CODE_OAUTH_TOKEN` and `GITLEAKS_LICENSE` to the repos that use them    | Org secret settings                                                                                                                       | Currently org-wide visibility                                                                         |
  | Set the org's default repository permission below `admin`                               | Org settings                                                                                                                              | Reduces blast radius of a compromised member account                                                  |
  | Scope the Cloudflare and Claude GitHub App installations to selected repositories       | App settings                                                                                                                              | Currently installed on every org repo                                                                 |

  Once `gitleaks.yml` has a clean run on `main`, add it to the `main`
  ruleset's `required_status_checks` the same way `verify`/
  `Dependency Review`/`CodeQL` are pinned by `integration_id`.
