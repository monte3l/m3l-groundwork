---
"@monte3l/groundwork": patch
---

Adopt mode now stages the baseline files it would add under `.groundwork/baseline/` and records them in the inventory (`schemaVersion` 5, new `stagedBaseline` field), so `/customize` no longer depends on `templateRoot`, an absolute path that may be gone by the time it runs. `/customize` reads the staged copy, falls back to `templateRoot` only for older inventories, and refuses an inventory newer than it understands, telling you to update the plugin.
