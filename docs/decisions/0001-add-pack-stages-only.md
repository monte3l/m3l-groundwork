# Add-pack stages only; the ledger lives in .groundwork/

- **Status:** accepted
- **Date:** 2026-11-25

## Context

A project bootstrapped or adopted without a pack had no supported way to add
one later: fresh mode refuses a non-empty directory, and adopt mode stages every
pack but rewrites its own `.groundwork/` state on each run. Installing a pack
into an established project means merging its wiring into files the project
owns, which needs the judgement and confirmation only `/customize` provides.

## Options

- **The CLI installs the pack.** Fast, but the CLI would write project files in
  a project it did not just create, against adopt mode's rule that the CLI never
  overwrites a project file.
- **The CLI stages, `/customize add-pack` installs.** `--add-pack <name>`
  writes only `.groundwork/add-pack/<name>/` (inert `.staged` copies plus a
  `plan.json` survey); `/customize` reads the plan, confirms each change and
  records the result in `.groundwork/installed-packs.json`.

## Decision

Stage only. It keeps one rule for every CLI mode that touches an existing
project (never write a project file), reuses adopt mode's staging convention and
atomic swap, and leaves the decisions to the step that can ask the owner. The
installed-packs ledger also lives under `.groundwork/`, written by `/customize`,
so the CLI never needs a project file to know what is installed.

## Consequences

Adding a pack takes two steps, the CLI run and `/customize add-pack`. A project
with an outdated `/customize` copy must update it first, which the CLI's
closing `next:` line says. Revisit if packs gain an install that needs no
judgement at all, such as files-only packs with no wiring.

There is one known interim hazard. On a bootstrapped project, `--add-pack`
creates `.groundwork/`, and the current `/customize` Step 0.1 reads a
`.groundwork/` with no `inventory.json` as an interrupted adopt run. The Step
0.1 exemption for a `.groundwork/` that holds only `add-pack/` and
`installed-packs.json` ships in the same release, so this change must not be
released without it.
