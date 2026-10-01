---
"@monte3l/groundwork": patch
---

Brings the harness grader's model table and the shipped `github` pack up to the current Claude lineup. `CURRENT_MODELS` (in both the CLI's `rules.ts` and the emitted `check-harness` gate's `harness-rules.mjs`) now accepts `claude-sonnet-5-5`, plus `claude-fable-5` and `claude-opus-4-8`, which Anthropic's model-deprecations page lists as active, so an agent pinned to the current Sonnet no longer draws a `model-pin-currency` warning. The `github` pack's `claude-pr-review.yml` now falls back to `claude-sonnet-5-5` instead of `claude-sonnet-5`, and both of its workflows pin `anthropics/claude-code-action` at v1.0.238 (same commit-SHA pin style, no input changes).
