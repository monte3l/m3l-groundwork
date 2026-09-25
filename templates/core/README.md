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

`pnpm verify` runs the same checks CI runs — format, lint, typecheck, build,
and test with coverage — in one command, so you can catch a failure locally
before pushing. See `CLAUDE.md` for the full command reference and this
project's conventions.

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
