---
"@monte3l/groundwork": patch
---

The `publishing` pack's `release.yml` now attaches the attested tarball to the GitHub Release that changesets actually created: a single-package project's releases are tagged `v<version>`, not `<name>@<version>`, so the old upload targeted a tag that did not exist and the failure was hidden by `continue-on-error`. Its `.changeset/config.json` now defaults to `access: public`, its `REUSE.toml` covers the `worktrees` pack's `.worktreeinclude` (installing both packs together failed the license-header gate), and its `adoptNotes` cover token replacement in a hand-copied install. The `worktrees` pack's `finish` mode now runs the same unmerged-commit check as `finishing-work`, its fan-out section tells each subagent to install dependencies first, and `.worktreeinclude` also copies `.env.*.local`. The `github` pack's `adoptNotes` say `triaging-scan-alerts` needs code scanning enabled.
