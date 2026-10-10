---
paths:
  - "templates/packs/quality/**"
---

# Pack rules: `quality` (`templates/packs/quality/**`)

> This file is the terse checklist that auto-loads when you edit the
> `quality` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The `type-design-analyzer` review agent and the
`check-file-budget` size ratchet with its committed baseline. Modes: fresh
and adopt. Budget: 1 agent. Requires `bin/lib/report.mjs` from the baseline.

- **`check-file-budget.mjs` imports `./lib/report.mjs`,** a baseline file an
  adopted project will not have. Keep `requires.paths` and `adoptNotes`
  honest if the import changes.
- **Its `ROOTS` default assumes a flat `src/` and `tests/` layout,** and the
  ceilings in `file-budget-baseline.json` are the baseline's defaults. An
  adopted project must re-point them. Never loosen a ceiling to make a
  change pass: the file is a ratchet.
- **The agent is a read-only review spoke** (`claude-opus-5-5` at `xhigh`
  effort), costlier than the baseline's reviewers, and nothing dispatches it
  by name. Keep it read-only: no write tools.
- **The pack has no hooks, settings or scripts, but it does wire one
  `file-budget` verify step** into the `build` group through
  `wiring.verifySteps`. Do not add a hook or script without re-checking the
  budget arithmetic in `caps.ts`.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                 | Where                                          |
| --------------------- | ---------------------------------------------- |
| Installs and verifies | `packages/cli/tests/packs-quality.e2e.test.ts` |
| Combined              | `packs-combined.e2e.test.ts`                   |
| Budget and manifest   | `caps.test.ts`, `packs.test.ts`                |

A change to this pack alone takes a changeset whose summary starts with
`pack(quality):`.
