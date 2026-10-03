---
"@monte3l/groundwork": patch
---

Adds a second Claude Code GitHub Action and three `gh`-CLI skills to the `github` pack:

- `.github/workflows/claude-pr-review.yml`, generalized from this repo's own workflow, posts an automated Claude review comment on every pull request (read-only on repo contents; it never pushes code, submits a formal review, or approves a PR).
- `reviewing-dependabot-prs`: classifies every open Dependabot PR by semver bump level and CI check status, proposes merge/hold/close, and acts only on the batch the user confirms.
- `triaging-scan-alerts`: fetches open code-scanning alerts, groups them by tool and severity, and maps each to file:line -- report and options only, it never edits code.
- `watching-pr-checks`: checks a PR's CI status once, and on a real failure reads the actual job log and hands off to `/triaging-ci` rather than guessing from the check name.

The pack's budget grows from 1 workflow to 2 workflows and 3 skills; its `adoptNotes` cover both workflows' shared auth-secret dependency.
