---
"@monte3l/groundwork": patch
---

Fresh mode now checks every destination of the baseline, any `--pack` and the `/customize` skill before writing anything, and refuses (writing nothing) when one sits under a symlink or a non-directory, or is a symlink or directory where a file goes (a symlink at a `/customize` skill file is replaced, never written through), so `--force` no longer writes through a symlinked `.claude`. The adopt survey records a file or directory it cannot read, or a dangling link or loop, under `undetermined` instead of aborting. The emitted `guard-hub-src-writes.mjs` now also blocks writes to or removal of a parent of `src/` or `tests/`, `php`/`deno`/`bun` writes and `node`/`python` deletes and moves; it remains a conservative screen, not a proof.
