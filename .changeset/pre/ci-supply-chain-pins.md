---
"@monte3l/groundwork": patch
---

The emitted baseline's CI workflows now pin every `uses:` by commit SHA (with a `# vX` comment naming the tag) instead of a floating major tag, matching this repo's own SHA-pinning discipline: `actions/checkout` (v6 -> v7), `pnpm/action-setup` (v4 -> v6), `actions/setup-node`, `actions/dependency-review-action` (v4 -> v5), and `actions/github-script`. A new `.github/dependabot.yml` (github-actions ecosystem) keeps those pins from going stale. The `claude-action` pack's workflow gets the same treatment (`actions/checkout` v6 -> v7, `anthropics/claude-code-action` v1 -> the exact patch this repo pins).
