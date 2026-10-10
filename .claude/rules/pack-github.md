---
paths:
  - "templates/packs/github/**"
---

# Pack rules: `github` (`templates/packs/github/**`)

> This file is the terse checklist that auto-loads when you edit the
> `github` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The `claude-action` workflow in `@claude` mention-mode, an
automated PR-review workflow, and three `gh`-CLI skills
(`reviewing-dependabot-prs`, `triaging-scan-alerts`, `watching-pr-checks`).
Modes: fresh and adopt. Budget: 3 skills, 2 workflows.

- **Both workflows need an auth secret the pack cannot create or verify.**
  Until one is set they run and fail cleanly with an auth error. Keep that
  failure mode: never make a missing secret a silent no-op.
- **`claude.yml` gates on `author_association`** (owner, member or
  collaborator) so an outside commenter cannot start a job that holds
  `contents: write`. Do not loosen it.
- **`claude-pr-review.yml` is a separate implementation,** not a copy of the
  root workflow removed over a silent no-post bug (see `ci.md`): two jobs, a
  read-only `review` with `--json-schema` and a `gh`/`jq` `post`, written to
  work around that bug. Do not "restore" the root design into it.
- **`triaging-scan-alerts` depends on code scanning being on,** which
  nothing in the baseline produces. Keep `adoptNotes` saying so.
- **The `budget` in `pack.json` must equal the real `files/` count.**
  `packages/cli/tests/caps.test.ts` checks it.
- **Actions are SHA-pinned with a `# vX.Y.Z` comment,** as everywhere else.

| Proof                        | Where                                         |
| ---------------------------- | --------------------------------------------- |
| Installs and verifies        | `packages/cli/tests/packs-github.e2e.test.ts` |
| Combined with other packs    | `packs-combined.e2e.test.ts`                  |
| Manifest and wiring contract | `packs.test.ts`, `caps.test.ts`               |

A change to this pack alone takes a changeset whose summary starts with
`pack(github):`, because packs ship inside the CLI tarball and have no
release of their own.
