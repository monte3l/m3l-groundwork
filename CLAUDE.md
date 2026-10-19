# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.
It is an index: detail lives in path-scoped `.claude/rules/` files, which load
when you edit the files they govern, and in `docs/`.

## What this is

**m3l-groundwork** — a two-phase TypeScript + Claude Code project
bootstrapper. **Phase A** (`packages/cli`) is deterministic: an offline Node
CLI with two modes, auto-detected from the target directory (`mode.ts`).
**Fresh mode** writes a baseline Claude Code harness and TypeScript toolchain
into an empty directory. **Adopt mode** surveys an established project
read-only, diffs the baseline against it, and writes only under
`.groundwork/` plus one guarded copy of the `/customize` skill -- it never
overwrites a project file. **Phase B** (`packages/plugin`) is the `/customize`
skill: it interviews the owner (fresh) or reconciles the CLI's survey against
the real repo (adopt), then runs a live guidance pass over official
TypeScript and Anthropic sources.

`templates/packs/` adds optional bundles on top of the baseline (wiring
contract: `templates/packs/README.md`; a pack never edits YAML or JavaScript).
Do not confuse this repo's own toolchain with **the baseline it emits**
(`templates/core/`): they share a design but are separate, independently
verified artifacts. A change to the root `eslint.config.js` affects only this
repo; a change to `templates/core/eslint.config.js` affects every project
bootstrapped afterwards.

## Tech Stack

TypeScript, `strict: true`, ESM only, `tsc` (no bundler), `pnpm`. Node 24+
(`.node-version` is the authority; `check:node-version` gates drift). Two
workspace packages (`packages/cli`, `packages/plugin`), each with a tooling
`tsconfig.json` (src + tests, no emit) and a build-only `tsconfig.build.json`
(src only, emits `dist/`).

## Repository Layout

`packages/cli` (Phase A), `packages/plugin` (Phase B), `templates/core` (the
baseline), `templates/packs` (optional bundles), `.claude/` (this repo's own
harness), `.github/` (this repo's own CI), `bin/` (gate scripts),
`tools/` (pinned CI tooling), `evals/`, `design/` (vendored m3l-design) and
`docs/`. The annotated tree is in `docs/repository-layout.md`.

## Commands

Run any task with `pnpm <script>`.

| Script                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                          | `tsc -b` both packages' `tsconfig.build.json`, emits `dist/`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm typecheck`                      | `tsc -b --force` over both packages' tooling projects (src + tests)                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm lint` / `lint:fix`              | ESLint over the whole repo (excludes `templates/**`), `--max-warnings 0` -- a warning fails the gate the same as an error                                                                                                                                                                                                                                                                                                                                     |
| `pnpm format` / `format:check`        | Prettier write / check (covers `templates/**` too -- it's still committed text)                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm test` / `test:coverage`         | Vitest unit tests, with or without the coverage gate                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm test:e2e`                       | Every `*.e2e.test.ts` (`vitest.e2e.config.ts`) -- slow and network-touching (real `pnpm install`s, a packed tarball), run **serially** (`fileParallelism: false`, because `pack.e2e.test.ts` rebuilds `dist/` mid-run). None are part of `pnpm test`; see "Testing" below.                                                                                                                                                                                    |
| `pnpm knip`                           | Unused-dependency / unused-export hygiene, both packages; a `verify` step in the `lint` group                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm check:exports`                  | publint against `packages/cli`'s packed tarball (attw is skipped: the CLI exposes no importable export beyond `./package.json`) -- the one published package                                                                                                                                                                                                                                                                                                  |
| `pnpm check:plugin-version`           | `plugin.json`'s version matches the CLI's, `packages/plugin/package.json` stays private, and `marketplace.json`'s entry names it correctly and carries no npm source or version pin of its own                                                                                                                                                                                                                                                                |
| `pnpm check:plugin-manifest`          | Runs Anthropic's `claude plugin validate --strict` against the marketplace manifest and `packages/plugin`; skips cleanly with a warning when the `claude` CLI isn't installed                                                                                                                                                                                                                                                                                 |
| `pnpm changeset` / `version:packages` | Add a changeset; version the packages (what the release workflow runs -- see "Releases")                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm check:node-version`             | `.node-version` is authoritative; forbids a hardcoded pin in CI                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm check:harness`                  | Grades `templates/core`'s Claude Code harness (`.claude/` + `CLAUDE.md`) with the emitted gate's own rule module: structural defects fail, rubric findings warn                                                                                                                                                                                                                                                                                               |
| `pnpm check:toolchain`                | Grades `templates/core`'s TypeScript toolchain (tsconfig chain, ESLint and vitest config, verify-step wiring, toolchain pins) with the emitted gate's own rule module: structural defects fail, rubric findings warn                                                                                                                                                                                                                                          |
| `pnpm check:license-headers`          | Every tracked file outside `templates/**` carries an SPDX header or is exempted by `REUSE.toml`; `-- --fix` inserts a missing header (see "Definition of Done")                                                                                                                                                                                                                                                                                               |
| `pnpm eval`                           | **Paid, never in `verify`.** Runs Anthropic's `claude plugin eval` on `/customize`, on a generated wrapper over `templates/core`'s skills (triggering accuracy), on that same wrapper widened with every `templates/packs/*/files/.claude/skills` merged in (cross-pack triggering), and on `typescript-guidance` against a deliberately degraded project; needs `claude`, credentials, network. Skips cleanly without `claude`. See `.claude/rules/evals.md` |
| `pnpm verify`                         | Every gate above (via `bin/lib/verify-steps.mjs`). `node bin/verify.mjs --group <name>` runs one of the five groups -- exactly what `lefthook`'s `pre-push` and each `ci.yml` lane invoke; `--step <id>` is for local debugging only and must never appear in either YAML file                                                                                                                                                                                |

Run `pnpm verify` (or just push -- `lefthook`'s `pre-push` runs the same
steps) before considering any task here done.

## Architecture notes

The design record is split by area, and each file loads when you edit the
files it governs. CLI internals (token substitution, `resolveAsset()`, dotfile
escaping, zero runtime dependencies, packs only extending JSON):
`.claude/rules/package-cli.md`. Adopt mode (the survey is an index, staging,
the inventory): `.claude/rules/adopt-mode.md`. The two grader
implementations that must not drift: `.claude/rules/harness-graders.md`.
`/customize`, `domain-map.ts`, `pack-map.ts`: `.claude/rules/package-plugin.md`.
The baseline's caps (≤5 agents, ≤8 skills, ≤10 hooks, ≤3 workflows, ≤12
scripts): `.claude/rules/baseline-core.md`. The single gate list in
`verify-steps.mjs`, CI lanes and why there is no automated PR review:
`.claude/rules/ci.md`. Also `.claude/rules/releases.md`,
`.claude/rules/design-system.md`, `.claude/rules/docs-site.md`,
`.claude/rules/environments.md` and the paid behavioural evals in
`.claude/rules/evals.md`.

## Git Workflow

Single-maintainer project on GitHub (`monte3l/m3l-groundwork`, public).
Conventional Commits, enforced by the `commit-msg` hook
(`bin/lint-commit.mjs`); every commit needs a DCO `Signed-off-by:` trailer
(`git commit -s`) and a GPG signature, and a `Co-Authored-By:` trailer when
Claude authored or substantially assisted it. Nobody can push to `main`: every
change lands through a pull request whose `verify`, `Dependency Review`,
`CodeQL` and `Gitleaks` checks are green, with one approval from a code owner
other than its author, resolved review threads and signed commits. Pull
request creation is collaborators-only; rebase-merge is not allowed; a branch
must be up to date before merging. Signing is machine-local: fix a missing
`user.signingkey`, never `commit.gpgsign=false`. Branch first
(`feat/<slug>` or `fix/<slug>`); `guard-branch-isolation.mjs` blocks
`packages/*/src/` and `packages/*/tests/` writes on `main`. The full policy and
reasoning is in `.claude/rules/git-workflow.md`.

## Agent Operating Model

This repo runs on `templates/core`'s own harness -- installed onto its own
root by adopting itself (`docs/known-gaps.md` says how), same shape as every
project it bootstraps, with one adaptation: `packages/*/src/**` and
`packages/*/tests/**` in every path-shape rule, not a flat `src/`/`tests/`.

**Hub-and-spoke is mandatory and hook-enforced, deliberately, with no
project-level opt-out.** The hub plans and dispatches to spokes, and never
writes `packages/*/src/` or `packages/*/tests/` itself -- enforced
unconditionally by `.claude/hooks/guard-hub-src-writes.mjs` (blocks any
Write/Edit whose PreToolUse payload does not carry both a writer-spoke
`agent_type` and an `agent_id`, i.e. every direct top-level edit, including
one from a session started with `--agent`) and `guard-branch-isolation.mjs` (the same block
specifically on `main`), plus `disallowedTools: Agent` on every spoke. For a piece of work with a clear contract:

1. `test-author` writes failing tests from the contract (RED phase), and
   confirms they fail for the right reason.
2. `code-implementer` makes them pass with the minimal correct
   implementation, then refactors while green (GREEN phase).
3. Read-only review spokes (`code-reviewer` always; `silent-failure-hunter`
   when the diff has error-handling paths; `baseline-impact-reviewer` when
   the diff touches `templates/core/` or `templates/packs/`) run in parallel
   over the diff. Must-fix findings route back to `code-implementer`, and the
   loop repeats until clean.

The guard also screens `Bash`, but only conservatively; a managed deployment,
an installed mod, a fork subagent or an agent-teams teammate can get around
it. `onFailure: "block"` (Claude Code 2.1.295 or later) makes the four
invariant guards fail closed, `permissions.deny` blocks reading `.env*` and
`secrets/**`, and a spoke's `permissionMode` is overridden by an auto,
`acceptEdits` or `bypassPermissions` session, so the hooks, not that field,
bound a spoke. Detail, sources and the root harness inventory:
`.claude/rules/hub-and-spoke.md`; dispatch sizing and recovery:
`.claude/rules/agent-dispatch.md`.

Path-scoped rules load on matching files: `.claude/rules/src.md` on
`packages/*/src/**`, `.claude/rules/tests.md` on tests,
`.claude/rules/refactoring.md` on both, `.claude/rules/docs.md` on this
repo's own markdown (`templates/**` excluded: it ships brand-neutral), and one
per shipped artifact or surface: `.claude/rules/package-cli.md`,
`.claude/rules/package-plugin.md`, `.claude/rules/baseline-core.md`,
`.claude/rules/pack-claude-github.md`, `.claude/rules/pack-github.md`,
`.claude/rules/pack-harness-extras.md`, `.claude/rules/pack-publishing.md`, `.claude/rules/pack-quality.md`,
`.claude/rules/pack-supply-chain.md` and `.claude/rules/pack-worktrees.md`. A
pack cannot ship a rule of its own (`templates/packs/README.md`), which is why
these live here. Each names its trigger paths in its frontmatter.

**Forbidden patterns, hook-enforced:** `any` implied by CommonJS constructs,
a missing `.js` extension on a relative import, a hand-edit to `dist/` or
`coverage/` (`guard-protected-paths.mjs`), a `packages/*/src/`/`tests/`
write while on `main`, a secret written to disk (dotenv files, PEM private keys, a fixed list of token shapes and key names;
`guard-secret-writes.mjs`), an unsigned `git push` when `commit.gpgsign`
is on (`guard-git-push-signed.mjs`), and stacking `run_in_background: true`
with a shell-level detach construct in the same Bash call
(`guard-double-background.mjs`). **Not hook-enforced:** lint
(`no-explicit-any`) catches an explicit `any`; no `any` in a public API, never
swallow an error silently, no top-level side effects and never
`git push --force` are conscious-care rules (the ruleset only blocks a force-push to `main`).

## Releases

Only `@monte3l/groundwork` (the CLI, `packages/cli`) ships to npm;
`@monte3l/groundwork-plugin` is `private` and distributes only through the
Claude Code marketplace. A PR with a user-visible CLI change should add a
changeset (`pnpm changeset`); a plugin-only change needs none. A push to `main`
runs `release.yml`. **Renaming or moving `release.yml` breaks npm's trusted
publisher**, and a publish is staged: `npm stage approve` is a separate step
that needs a live 2FA code. Detail: `.claude/rules/releases.md`, with the supply-chain signals in `.claude/rules/release-supply-chain.md` and the GA record, one-time setup and superseding versions in `.claude/rules/release-history.md`.

## Testing

Vitest with a per-file v8 coverage gate (90% statements/lines, 80%
branches/functions), property tests (`*.property.test.ts`, `fast-check`) in
`pnpm test`, and `*.e2e.test.ts` files that bootstrap real projects and pack
tarballs, run only through `pnpm test:e2e`. Run `pnpm test:e2e` after any change
to `packages/cli/src/`, `templates/core/` or `packages/plugin/skills/customize/`.
Detail: `.claude/rules/tests.md`.

## Definition of Done

`pnpm verify` passes; `pnpm test:e2e` passes too if the change touched
`packages/cli/src/`, `templates/core/` or the `/customize` skill (CI runs it on
every PR except documentation-only ones, but no local pre-push hook does, so
run it before pushing). Anything that changes what the CLI's tarball ships or
how it finds its data is proved by `pack.e2e.test.ts`, not by running the CLI
from the checkout. The baseline's caps still hold if a `.claude/` file was
added to or removed from `templates/core`. If you touched this repo's _own_
`.claude/` (agents, hooks, skills, rules, root `settings.json`), grade it with
`/grade-own-harness`: structural failures gate, rubric findings only warn. The full wording is in `.claude/rules/definition-of-done.md`.

**A new tracked file outside `templates/**` needs an SPDX header** (a
`SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors` and
`SPDX-License-Identifier: MIT` line comment) if its extension is `.ts`, `.mjs`,
`.js`, `.sh`, `.yml` or `.yaml`, or a glob in `REUSE.toml` otherwise.
`node bin/check-license-headers.mjs --fix` inserts the header; a file under
neither fails the `license-headers` step. Add a glob to `REUSE.toml` in the same
commit rather than widening `HEADER_EXTENSIONS`.

## Known gaps (deliberately out of scope so far)

Deliberate omissions (the seven packs and what each covers, no standalone
"add a pack" flag, `pnpm/setup` deferred, how this repo's own harness arrived,
adopt-mode inventory and cap-count caveats, and the GitHub settings that live
outside the repo) are recorded in `docs/known-gaps.md`.
