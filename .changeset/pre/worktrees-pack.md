---
"@monte3l/groundwork": patch
---

Adds a `worktrees` pack (`--pack worktrees`): enforces that all src/tests development happens inside an isolated git worktree, on any branch, for any caller (hub or writer spoke) -- stricter than the baseline's own `guard-branch-isolation.mjs` (blocks only on `main`) and `guard-hub-src-writes.mjs` (blocks only the hub).

- `working-in-worktrees` skill: start (creates a worktree with the final branch name up front, installs dependencies), status, sync, finish (mirrors `finishing-work`'s own worktree-aware cleanup), and fan-out (independent units via per-call `isolation: "worktree"`).
- `guard-worktree-only.mjs`: a `PreToolUse` guard that blocks a src/tests write outside a linked worktree under `.claude/worktrees/`, closing the sibling-worktree gap `bin/lib/protected-paths.mjs`'s own doc comment names (a checkout entirely outside the project's path can never be recognized as protected by `isProtectedPath` alone).
- `ensure-worktree-deps.mjs`: a `SessionStart` backstop that installs dependencies into a freshly created worktree that has none yet.
- `.worktreeinclude`: copies `.env`/`.env.local` into every worktree Claude Code creates.

`recommended: false` in `/customize`'s pack recommendations, deliberately -- it changes the day-to-day workflow rather than adding a nicety.

No public API change beyond the new pack name being installable; this only affects a project that opts in.
