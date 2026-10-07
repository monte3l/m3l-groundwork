---
"@monte3l/groundwork": patch
---

The `publishing` pack's pinned release-tools npm moves from 11.20.0 to 12.2.0 (Dependabot, #122). npm 12.2.0 needs Node `^22.22.2 || ^24.15.0 || >=26`, which the baseline's `.node-version` (24) satisfies. The pack's security note, which named the old version, is updated to match; the advisory analysis it records is unchanged, since 12.2.0 bundles the same undici, ip-address and brace-expansion versions as 11.20.0.
