---
"@monte3l/groundwork": patch
---

Adopt mode now stages the baseline files it would add under `.groundwork/baseline/` as inert copies (each name gets a `.staged` suffix so no project tool or Claude Code discovers them as live source) and records each one's original path, staged name and SHA-256 in the inventory (`schemaVersion` 5, new `stagedBaseline` field). `/customize` no longer depends on `templateRoot`, an absolute path that may be gone by the time it runs: for a schema 5 inventory it verifies every staged file against its hash and stops with a re-run request on any mismatch, never falling back to `templateRoot`. It also refuses an inventory newer than it understands and tells you to update the plugin. Staging is atomic, refuses a symlinked `.groundwork`, and the inventory is written last so a failed run never leaves a stale one.
