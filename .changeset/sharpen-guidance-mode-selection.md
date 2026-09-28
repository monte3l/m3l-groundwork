---
"@monte3l/groundwork": patch
---

Sharpens the emitted baseline's `typescript-guidance` and `harness-guidance` skills' mode-selection rule (`research` vs `refresh`): a question naming one flag, setting, or narrow facet now explicitly stays `research` even when phrased "is X still current," rather than leaving that boundary to be inferred from a single terse sentence. Also drops the `effort: low` field from the emitted `Explore` agent (`templates/core/.claude/agents/Explore.md`) -- Anthropic's own effort-parameter documentation does not list Haiku as a supported model for that field, so it was a no-op at best and a silently-ignored config at worst.

Both changes came out of a behavioural re-evaluation of all 8 shipped skills (the baseline's 7 plus `/customize`): real, repeatable prompts run with and without each skill, graded against drafted assertions. Everything else held up cleanly -- no other skill needed a content change.
