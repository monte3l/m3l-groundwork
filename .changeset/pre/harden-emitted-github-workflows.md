---
"@monte3l/groundwork": patch
---

The `github` pack's emitted `claude.yml` now restricts `@claude` triggers to the repository's owner, members and collaborators (`author_association`), commits through the GitHub API (`use_commit_signing`) so a signed-commits ruleset accepts its work, and serializes runs per issue or PR with a `concurrency` group. Before this, any commenter on a public repository could start a job holding `contents: write` and the auth secret. The baseline's `ci.yml` and `security-audit.yml` now pin `pnpm/action-setup` to the same v6.1.0 commit as the `publishing` pack, `security-audit.yml` gets a `concurrency` group, and the `publishing` pack's `adoptNotes` now says to add `.github/release-tools` to the project's Dependabot config.
