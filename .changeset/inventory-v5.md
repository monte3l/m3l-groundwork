---
"@monte3l/groundwork": patch
---

Adopt mode now stages the baseline files it would add, and the packs, under `.groundwork/` as inert `.staged` copies, and records each one's path, staged name and SHA-256 in the inventory (`schemaVersion` 5, new `stagedBaseline` field). `/customize` no longer depends on `templateRoot`: for a schema 5 inventory it checks every staged file against its hash before offering anything, and stops with a re-run request otherwise. It also refuses an inventory newer than it understands, a `.groundwork/` directory without an inventory (an interrupted run), and an inventory that is not valid JSON. Staging is atomic and refuses a symlinked `.groundwork`; the inventory is written last, so its presence means the run completed. The CLI now prints a failure's full cause chain, escaping control and bidirectional-text characters in error messages so a crafted file name cannot forge output, and says `.groundwork/` is incomplete when a write fails.
