---
paths:
  - "templates/packs/harness-extras/**"
---

# Pack rules: `harness-extras` (`templates/packs/harness-extras/**`)

> This file is the terse checklist that auto-loads when you edit the
> `harness-extras` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** Claude Code session ergonomics: the compaction-handoff hook
pair, `guard-readonly-bash`, and the `statusLine` and `subagentStatusLine`
renderers. Modes: fresh and adopt. Budget: 6 hooks. Requires
`bin/lib/agent-roster.mjs` from the baseline.

- **It is the only pack that plants top-level settings keys** (`statusLine`,
  `subagentStatusLine`) through `wiring.settingsTopLevel`. Identical is a
  no-op, different is a hard collision, and an adopted project's own value
  is never overwritten.
- **`guard-readonly-bash.mjs` imports the baseline's `agent-roster.mjs`.**
  Keep the `requires.paths` entry honest if that import changes.
- **The statusline scripts read only the stdin payload, `.git/HEAD` through
  `node:fs` and memory figures.** Never spawn a git subprocess from one: they
  run on every prompt.
- **Newer payload fields render only when present.** An older Claude Code
  must degrade to fewer segments, never break. A row that overflows
  `COLUMNS` drops its lowest-priority segments rather than wrapping
  (`fitRow` in `statusline-layout.mjs`).
- **The handoff artifact is written under `tmp/`** in the git worktree the
  session runs in. The root prefers the hook payload's `cwd` over
  `CLAUDE_PROJECT_DIR`, which does not follow a session into a worktree.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                       | Where                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Hook and renderer behaviour | `packages/cli/tests/templates/{statusline-pack,compact-handoff,guard-readonly-bash}.test.ts` |
| Settings merge              | `merge-json.test.ts`, `merge-json.property.test.ts`, `packs.test.ts`                         |
| Budget                      | `caps.test.ts`                                                                               |

A change to this pack alone takes a changeset whose summary starts with
`pack(harness-extras):`.
