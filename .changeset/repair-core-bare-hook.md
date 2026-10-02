---
"@monte3l/groundwork": patch
---

Adds a `repair-core-bare.mjs` hook to the `worktrees` pack (its hooks budget grows from 2 to 3). Claude Code's `EnterWorktree`/`ExitWorktree` tools are reported to leave `core.bare = true` in a normal repository's shared `.git/config`, which breaks `git status` in the main checkout while linked worktrees keep working. The hook resets it on `SessionStart` and after `EnterWorktree`/`ExitWorktree`/`Agent` calls, and only on a repository it can prove is not bare (a `.git` common dir containing an `index`), never on a genuine bare repo. A repair that fails is reported rather than swallowed, including a `config.lock` more than a minute old left by a crashed git (reported with the exact commands, never deleted automatically). The `working-in-worktrees` and `finishing-work` skills now mention the side effect and the manual fix.
