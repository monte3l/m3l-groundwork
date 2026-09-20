# __PROJECT_NAME__

Bootstrapped by [m3l-groundwork](https://github.com/monte3l/m3l-groundwork) —
a deterministic TypeScript + Claude Code project bootstrapper.

## Getting started

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs the same checks CI runs: format, lint, typecheck, build,
and test with coverage. See `CLAUDE.md` for the full command reference and
the project's conventions.

## Customize this baseline

This project shipped with a frozen, universal TypeScript + Claude Code
baseline. Run `/customize` inside Claude Code to tailor it: answer a short
interview (project kind, runtime target, test strictness, CI depth), then
let the guidance pass validate the result against current official
TypeScript and Anthropic guidance rather than what was true when the
baseline was built.
