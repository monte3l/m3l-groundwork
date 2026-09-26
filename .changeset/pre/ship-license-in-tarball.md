---
"@monte3l/groundwork": patch
---

The published tarball now includes the repository's `LICENSE` file (`prepack` vendors it in, `postpack` removes it again -- the same pattern already used for `templates/` and the plugin payload). Previously the package shipped with no license file at all.
