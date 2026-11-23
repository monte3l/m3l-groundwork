# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.
It is an index: detail lives in path-scoped `.claude/rules/` files, which load
when you edit the files they govern, and in `docs/`.

## What this is

**m3l-groundwork** — a two-phase TypeScript + Claude Code project
bootstrapper. **Phase A** (`packages/cli`) is an offline, deterministic Node
CLI with two modes, auto-detected from the target directory (`mode.ts`).
**Fresh mode** writes a baseline Claude Code harness and TypeScript toolchain
into an empty directory. **Adopt mode** surveys an established project
read-only, diffs the baseline against it, and writes only under
`.groundwork/` plus one guarded copy of the `/customize` skill -- it never
overwrites a project file. **Phase B** (`packages/plugin`) is the `/customize`
skill: it interviews the owner (fresh) or reconciles the CLI's survey against
the real repo (adopt), then runs a live guidance pass over official sources.

`templates/packs/` adds optional bundles on top of the baseline (wiring
contract: `templates/packs/README.md`; a pack never edits YAML or JavaScript).
Do not confuse this repo's own toolchain with **the baseline it emits**
(`templates/core/`): separate, independently verified artifacts. A change to the
root `eslint.config.js` affects only this repo; one to
`templates/core/eslint.config.js` affects every project bootstrapped afterwards.

## Tech Stack

TypeScript, `strict: true`, ESM only, `tsc` (no bundler), `pnpm`. Node 24+
(`.node-version` is the authority; `check:node-version` gates drift). Two
workspace packages (`packages/cli`, `packages/plugin`), each with a tooling
`tsconfig.json` (src + tests, no emit) and a build-only `tsconfig.build.json`
(src only, emits `dist/`, CLI declarations only).

## Repository Layout

`packages/cli` (Phase A), `packages/plugin` (Phase B), `templates/core` (the
baseline), `templates/packs` (optional bundles), `.claude/` and `.github/`
(this repo's own harness and CI), `bin/` (gate scripts), `tools/` (pinned CI
tooling), `evals/`, `design/` (vendored m3l-design) and `docs/`. The annotated
tree is in `docs/repository-layout.md`.

## Commands

Run any task with `pnpm <script>`.

| Script                                       | What it does                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                 | `tsc -b` both packages' `tsconfig.build.json`, emits `dist/`                                                                                                                            |
| `pnpm typecheck`                             | `tsc -b --force` over both packages' tooling projects (src + tests)                                                                                                                     |
| `pnpm lint` / `lint:fix`                     | ESLint over the whole repo (excludes `templates/**`), `--max-warnings 0`: a warning fails like an error                                                                                 |
| `pnpm format` / `format:check`               | Prettier write / check (covers `templates/**` too)                                                                                                                                      |
| `pnpm test` / `test:coverage` / `test:watch` | Vitest unit tests, with or without the coverage gate, or in watch mode                                                                                                                  |
| `pnpm test:e2e`                              | Every `*.e2e.test.ts`: slow, network-touching, run **serially** (`pack.e2e.test.ts` rebuilds `dist/` mid-run). Not part of `pnpm test`; see Definition of Done                          |
| `pnpm knip`                                  | Unused-dependency / unused-export hygiene, both packages                                                                                                                                |
| `pnpm check:exports`                         | publint against `packages/cli`'s packed tarball (attw skipped: the CLI exposes no importable export beyond `./package.json`)                                                            |
| `pnpm check:plugin-version`                  | `plugin.json`'s version matches the CLI's, and `packages/plugin/package.json` stays private                                                                                             |
| `pnpm check:plugin-manifest`                 | `claude plugin validate --strict` against `packages/plugin`; skips with a warning when `claude` isn't installed                                                                         |
| `pnpm check:node-version`                    | `.node-version` is authoritative; forbids a hardcoded pin in CI                                                                                                                         |
| `pnpm check:harness`                         | Grades `templates/core`'s `.claude/` + `CLAUDE.md` with the emitted gate's own rule module: structural defects fail, rubric findings warn                                               |
| `pnpm check:toolchain`                       | Grades `templates/core`'s TypeScript toolchain the same way (tsconfig chain, ESLint/vitest config, verify-step wiring, pins)                                                            |
| `pnpm check:license-headers`                 | Every tracked file outside `templates/**` has an SPDX header or a `REUSE.toml` glob; `-- --fix` inserts a missing header                                                                |
| `pnpm eval`                                  | **Paid, never in `verify`.** `claude plugin eval` suites; needs `claude`, credentials and network, skips cleanly without `claude`. Suites: `.claude/rules/evals.md`                     |
| `pnpm verify`                                | Every gate above (`bin/lib/verify-steps.mjs`). `node bin/verify.mjs --group <format\|lint\|typecheck\|build\|test>` is what `lefthook` and each `ci.yml` lane run; never `--step` there |

## Git Workflow

Single-maintainer project on GitHub (`monte3l/m3l-groundwork`, public).
Conventional Commits, enforced by the `commit-msg` hook (`bin/lint-commit.mjs`);
every commit needs a DCO `Signed-off-by:` trailer (`git commit -s`), a GPG
signature, and a `Co-Authored-By:` trailer when Claude authored or substantially
assisted it. Nobody can push to `main`: every change
lands through a pull request with green `verify`, `Dependency Review`,
`CodeQL` and `Gitleaks` checks, one approval from a code owner other than its
author, resolved threads and signed commits (no rebase-merge; the branch must
be up to date). Signing is machine-local: fix a missing `user.signingkey`,
never `commit.gpgsign=false`. Branch first (`feat/<slug>` or `fix/<slug>`);
`guard-branch-isolation.mjs` blocks `packages/*/src/` and `packages/*/tests/`
writes on `main`, and `guard-shared-checkout.mjs` blocks any edit, `git commit`
or new branch in the main checkout itself, so work happens in a worktree off
`origin/main`. Full policy: `.claude/rules/git-workflow.md`.

## Agent Operating Model

This repo runs on `templates/core`'s own harness, installed by adopting itself
(`docs/known-gaps.md`), with `packages/*/{src,tests}/**` in every path-shape rule.

**Hub-and-spoke is mandatory and hook-enforced, deliberately, with no
project-level opt-out.** The hub plans and dispatches to spokes, and never
writes `packages/*/src/` or `packages/*/tests/` itself -- enforced
unconditionally by `.claude/hooks/guard-hub-src-writes.mjs` (blocks any
Write/Edit whose PreToolUse payload lacks a writer-spoke `agent_type` and an
`agent_id`, so every direct top-level edit, even from a `--agent` session) and
`guard-branch-isolation.mjs` (the same block on `main`), plus
`disallowedTools: Agent` on every spoke. For work with a clear contract:

1. `test-author` writes failing tests from the contract (RED phase), and
   confirms they fail for the right reason.
2. `code-implementer` makes them pass with the minimal correct
   implementation, then refactors while green (GREEN phase).
3. Read-only review spokes (`code-reviewer` always; `silent-failure-hunter`
   when the diff has error-handling paths; `baseline-impact-reviewer` when
   the diff touches `templates/core/` or `templates/packs/`) run in parallel
   over the diff. Must-fix findings route back to `code-implementer`, and the
   loop repeats until clean.

The guard also screens `Bash`, only conservatively: a managed deployment, an
installed mod, a fork subagent or an agent-teams teammate can get around it.
`onFailure: "block"` (Claude Code 2.1.295 or later) makes the four invariant
guards fail closed. `permissions.deny` blocks secret reads and lockfile and
`.git/` edits. The hooks bound a spoke, not its `permissionMode`, which an
auto, `acceptEdits` or `bypassPermissions` session overrides. Detail, the deny
list and the root harness inventory: `.claude/rules/hub-and-spoke.md`;
dispatch sizing and recovery: `.claude/rules/agent-dispatch.md`.

**Forbidden patterns, hook-enforced:** `any` implied by CommonJS constructs,
a missing `.js` extension on a relative import, a hand-edit to `dist/` or
`coverage/`, a `packages/*/src/`/`tests/` write while on `main`, a secret
written to disk (`guard-secret-writes.mjs`), an unsigned `git push` when
`commit.gpgsign` is on, and `run_in_background: true` stacked with a
shell-level detach construct in one Bash call. **Not hook-enforced:** no `any`
in a public API (lint catches only an explicit one), never swallow an error
silently, no top-level side effects, never `git push --force` (the ruleset only
blocks it on `main`).

## Architecture notes

The design record is split into path-scoped rules that load on matching files,
so read the one for the area you edit. A pack
cannot ship a rule of its own (`templates/packs/README.md`), so the pack rules
live here; each names its trigger paths in its frontmatter.

| Area                                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source, tests, refactors                     | `.claude/rules/src.md`, `.claude/rules/tests.md`, `.claude/rules/refactoring.md`                                                                                                                                                                                                                                                                                                                      |
| Markdown (`templates/**` excluded)           | `.claude/rules/docs.md`                                                                                                                                                                                                                                                                                                                                                                               |
| CLI internals, adopt mode, graders           | `.claude/rules/package-cli.md`, `.claude/rules/adopt-mode.md`, `.claude/rules/harness-graders.md` (two implementations that must not drift)                                                                                                                                                                                                                                                           |
| `/customize`, `domain-map.ts`, `pack-map.ts` | `.claude/rules/package-plugin.md`                                                                                                                                                                                                                                                                                                                                                                     |
| The baseline and its caps                    | `.claude/rules/baseline-core.md` (≤5 agents, ≤8 skills, ≤10 hooks, ≤3 workflows, ≤12 scripts)                                                                                                                                                                                                                                                                                                         |
| This repo's harness                          | `.claude/rules/hub-and-spoke.md`, `.claude/rules/agent-dispatch.md`                                                                                                                                                                                                                                                                                                                                   |
| Git, CI, definition of done                  | `.claude/rules/git-workflow.md`, `.claude/rules/ci.md`, `.claude/rules/definition-of-done.md`, `.claude/rules/environments.md`                                                                                                                                                                                                                                                                        |
| Releases                                     | `.claude/rules/releases.md`, `.claude/rules/release-supply-chain.md`, `.claude/rules/release-history.md`                                                                                                                                                                                                                                                                                              |
| Design system, docs site, evals              | `.claude/rules/design-system.md`, `.claude/rules/docs-site.md`, `.claude/rules/evals.md`                                                                                                                                                                                                                                                                                                              |
| Packs                                        | `.claude/rules/pack-claude-github.md`, `.claude/rules/pack-frontend.md`, `.claude/rules/pack-github.md`, `.claude/rules/pack-harness-extras.md`, `.claude/rules/pack-licensing.md`, `.claude/rules/pack-publishing.md`, `.claude/rules/pack-quality.md`, `.claude/rules/pack-service.md`, `.claude/rules/pack-statusline.md`, `.claude/rules/pack-supply-chain.md`, `.claude/rules/pack-worktrees.md` |

## Releases

Only `@monte3l/groundwork` (`packages/cli`) ships to npm;
`@monte3l/groundwork-plugin` is `private` and distributes only through the
`monte3l/m3l-plugins` marketplace. There is no changeset: release-please reads
the Conventional Commits, so the commit type is the release (`feat` minor, `fix`
patch, `!` major; `docs`, `chore`, `ci`, `test` and `refactor` release
nothing). **Renaming or moving `release.yml` breaks npm's trusted publisher**,
and a publish is staged: `npm stage approve` is a separate step that needs a
live 2FA code. Detail: `.claude/rules/releases.md`.

## Testing

Vitest with a per-file v8 coverage gate (90% statements/lines, 80%
branches/functions), and property tests (`*.property.test.ts`, `fast-check`) in
`pnpm test`. Detail: `.claude/rules/tests.md`.

## Definition of Done

`pnpm verify` passes. `pnpm test:e2e` passes too if the change touched
`packages/cli/src/`, `templates/core/` or the `/customize` skill: CI runs it on
every PR except documentation-only ones, but no local pre-push hook does, so
run it before pushing. Anything that changes what the CLI's tarball ships or
how it finds its data is proved by `pack.e2e.test.ts`, not by running the CLI
from the checkout. The baseline's caps still hold if a `.claude/` file was
added to or removed from `templates/core`. If you touched this repo's own
`.claude/`, grade it with `/grade-own-harness`: structural failures gate,
rubric findings only warn.

**A new tracked file outside `templates/**` needs an SPDX header** (`.ts`,
`.mjs`, `.js`, `.sh`, `.yml`, `.yaml`) or a `REUSE.toml` glob (anything else);
`node bin/check-license-headers.mjs --fix` inserts the header.

## Known gaps (deliberately out of scope so far)

The eleven packs, `pnpm/setup` deferred, adopt-mode caveats and the GitHub
settings that live outside the repo: `docs/known-gaps.md`.
