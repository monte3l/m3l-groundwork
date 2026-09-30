---
"@monte3l/groundwork": patch
---

Retires the unreleased `ts-advisor` pack and folds its skill into the baseline `typescript-guidance` skill as a third mode, `gaps`, so every bootstrapped project gets it without a `--pack`. `gaps` profiles the toolchain offline, then researches live before recommending TypeScript tooling the project does not have yet, each recommendation with a source fetched in that run; drift in tooling that already exists stays `research` and `refresh`. Its two reference files (`area-catalog.md`, `tooling-sources.md`) now sit beside `typescript-sources.md`, and the baseline skill count is unchanged at seven. `--pack ts-advisor` is now rejected as an unknown pack. `/customize` now offers `gaps` mode in its guidance pass, and the hard-coded example versions the old skill carried were dropped in favour of "where to look".
