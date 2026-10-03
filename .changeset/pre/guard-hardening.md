---
"@monte3l/groundwork": patch
---

Hardens the emitted baseline's hub-and-spoke enforcement hooks (`guard-branch-isolation.mjs`, `guard-hub-src-writes.mjs`) and the `harness-extras` pack's `guard-readonly-bash.mjs`:

- `isProtectedPath` no longer matches `/src/`/`/tests/` anywhere in an absolute path's raw text -- scoped to the project directory (or a file's real git worktree root), it no longer wrongly protects a checkout whose own path happens to contain the substring `/src/` (e.g. a clone at `~/src/some-project`), and its comparison is case-insensitive so a differently-cased spelling of the identical file (macOS's default case-insensitive filesystem) is still caught correctly.
- `guard-branch-isolation.mjs` now binds its git branch check to the nearest existing ancestor of a write's target directory, so creating a file in a brand-new nested directory (which doesn't exist yet) no longer silently breaks branch detection and lets the write through unblocked on `main`.
- `guard-readonly-bash.mjs`'s mutating-command denylist now also catches `git rm/mv/pull`, `pnpm`/`npm install`/`update`, `sed --in-place`, a mutating command hidden behind a `sudo`/`env`/`xargs`/`command` prefix or a nested `bash -c`/`sh -c` shell, and `find -delete`/`-exec <mutating command>`. A malformed agent frontmatter block (CRLF line endings, a quoted `name:` value) no longer silently produces an empty read-only-agent roster, which previously disabled the guard for every subagent.
- `bin/verify.mjs`'s `--group`/`--step` with no value now fails with a clear error instead of silently running every step.
