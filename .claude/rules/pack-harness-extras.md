---
paths:
  - "templates/packs/harness-extras/**"
---

# Pack rules: `harness-extras` (`templates/packs/harness-extras/**`)

> This file is the terse checklist that auto-loads when you edit the
> `harness-extras` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** Claude Code session hooks: the compaction-handoff hook
pair, `guard-readonly-bash` and the org's `guard-shell-portability`. Modes:
fresh and adopt. Budget: 4 hooks. Requires `bin/lib/agent-roster.mjs` from the
baseline. The status line used to
ship here and is now the `statusline` pack (`pack-statusline.md`); do not add
a top-level settings key back, since that is exactly the collision the split
removed.

- **`guard-readonly-bash.mjs` imports the baseline's `agent-roster.mjs`.**
  Keep the `requires.paths` entry honest if that import changes.
- **The handoff artifact is written under `tmp/`** in the git worktree the
  session runs in. The root prefers the hook payload's `cwd` over
  `CLAUDE_PROJECT_DIR`, which does not follow a session into a worktree.
- **`guard-shell-portability.mjs` is the org's verbatim starter** from
  `monte3l/.github` (`blueprint/files/`). Change it there, never here:
  `org-guard-starters.test.ts` keeps the root copy and this one identical
  apart from the SPDX header. It is in the pack, not `templates/core`,
  because the baseline is capped at 10 hooks.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof          | Where                                                                        |
| -------------- | ---------------------------------------------------------------------------- |
| Hook behaviour | `packages/cli/tests/templates/{compact-handoff,guard-readonly-bash}.test.ts` |
| Budget         | `caps.test.ts`                                                               |

A change to this pack alone is released by its Conventional Commit type
(`fix(packs): ...` for a fix or a change to existing behaviour,
`feat(packs): ...` for new public surface),
because packs ship inside the CLI tarball and have no release of their own.
There is no changeset.
