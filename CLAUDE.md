# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this is

**m3l-groundwork** — a two-phase TypeScript + Claude Code project
bootstrapper. **Phase A** (`packages/cli`) is deterministic: an offline Node
CLI that writes a baseline Claude Code harness and TypeScript toolchain into
an empty directory, correct for any TypeScript project. **Phase B**
(`packages/plugin`) is adaptive: a `/customize` skill that interviews the
user, tailors the baseline, then runs a live guidance pass over official
TypeScript and Anthropic sources so the result reflects current upstream
recommendations rather than what was true when this repo last shipped.

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
  src/                   tokens.ts, emit.ts, git.ts, plugin.ts, main.ts
  bin/                    m3l-groundwork.mjs -- the published entry point
  tests/                  unit tests + bootstrap.e2e.test.ts

packages/plugin/        Phase B: the /customize skill
  skills/customize/       SKILL.md
  src/                    kind-facet-map.ts, domain-map.ts, index.ts
  tests/                  unit tests for both

templates/core/         THE BASELINE -- exactly what the CLI emits. Its own
                         toolchain, .claude/ harness, CI workflows, and
                         placeholder src/tests. See its own CLAUDE.md.

templates/packs/        Extension point for future opt-in packs. Currently
                         just a README documenting the intent -- no packs
                         are built yet (see "Known gaps" below).
```

## Commands

Run any task with `pnpm <script>`.

| Script                         | What it does                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                   | `tsc -b` both packages' `tsconfig.build.json`, emits `dist/`                                                                                                                                                                                              |
| `pnpm typecheck`               | `tsc -b --force` over both packages' tooling projects (src + tests)                                                                                                                                                                                       |
| `pnpm lint` / `lint:fix`       | ESLint over the whole repo (excludes `templates/**`)                                                                                                                                                                                                      |
| `pnpm format` / `format:check` | Prettier write / check (covers `templates/**` too -- it's still committed text)                                                                                                                                                                           |
| `pnpm test` / `test:coverage`  | Vitest unit tests, with or without the coverage gate                                                                                                                                                                                                      |
| `pnpm test:e2e`                | The real acceptance test: builds nothing itself, but bootstraps a throwaway project into a temp dir with the built CLI and runs _that project's own_ `pnpm verify`. Slow (~15-20s) and network-touching (a real `pnpm install`); not part of `pnpm test`. |
| `pnpm knip`                    | Unused-dependency / unused-export hygiene, both packages                                                                                                                                                                                                  |
| `pnpm check:exports`           | publint + attw against this repo's own root (a private package -- skips cleanly with a warning)                                                                                                                                                           |
| `pnpm check:node-version`      | `.node-version` is authoritative; forbids a hardcoded pin in CI                                                                                                                                                                                           |
| `pnpm verify`                  | Every gate above (via `bin/lib/verify-steps.mjs`), in the order `lefthook`'s `pre-push` runs them                                                                                                                                                         |
| `pnpm prepare`                 | Installs the lefthook git hooks                                                                                                                                                                                                                           |

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
  network call beyond the package install it runs at the end
  (`packages/cli/src/git.ts`'s `runInstall`). If a change to `packages/cli`
  needs a new dependency, stop and reconsider -- this is a hard constraint,
  not a style preference.
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
- **The emitted baseline has hard caps, verified by counting, not by
  convention:** ≤5 agents, ≤8 skills (7 in `templates/core/.claude/skills/`
  - `/customize` via the installed plugin = 8), ≤10 hooks, ≤3 CI workflows,
    ≤12 root `package.json` scripts, 0 gates that exist only to check
    documentation about the repo itself. Adding a new agent/skill/hook/
    workflow/script to `templates/core` means removing or merging an existing
    one first, or the baseline silently drifts over its budget with nothing
    to catch it (there is no `check:*` gate for this in the repo itself --
    count manually: `ls templates/core/.claude/agents | wc -l`, etc.).
- **`bin/lib/verify-steps.mjs` is the single source of truth `pnpm verify`
  and every future CI job would read from** -- the same pattern
  `templates/core/bin/lib/verify-steps.mjs` uses for the emitted baseline's
  own CI. Add a new gate here, not as a bespoke script invocation.

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

- `templates/packs/` is a README only -- no packs exist yet. The build's own
  `EXTRACTION-MANIFEST.md` (written to a scratchpad during the original
  build, not checked into this repo) names three candidates: a
  `harness-extras` pack (the compaction-handoff hook pair, `guard-readonly-
bash`, a `type-design-analyzer` agent, a `check-file-budget` gate), a
  `github-ops` pack (`reviewing-dependabot-prs`, `triaging-scan-alerts`),
  and a `publishing` pack (a release workflow, `check-publish-version`,
  `check-dts-deps`) -- each cut from the baseline purely to fit a cap, not
  because it failed the generalization test.
- No npm publishing, release automation, or version bumping.
- `.claude/` harness support (agents/hooks/skills for working _in this repo_
  specifically, as opposed to what it emits) does not exist yet. If this
  repo is ever edited from inside a Claude Code session that has its own
  PreToolUse write-time guards configured, a hook whose path-shape rule is
  scoped to something like `packages/*/src/**`/`**/tests/**` can false-
  positive here purely because this repo happens to share that directory
  shape (`packages/cli/src/`, `packages/plugin/tests/`) -- that is a
  property of whatever session is doing the editing, not of this repo.
