---
"@monte3l/groundwork": patch
---

Fixes the emitted baseline's harness so it works correctly inside a git worktree (`claude --worktree`, an `isolation: "worktree"` subagent, or `EnterWorktree`):

- `bin/check-harness.mjs`/`bin/check-toolchain.mjs`'s shared `walkBounded` helper, and `/customize`'s adopt-mode surveys that use it, no longer silently walk into (or get confused by) a `.claude/worktrees/<name>/` checkout Claude Code created -- it's now skipped by its exact relative path, not by a bare directory name, so a project's own `.claude/skills/worktrees/` or `src/worktrees/` is never mistaken for one.
- `.claude/hooks/post-edit-verify.mjs` (the in-loop verify hook) previously computed every path against `CLAUDE_PROJECT_DIR`, which Claude Code pins to the session's original project root and never moves into a worktree -- so every edit made inside a worktree silently got zero in-loop verification. It now resolves the git working-tree root that actually contains the edited file and scopes every check to that root, the same "resolve from the file, not the session" approach `guard-branch-isolation.mjs` already used. It also now resolves that path through symlinks first, so a symlinked project checkout (macOS's `/tmp` -> `/private/tmp`, a symlinked home directory) doesn't silently skip either.
- The emitted `.gitignore`/`.prettierignore`/`eslint.config.js`/`vitest.config.ts` now exclude `.claude/worktrees/` (and `.env`/`.env.local`/`.env.*.local`), matching this repo's own configuration.
- `finishing-work` now detects a linked worktree before deleting a merged branch and removes it safely (with confirmation) first; `starting-work` hands off to an optional worktree-management add-on's start mode when one is installed.

No public API change; this only affects the harness emitted into a bootstrapped or adopted project.
