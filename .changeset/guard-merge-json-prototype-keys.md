---
"@monte3l/groundwork": patch
---

The pack merge functions (`mergeSettingsHooks`, `mergeSettingsTopLevel`, `mergePackageScripts`) now reject a `__proto__`, `constructor` or `prototype` key in a pack fragment with an error naming the key. Previously a `__proto__` key was assigned onto a copied plain object, which swapped that object's own prototype and made `JSON.stringify` silently drop the key (CWE-1321 shaped; it did not touch the global `Object.prototype`). Only `__proto__` is exploitable that way; the other two are rejected as cheap defence in depth. No shipped pack triggered it.
