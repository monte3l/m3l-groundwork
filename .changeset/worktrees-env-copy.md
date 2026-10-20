---
"@monte3l/groundwork": patch
---

pack(worktrees): the `working-in-worktrees` skill's `.env` copy step no longer collides with the baseline's `Read(./.env)` deny rules. It copies with `cp -n`, never reads or prints a file, and if Claude Code denies the copy it stops and asks the owner to copy the files themselves instead of working around the block.
