---
"@monte3l/groundwork": patch
---

The baseline's `permissions.deny` now also blocks reading `credentials.json` and `secrets.yaml` at any depth, and editing `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` and the repository's `.git/` directory. The edit rules are `Edit(...)` rules, which Claude Code applies to every built-in file-editing tool, so the package manager and git stay the only writers of those files. A subprocess such as `pnpm install` still rewrites the lock file, `grep -r` or a script that opens a denied file is not covered, and in a linked worktree `.git` is a file the `.git/` rule does not match. A fresh project gets the entries. An adopted project with its own `.claude/settings.json` sees this as a `settings.json` conflict in `/customize` (keep, take or merge), and one without it gets the staged file; the CLI never edits an existing `settings.json`.
