---
"@monte3l/groundwork": patch
---

The publishing pack's `tools/release/package-lock.json` is now shipped in the tarball (escaped as `_package-lock.json`); previously npm-family packing stripped it, so `npm ci --ignore-scripts --prefix tools/release` had no lockfile in a project bootstrapped with `--pack publishing`.
