---
paths:
  - "templates/packs/frontend/**"
---

# Pack rules: `frontend` (`templates/packs/frontend/**`)

> This file is the terse checklist that auto-loads when you edit the
> `frontend` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The `ui-reviewer` review agent and the `new-component`
skill. Modes: fresh and adopt. Budget: 1 agent, 1 skill. No hooks, settings,
scripts or gate. Recommended only for the `frontend` project kind
(`recommendFrontend` in `packages/plugin/src/pack-map.ts`).

- **The agent is a read-only review spoke with no shell.** Its tools are
  `Read`, `Grep` and `Glob` and nothing else, so the hub must name the files
  to review in the dispatch prompt. Keep it that way: no write tool, no
  `Bash`.
- **Its checklist is WCAG 2.2 criteria that were read from w3.org, not
  recalled.** The criterion numbers, levels and thresholds are pinned by
  `packages/cli/tests/templates/pack-frontend.test.ts`. 2.3.3 is level AAA, so
  it is never a Must-fix. Do not add a criterion without reading it on w3.org,
  and do not cite the removed parsing criterion.
- **It is a static source review.** Contrast from a theme token, focus order,
  layout and screen-reader output are `NOT CHECKED`, never a pass. Never let
  it claim a page conforms.
- **`new-component` ships no framework templates.** It mirrors a sibling
  component and routes the writing through `test-author` and
  `code-implementer`. Do not add a framework-specific template, and do not let
  the skill add a dependency.
- **`recommended` is `true` for `frontend` only,** so `step-3-round-1.md`'s
  list of kind-scoped packs names it beside `publishing` and `licensing`.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                     | Where                                                |
| ------------------------- | ---------------------------------------------------- |
| Installs and verifies     | `packages/cli/tests/packs-frontend.e2e.test.ts`      |
| Manifest, agent and skill | `packages/cli/tests/templates/pack-frontend.test.ts` |
| Budget                    | `caps.test.ts` (checks every pack generically)       |
| Kind-gated recommendation | `packages/plugin/tests/pack-map.test.ts`             |

A change to this pack alone is released by its Conventional Commit type
(`fix(packs): ...` for a fix or a change to existing behaviour,
`feat(packs): ...` for new public surface),
because packs ship inside the CLI tarball and have no release of their own.
There is no changeset.
