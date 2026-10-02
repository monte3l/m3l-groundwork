---
"@monte3l/groundwork": patch
---

Fresh mode now checks every destination path of the baseline and any `--pack` before writing anything, and refuses (writing nothing) when a directory component or an existing destination file is a symlink or a non-directory where a directory is needed, so `--force` no longer writes template files through a symlinked `.claude`. The adopt survey no longer aborts on a file it lacks permission to read: it records the path and error code under `undetermined` and carries on (any other read error still stops the run, with the path and cause). The emitted baseline's `guard-hub-src-writes.mjs` now also blocks writes into or removal of an ancestor of `src/`/`tests/` (`rsync` into the project root, `rm -rf .`), `php` `file_put_contents`/`fopen` writes, and `node`/`python` delete and move calls; it remains a conservative screen, not a proof.
