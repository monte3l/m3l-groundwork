---
"@monte3l/groundwork": patch
---

pack(publishing): the release workflow now stages through `libnpmpublish` instead of the npm CLI, with a small `bin/npm-stage-publish.mjs` doing the GitHub OIDC token exchange, so the shipped `tools/release/` lockfile no longer carries the advisories bundled inside the npm tarball (undici, ip-address, brace-expansion, http-cache-semantics, postcss-selector-parser) that no override could patch. The lockfile moved from `.github/release-tools/` to `tools/release/`, and the pack's install notes drop the dated security note. The staged-only trusted publisher setting is unchanged.
