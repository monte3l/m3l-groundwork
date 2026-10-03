---
"@monte3l/groundwork": patch
---

Makes the `github` pack's `claude-pr-review.yml` post its review reliably. Claude no longer posts the review itself, a path that could finish green with 5-9 permission denials and post nothing, leaving a push unreviewed until the PR was closed and reopened. The workflow is now two jobs: `review` runs Claude read-only (no subagents, no write token) and returns schema-validated structured output, which fails the run if absent, and `post` publishes it as one sticky summary comment, edited on each push, plus de-duplicated inline comments. The `post` job fails on any API error other than an inline comment GitHub cannot anchor to the diff, which is folded into the summary. Comments now appear as `github-actions[bot]`.
