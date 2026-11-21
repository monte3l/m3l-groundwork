# __PROJECT_NAME__

Bootstrapped by [m3l-groundwork](https://github.com/monte3l/m3l-groundwork) —
a deterministic TypeScript + Claude Code project bootstrapper.

## What you just got

A TypeScript project wired up with a strict compiler configuration, ESLint,
Prettier, Vitest (with a coverage gate), and a Claude Code harness under
`.claude/` — agents, skills, hooks, and rules that shape how Claude Code
works in this repository. All of it is deliberately generic: a correct,
working starting point for any TypeScript project, not yet specific to what
__PROJECT_NAME__ actually does.

## Getting started

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs the same checks CI runs, in one command, so you can catch
a failure locally before pushing. In order: format check, lint, the Claude
Code harness grader, the TypeScript toolchain grader, knip (unused code and
dependencies), typecheck, build, tests with coverage, a package-exports check,
and a Node version pin check. See `CLAUDE.md` for the full command reference and this
project's conventions.

## Notable files

- `.github/dependabot.yml` — weekly Dependabot updates for the GitHub Actions
  pinned in `.github/workflows/` (npm updates are left off by default).
- `pnpm-workspace.yaml` — pnpm's install-script approval list (`allowBuilds`),
  which pnpm 10+ reads from here rather than from `package.json`.
- `bin/strip-claude-trailers.mjs` — run by the `commit-msg` hook in
  `lefthook.yml` before commit linting; strips harness-injected `Claude-*`
  trailers and leaves `Co-Authored-By:` alone.

## Tailor it to your project

This baseline is frozen at the moment it was generated, and deliberately
generic until you adapt it. To tailor it to __PROJECT_NAME__:

1. Open this repository in [Claude Code](https://claude.com/claude-code).
2. Run the `/customize` slash command.
3. Answer a short interview (project kind, runtime target, test strictness,
   CI depth). Claude Code then tailors the baseline to your answers and
   runs a live guidance pass against current official TypeScript and
   Anthropic documentation, so the result reflects up-to-date recommended
   practice rather than what was true when this baseline was generated.

## Glossary

Run into an unfamiliar term in `CLAUDE.md`, this README, or the `.claude/`
harness? See the upstream
[glossary](https://github.com/monte3l/m3l-groundwork/blob/main/docs/glossary.md).
