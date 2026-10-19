---
paths:
  - "REUSE.toml"
  - "bin/check-license-headers.mjs"
---

# Definition of Done (full wording) and the SPDX header rule

> Moved verbatim from the root `CLAUDE.md` ("Definition of Done"). The root
> file keeps a summary; this loads when you edit the license-header gate.

`pnpm verify` passes here; `pnpm test:e2e` passes if the change touched
`packages/cli/src/`, `templates/core/`, or the `/customize` skill (CI runs it on
every PR except documentation-only ones, where its steps are skipped, and
`verify` gates on it, but no local pre-push hook does, so run it before
pushing); the
baseline's caps (above) still hold if a `.claude/` file was added or
removed from `templates/core`. Anything that changes what the CLI's tarball
ships or how it locates its data is proved by `pack.e2e.test.ts`, not by
running the CLI from the checkout, where every path resolves regardless. If
you touched this repo's _own_ `.claude/` (agents, hooks, skills, rules,
`settings.json` at root, not `templates/core/`), grade it the same way the
baseline's `bin/check-harness.mjs` grades `templates/core` -- there is no
`package.json` script for this (the root `check:harness` grades `templates/core`, and the emitted baseline has no harness script at all), so use
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
set for one file (`HEADER_EXTENSIONS` in `bin/check-license-headers.mjs` is
hard-coded and no test pins it).
