---
"@monte3l/groundwork": patch
---

Adds a `supply-chain` pack, split out of `publishing`: `gitleaks.yml` (secret scanning, with a `.gitleaks.toml`) and `scorecard.yml` (OpenSSF Scorecard). It is a pure file drop of two read-only workflows, so unlike `publishing` it installs into an already-established project, and `/customize` recommends it for every project kind. `publishing` keeps the release pipeline and the SPDX license-header gate, whose one-time backfill makes it fresh-mode only. The two workflows no longer carry a `__PROJECT_NAME__` SPDX header; a project that also installs `publishing` gets the header from its `check-license-headers.mjs --fix` backfill.
