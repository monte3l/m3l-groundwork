---
paths:
  - "templates/packs/claude-github/**"
---

# Pack rules: `claude-github` (`templates/packs/claude-github/**`)

> This file is the terse checklist that auto-loads when you edit the
> `claude-github` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The `claude-action` workflow in `@claude` mention-mode
(`claude.yml`) and an automated PR-review workflow (`claude-pr-review.yml`).
Modes: fresh and adopt. Budget: 2 workflows. It was split out of the `github`
pack so a project can take that pack's `gh`-CLI skills without these
workflows, which need a secret and spend API credits on every PR. Keep the two
packs independent: neither may name the other as a requirement.

- **Both workflows need an auth secret the pack cannot create or verify.**
  Never make a missing secret a silent no-op.
- **`claude.yml` gates on `author_association`** (owner, member or
  collaborator) so an outside commenter cannot start a job that holds
  `contents: write`. Do not loosen it.
- **`claude.yml` caps each run with `--max-turns 20`** in `claude_args`
  (Anthropic's cost guidance recommends one; the job's `timeout-minutes: 30`
  stays the hard stop). `claude-pr-review.yml` sets no turn cap: its `gate`
  step fails the job when no structured review comes back, so a cap there
  would surface as a red check, not a quiet pass. Add one only if review cost
  becomes a problem. If a cap trips, raise it rather than removing it.
- **`claude-pr-review.yml` is a separate implementation,** not a copy of the
  root workflow removed over a silent no-post bug (see `ci.md`): two jobs, a
  read-only `review` with `--json-schema` and a `gh`/`jq` `post`, written to
  work around that bug. Do not "restore" the root design into it.
- **The two files reference each other** in comments (`claude.yml` documents
  the auth options the review workflow points to), so they move together.
- **The `budget` in `pack.json` must equal the real `files/` count.**
  `packages/cli/tests/caps.test.ts` checks it.
- **Actions are SHA-pinned with a `# v<tag>` comment,** as everywhere else (a major tag such as `# v7`, or the full version where upstream publishes only that, as for `anthropics/claude-code-action`).

| Proof                        | Where                                                |
| ---------------------------- | ---------------------------------------------------- |
| Installs and verifies        | `packages/cli/tests/packs-claude-github.e2e.test.ts` |
| Manifest and wiring contract | `packs.test.ts`, `caps.test.ts`                      |

A change to this pack alone is released by its Conventional Commit type
(`fix(packs): ...` for a fix or a change to existing behaviour,
`feat(packs): ...` for new public surface),
because packs ship inside the CLI tarball and have no release of their own.
There is no changeset.
