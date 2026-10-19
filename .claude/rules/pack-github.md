---
paths:
  - "templates/packs/github/**"
---

# Pack rules: `github` (`templates/packs/github/**`)

> This file is the terse checklist that auto-loads when you edit the
> `github` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** Three `gh`-CLI skills (`reviewing-dependabot-prs`,
`triaging-scan-alerts`, `watching-pr-checks`). Modes: fresh and adopt.
Budget: 3 skills, 0 workflows. The Claude Code GitHub Action workflows used to
ship here and are now the `claude-github` pack (`pack-claude-github.md`); do
not add a workflow back.

- **`triaging-scan-alerts` depends on code scanning being on,** which
  nothing in the baseline produces. Keep `adoptNotes` saying so.
- **The `budget` in `pack.json` must equal the real `files/` count.**
  `packages/cli/tests/caps.test.ts` checks it.

| Proof                        | Where                                         |
| ---------------------------- | --------------------------------------------- |
| Installs and verifies        | `packages/cli/tests/packs-github.e2e.test.ts` |
| Manifest and wiring contract | `packs.test.ts`, `caps.test.ts`               |

A change to this pack alone takes a changeset whose summary starts with
`pack(github):`, because packs ship inside the CLI tarball and have no
release of their own.
