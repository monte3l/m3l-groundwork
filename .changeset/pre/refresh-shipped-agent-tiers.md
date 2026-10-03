---
"@monte3l/groundwork": patch
---

Moves the emitted baseline's agents onto Anthropic's current model lineup. `code-reviewer`, `silent-failure-hunter` and `code-implementer` now pin `claude-opus-5-5` with `effort: medium` (Opus 5.5's own default, and Anthropic's stated fit for long-running agentic coding), and `test-author` pins `claude-sonnet-5-5` with `effort: medium`; all four previously pinned `claude-sonnet-5` with `effort: high`. `Explore` is unchanged on `claude-haiku-4-5` with no `effort` field. The agent count stays at five, so the baseline caps are unaffected. Projects bootstrapped earlier keep their own pins; the emitted `check-harness` gate accepts both the old and new ids.
