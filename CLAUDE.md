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
                          caps.ts, packs.ts, merge-json.ts
  src/harness/            the harness grader: frontmatter.ts, rules.ts, grade.ts,
                          conformance.ts, types.ts
  src/survey/             survey.ts + one collector per discovery area
                          (survey-shape, survey-toolchain, survey-harness,
                          survey-docs), fs-walk.ts, types.ts
  bin/                    m3l-groundwork.mjs -- the published entry point
  tests/                  unit tests + bootstrap.e2e.test.ts + adopt.e2e.test.ts
                          + packs.e2e.test.ts

packages/plugin/        Phase B: the /customize skill
  skills/customize/       SKILL.md (Step 0 is the adopt-mode reconcile step)
  src/                    kind-facet-map.ts, domain-map.ts, pack-map.ts, index.ts
  tests/                  unit tests for all three

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

| Script                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                   | `tsc -b` both packages' `tsconfig.build.json`, emits `dist/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm typecheck`               | `tsc -b --force` over both packages' tooling projects (src + tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm lint` / `lint:fix`       | ESLint over the whole repo (excludes `templates/**`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm format` / `format:check` | Prettier write / check (covers `templates/**` too -- it's still committed text)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm test` / `test:coverage`  | Vitest unit tests, with or without the coverage gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test:e2e`                | The real acceptance test, both modes: `bootstrap.e2e.test.ts` bootstraps a throwaway project into a temp dir with the built CLI and runs _that project's own_ `pnpm verify` (slow, ~15-20s, network-touching -- a real `pnpm install`); `adopt.e2e.test.ts` runs adopt mode against a fixture pre-existing project and asserts nothing outside `.groundwork/` and `.claude/skills/customize/` changed; `packs.e2e.test.ts` bootstraps with `--pack harness-extras` and asserts the emitted project's own `pnpm verify` (including the pack's gate) is green; `packs-statusline.e2e.test.ts` does the same for `--pack statusline` and also executes the emitted scripts against a real payload. None are part of `pnpm test`. |
| `pnpm knip`                    | Unused-dependency / unused-export hygiene, both packages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm check:exports`           | publint + attw against this repo's own root (a private package -- skips cleanly with a warning)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm check:node-version`      | `.node-version` is authoritative; forbids a hardcoded pin in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm check:harness`           | Grades `templates/core`'s Claude Code harness (`.claude/` + `CLAUDE.md`) with the emitted gate's own rule module: structural defects fail, rubric findings warn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm verify`                  | Every gate above (via `bin/lib/verify-steps.mjs`), in the order `lefthook`'s `pre-push` runs them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm prepare`                 | Installs the lefthook git hooks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Run `pnpm verify` (or just push -- `lefthook`'s `pre-push` runs the same
steps) before considering any task here done.

## Architecture notes

- **Token substitution is a plain string replace, not a template engine**
  (`packages/cli/src/tokens.ts`). `applyTokens` swaps `__KEY__` literals in
  both file content and path segments. `templatesCoreDir()`
  (`main.ts`) resolves `templates/core` relative to the _running_ module,
  so it works identically from source (`vitest`) and from the built
  `dist/main.js` the published `bin/m3l-groundwork.mjs` actually invokes --
  don't hardcode a path assuming one or the other.
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
  (`templates/core/bin/lib/verify-steps.mjs`). Add a new baseline gate to
  `CORE_STEPS` here, not as a bespoke script invocation in either YAML
  file.
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
substantially assisted a commit.

No branch-protection ruleset is configured on the GitHub repo yet, and nothing
in this repo's own hooks blocks a direct commit to `main` the way
`guard-branch-isolation.mjs` does for `templates/core`'s _emitted_ projects
(that guard ships in the baseline; it doesn't apply to building the
bootstrapper itself). Prefer a feature branch + PR for anything non-trivial
regardless -- there's just no automated gate enforcing it today.

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
removed from `templates/core`.

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
  registry/scope/`publishConfig` story the baseline doesn't have yet).
- **No standalone "add a pack to an already-bootstrapped project" flag.**
  Today that path is: re-run the CLI against the now-non-empty directory
  (it auto-detects adopt mode), then run `/customize`. Works, but is
  indirect -- a dedicated additive install mode is real future work.
- No npm publishing, release automation, or version bumping.
- `.claude/` harness support (agents/hooks/skills for working _in this repo_
  specifically, as opposed to what it emits) does not exist yet. If this
  repo is ever edited from inside a Claude Code session that has its own
  PreToolUse write-time guards configured, a hook whose path-shape rule is
  scoped to something like `packages/*/src/**`/`**/tests/**` can false-
  positive here purely because this repo happens to share that directory
  shape (`packages/cli/src/`, `packages/plugin/tests/`) -- that is a
  property of whatever session is doing the editing, not of this repo.
- **Adopt mode's `inventory.json` records `templateRoot` as an absolute
  path.** If the CLI ran from a location that no longer exists by the time
  `/customize` runs (a deleted temp checkout, a different machine), the
  approved additions can't be read; `/customize`'s Step 0 should report this
  and ask for a re-run rather than guessing at the baseline's contents.
- **Adopt mode's post-merge cap counts (in `report.ts`) are an estimate, not
  a reconciliation.** It assumes no name overlap between the baseline's
  agents/skills/hooks and the project's own -- good enough to flag "you may
  go over budget," not precise enough to be the final word; `/customize`'s
  Step 0 confirmation round settles it for real.
