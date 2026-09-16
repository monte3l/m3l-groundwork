# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this is

****PROJECT_NAME**** — a TypeScript project bootstrapped by
[m3l-groundwork](https://github.com/monte3l/m3l-groundwork). This baseline
is deliberately generic: it holds for any TypeScript project regardless of
domain. Run `/customize` to tailor it to what you're actually building.

## Tech Stack

TypeScript, `strict: true`, ESM only (`"type": "module"`), compiled with
`tsc` — no bundler by default. Package manager: `pnpm`. Node 24+ only
(`.node-version` is the authority; `check:node-version` gates drift).

## Commands

Run any task with `pnpm <script>`.

| Script                         | What it does                                                    |
| ------------------------------ | --------------------------------------------------------------- |
| `pnpm build`                   | `tsc -b tsconfig.build.json` — emits `dist/`                    |
| `pnpm typecheck`               | `tsc -b --force` over the tooling project (src + tests)         |
| `pnpm lint`                    | ESLint over the whole repo                                      |
| `pnpm format` / `format:check` | Prettier write / check                                          |
| `pnpm test` / `test:coverage`  | Vitest, with or without the coverage gate                       |
| `pnpm knip`                    | Unused-dependency / unused-export hygiene                       |
| `pnpm check:exports`           | publint + are-the-types-wrong against a packed tarball          |
| `pnpm check:node-version`      | `.node-version` is authoritative; forbids a hardcoded pin in CI |
| `pnpm verify`                  | Every gate above, in the same order CI runs them                |
| `pnpm prepare`                 | Installs the lefthook git hooks                                 |

Run `pnpm verify` before considering any task done — it reproduces CI
locally.

## Git Workflow

**Conventional Commits (required)**, enforced by the `commit-msg` hook
(`bin/lint-commit.mjs`). Add a `Co-Authored-By:` trailer when Claude
authored or substantially assisted a commit — see `.claude/skills/writing-commits/`.

Branch off `main` as `feat/<slug>` / `fix/<slug>`, never work directly on
`main` — `guard-branch-isolation.mjs` blocks `src/**`/`tests/**` writes
while `HEAD` is `main`. Land any `src/`/`tests/` change via PR. Run
`.claude/skills/starting-work/` before beginning change-work if you haven't
already settled the branch and PR decision.

Never `git push --force` a shared branch.

## Architecture & Decisions

`src/index.ts` is the current public entry point (see the `exports` map in
`package.json`). Everything under `src/internal/`, if you create it, is
private and must never be re-exported.

## Agent Operating Model

**Hub-and-spoke**: the hub plans and dispatches to spokes, and never writes
`src/`/test code itself — enforced by `.claude/hooks/guard-hub-src-writes.mjs`
and `disallowedTools: Agent` on every spoke. For a piece of work with a clear
contract:

1. `test-author` writes failing tests from the contract (RED phase), and
   confirms they fail for the right reason.
2. `code-implementer` makes them pass with the minimal correct
   implementation, then refactors while green (GREEN phase).
3. Read-only review spokes (`code-reviewer` always; `silent-failure-hunter`
   when the diff has error-handling paths) run in parallel over the diff.
   Must-fix findings route back to `code-implementer`, and the loop repeats
   until clean.

Full dispatch-sizing and recovery guidance: `.claude/rules/agent-dispatch.md`
(auto-loads when editing `.claude/skills/**` or `.claude/agents/**`).

## Coding, errors & tests

Path-scoped rules auto-load on matching files:

- `src/**` → `.claude/rules/src.md`
- `**/tests/**`, `**/*.test.ts` → `.claude/rules/tests.md`
- `src/**`, `**/tests/**` → `.claude/rules/refactoring.md` (behavior-preserving changes)
- `.claude/skills/**`, `.claude/agents/**` → `.claude/rules/agent-dispatch.md`

## Security

Never log secrets, tokens, or caller data. Validate external input at the
public API boundary. `.claude/hooks/guard-secret-writes.mjs` blocks writing
a real secret to disk at edit time; keep it that way rather than relying on
CI to catch it after the fact.

## Definition of Done

`pnpm verify` passes; a public API change carries a Conventional Commit with
the correct semver impact; new/changed exports have TSDoc and tests.

## Forbidden Patterns

**Enforced at write time by hooks:** `any` implied by CommonJS constructs
(`require`, `module.exports`, `__dirname`, `__filename`), a missing `.js`
extension on a relative import, a hand-edit to `dist/` or `coverage/`, a
write to `src/`/`tests/` while on `main`, a real secret written to disk.

**No automated guard — need conscious care:** no `any` in the public API;
never swallow an error silently; no top-level side effects; never
`git push --force`.

## Freshness

This baseline is frozen at the moment `m3l-groundwork` last emitted it. Run
`/customize`'s guidance pass — or `.claude/skills/typescript-guidance/` /
`.claude/skills/harness-guidance/` directly in refresh mode — periodically
to sweep the toolchain and harness against current upstream guidance. See
`docs/research/typescript-refresh.md` and `docs/research/harness-refresh.md`
for the living trackers.
