---
"@monte3l/groundwork": patch
---

pack(github): the pack's `adoptNotes` now point to the `supply-chain` pack, not `publishing`, as the one that ships `scorecard.yml` and uploads the SARIF results `triaging-scan-alerts` reads. `scorecard.yml` moved to `supply-chain` when it was split out of `publishing`, and the note still named the old home, so an adopter following it would have installed a fresh-only release pipeline to get code-scanning alerts.
