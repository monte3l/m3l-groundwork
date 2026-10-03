---
"@monte3l/groundwork": patch
---

Brings the harness grader's model table and the shipped `github` and `quality` packs up to the current Claude lineup. `CURRENT_MODELS` (in both the CLI's `rules.ts` and the emitted `check-harness` gate's `harness-rules.mjs`) now accepts `claude-sonnet-5-5`, so an agent pinned to the current Sonnet no longer draws a `model-pin-currency` warning; the table keeps current ids and aliases plus ids that were once listed, until Anthropic deprecates them. The `github` pack's `claude-pr-review.yml` now falls back to `claude-sonnet-5-5` instead of `claude-sonnet-5`, and both of its workflows pin `anthropics/claude-code-action` at v1.0.240 (same commit-SHA pin style, no input changes). The `quality` pack's install notes now describe `type-design-analyzer`'s cost against the baseline's current `claude-opus-5-5` medium-effort reviewers rather than "sonnet reviewers".
