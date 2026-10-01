---
"@monte3l/groundwork": patch
---

Fresh mode now fails before writing anything when it can know the run will not work: an unknown or fresh-incompatible `--pack` (with a hint that `statusline` was folded into `harness-extras`) and Windows, which is not supported yet, are usage errors (exit 2) that leave the target untouched. A failed or missing `pnpm install` no longer aborts with a raw stack trace after the project is written: the CLI reports the project as ready, tells you to run `pnpm install` yourself, and exits 1.
