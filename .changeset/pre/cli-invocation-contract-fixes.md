---
"@monte3l/groundwork": patch
---

The CLI's invocation contract now rejects several previously-silent or wrongly-coded invocations as usage errors (exit code 2), matching the frozen "invalid or contradictory invocations fail fast" policy:

- Adopt mode now rejects `--force` and `--pack` outright with `CliUsageError`, instead of throwing a plain runtime error (`--force`, exit 1) or silently ignoring the flag entirely (`--pack`).
- `--adopt` against a target directory that doesn't exist now fails with a clear usage error, instead of an uncaught filesystem exception.
- A repeated `--name` (or any future single-value flag) now fails fast, instead of silently keeping the last value.
- `.groundwork/adoption-report.md` now detects a git worktree or submodule (`.git` as a file, not a directory) as an existing project to adopt, instead of misdetecting it as empty.
- A malformed `package.json` is now recorded once in the adoption report's undetermined list, instead of being silently dropped (or, in one intermediate state, reported twice).
- The adoption report's caps table now shows Workflows and Scripts rows, and folds every listed pack's budget into the displayed post-merge total and over-cap warning, instead of omitting two of the five caps and excluding pack budgets from the total it displays.
- A pack whose `pack.json` has an internal `name` not matching its own directory, or a malformed `budget`, now fails to load with a clear error instead of risking a staging collision or propagating `NaN` into the caps table.
- Several smaller robustness fixes: a non-object `tsconfig.json`/`package.json` (e.g. literally `null`) no longer crashes conflict detection; the `/customize` skill's staleness check now compares all four of its files, not just `SKILL.md`; a settings-merge collision check no longer misfires on two semantically-identical values that merely have their keys in a different order; re-staging a pack now clears files a newer version dropped.
