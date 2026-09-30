---
"@monte3l/groundwork": patch
---

Adds a third mode, `gaps`, to the baseline `typescript-guidance` skill, so every bootstrapped project can ask what TypeScript tooling it is missing without installing a pack. `gaps` profiles the toolchain offline, then researches live before recommending tooling the project does not have yet, each recommendation with a source fetched in that run; drift in tooling that already exists stays `research` and `refresh`. Its two reference files (`area-catalog.md`, `tooling-sources.md`) sit beside `typescript-sources.md`, and the baseline skill count is unchanged at seven. `/customize` now offers `gaps` mode in its guidance pass, and its recommendation for Claude Code's own automation tooling points TypeScript-toolchain gaps at it.
