---
"@monte3l/groundwork": patch
---

Fresh mode now fails before writing anything when it can know the run will not work. **Exit-code change:** an unknown or fresh-incompatible `--pack` now exits 2 (a usage error, with the usage text) instead of exiting 1 after half-writing the target; `--pack statusline` points at `harness-extras`, which it was folded into. Fresh mode on Windows is refused up front with exit 1 ("Windows is not supported yet (Linux and macOS only)"); adopt mode, `--help`, `--version` and `--list-packs` still work there. A failed `git init` or `pnpm install` after the project is written now exits 1 with one message that says the project was written and what to run by hand, and keeps the original error as its cause, instead of a raw stack trace.
