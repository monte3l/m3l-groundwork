---
"@monte3l/groundwork": patch
---

The emitted `bin/lint-commit.mjs` now reports a missing or broken `commitlint.config.js`, an unreadable commit message file and a forbidden `Claude-*` trailer as `✗` lines with exit 1, instead of a stack trace or an unprefixed line.
