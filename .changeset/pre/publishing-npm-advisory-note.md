---
"@monte3l/groundwork": patch
---

The `publishing` pack's install notes now say that the npm pinned in its shipped `release-tools` lockfile bundles dependencies with open advisories as of 2026-10-01, which of the shipped workflow's commands reach them (no reach found by reading the tarballs and lockfile; the security review lists the callers and the limits), and to bump the pin once a patched npm exists.
