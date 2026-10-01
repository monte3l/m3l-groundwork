---
"@monte3l/groundwork": patch
---

A pack whose `pack.json` wiring names `__proto__`, `constructor` or `prototype` as a hook event, a top-level settings key or a package script is now refused when the manifest is loaded, before anything is written. In fresh mode that means the target is left untouched (previously the baseline and the pack's files were written and the settings merge then failed, exit 1); in adopt mode it means `.groundwork/` is not modified and no manifest is staged. The merge-time guards remain as defence in depth, and `/customize` now stops if a staged manifest carries one of these keys.
