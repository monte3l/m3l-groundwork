---
"@monte3l/groundwork": patch
---

The pack merge functions (`mergeSettingsHooks`, `mergeSettingsTopLevel`, `mergePackageScripts`) now reject a `__proto__`, `constructor` or `prototype` key in a pack fragment with an error naming the key, instead of writing it onto a plain object. This closes a prototype-pollution-shaped write (CWE-1321) that no shipped pack triggered but a malformed or hostile `pack.json` could have.
