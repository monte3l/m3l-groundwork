---
"@monte3l/groundwork": patch
---

`--pack <name>` and an explicit `--name <project-name>` are now validated by shape before any filesystem access. `--pack` must be a bare lowercase directory-name (rejecting a path traversal segment, an absolute path, a path separator, or uppercase characters); `--name` must be a syntactically valid npm package name. Both throw a usage error (exit 2) naming the offending value, the same way an unrecognized flag already does.
