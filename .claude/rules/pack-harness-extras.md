---
paths:
  - "templates/packs/harness-extras/**"
---

# Pack rules: `harness-extras` (`templates/packs/harness-extras/**`)

> This file is the terse checklist that auto-loads when you edit the
> `harness-extras` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** Claude Code session hooks: the compaction-handoff hook
pair and `guard-readonly-bash`. Modes: fresh and adopt. Budget: 3 hooks.
Requires `bin/lib/agent-roster.mjs` from the baseline. The status line used to
ship here and is now the `statusline` pack (`pack-statusline.md`); do not add
a top-level settings key back, since that is exactly the collision the split
removed.

- **`guard-readonly-bash.mjs` imports the baseline's `agent-roster.mjs`.**
  Keep the `requires.paths` entry honest if that import changes.
- **The handoff artifact is written under `tmp/`** in the git worktree the
  session runs in. The root prefers the hook payload's `cwd` over
  `CLAUDE_PROJECT_DIR`, which does not follow a session into a worktree.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof          | Where                                                                        |
| -------------- | ---------------------------------------------------------------------------- |
| Hook behaviour | `packages/cli/tests/templates/{compact-handoff,guard-readonly-bash}.test.ts` |
| Budget         | `caps.test.ts`                                                               |

A change to this pack alone takes a changeset whose summary starts with
`pack(harness-extras):`.
