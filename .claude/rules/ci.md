---
paths:
  - ".github/**"
  - "lefthook.yml"
  - "bin/verify.mjs"
  - "bin/lib/verify-steps.mjs"
  - "bin/check-node-version.mjs"
---

# CI rules (`.github/**`, `lefthook.yml`, the verify runner)

> This file is the terse checklist that auto-loads when you edit this
> repo's own CI workflows or the local scripts that mirror them. See
> CLAUDE.md's "Commands" for what each `pnpm verify` group runs.

- **Continuous integration (`.github/`).** `ci.yml` has five lane jobs
  (`format`/`lint`/`typecheck`/`build`/`test`), each `node bin/verify.mjs
--group <name>`, plus an `e2e` job (`pnpm build` then `pnpm test:e2e`), a
  `node-current` job (a full `pnpm verify` + `pnpm test:e2e` on whatever
  Node.js currently calls its Current release line, so a drift against the
  pinned `.node-version` surfaces before that line becomes the next LTS --
  a separate job, never a matrix, for the same `gate-lane-parity` reason as
  below), and a `verify` aggregator -- the check the `main` ruleset gates on
  (see CLAUDE.md's "Git Workflow"). The aggregator demands an explicit
  `success` from every lane, since testing only for `failure` reports green
  over a cancelled or skipped one.
- **Two rules keep `gate-lane-parity` (the toolchain grader) working against
  this repo: never name a step id in a workflow** (name a group), **and
  never matrix the lanes** -- `--group ${{ matrix.group }}` reads as
  dynamic, and because the grader concatenates every workflow file into one
  surface, that one line switches the check off for all of them. `pnpm eval`
  never runs in CI (paid model calls). **CodeQL is GitHub-managed default
  setup and has no file in this repo -- do not add a `codeql.yml`**, it
  collides with default setup.
- `bin/check-node-version.mjs` is live here now: every lane that runs the
  pinned toolchain takes Node from `node-version-file: .node-version`;
  `node-current` is the one deliberate, documented exception, and the
  gate's own regex (which only rejects a hardcoded _digit_) already allows
  it. `release.yml` follows the same two rules and adds a third: **it never
  writes the text `verify.mjs`**. The grader reads a workflow as text, so a
  bare or dynamic invocation there switches `gate-lane-parity` off for
  `ci.yml` too -- measured, not assumed: the structural check count drops 42
  to 37 and no finding is raised. Its `pack` job runs `pnpm verify` instead,
  which the scraper cannot see and which is a full run of every group
  anyway.
- Every action in every workflow (including `scorecard.yml`) is pinned by
  commit SHA with a `# vX.Y.Z` comment naming the tag pinned to --
  Dependabot (`.github/dependabot.yml`) opens a PR to move the pin forward,
  the same as it would for a floating tag, so this costs nothing in
  maintenance and closes the "a compromised upstream tag" class of
  supply-chain risk a floating `@v7` doesn't. `scorecard.yml` runs
  `ossf/scorecard-action` weekly (plus on push to `main` and
  `workflow_dispatch`) and publishes results for the README badge; it is
  read-only and not a required check. The README's Socket badge
  (`badge.socket.dev`) is a deliberate complement, not a duplicate: it
  scores the _published package's_ behavior (install scripts, obfuscation,
  requested permissions), where Scorecard scores the _repo's_ practices.
  Bundlephobia and Snyk were considered and rejected: Bundlephobia measures
  browser-bundle size, which doesn't apply to a bin-only CLI with no
  importable entry point (see `packages/cli/package.json`'s `exports`), and
  Snyk overlaps with both Socket and `dependency-review.yml`/Dependabot for
  a package that has zero runtime dependencies to begin with -- one
  vulnerability-scanning badge is enough. `gitleaks.yml` runs
  `gitleaks/gitleaks-action` (secret scanning) on the same
  push/PR/weekly/dispatch shape as `scorecard.yml`, and is not a required
  check today (see CLAUDE.md's "Known gaps" -- adding it to `main`'s
  ruleset needs at least one successful run on `main` first). Its
  `GITLEAKS_VERSION` is pinned above the action's own stale built-in
  default and Dependabot doesn't track it, so bump it by hand periodically;
  `GITLEAKS_LICENSE` (a free org license, required because this repo is
  org-owned) is an org-level secret set up outside this repo.
- **`claude.yml` and `claude-pr-review.yml` run Anthropic's official
  `anthropics/claude-code-action`** (SHA-pinned, same convention as every
  other action here), both running but failing cleanly on an auth error
  until the one-time setup below is done. `claude.yml` is interactive
  `@claude`-mention mode: it never opens a PR itself (it commits to a
  branch and links back to a PR-creation page), so it never bypasses the
  human-opened-PR rule above. `claude-pr-review.yml` reviews every
  opened/updated PR with `contents: read` only -- Claude posts a comment,
  it cannot push code, submit a formal GitHub review, or approve a PR, so
  it cannot satisfy or bypass `main`'s required checks or its 0-approval
  rule either way.
- `claude-pr-review.yml` pins `claude_args: --model claude-opus-5-5
--fallback-model claude-sonnet-5` (there is no `model:`/`fallback_model:`
  input -- both are deprecated action inputs, per claude-code-action's own
  docs/usage.md, in favor of configuring both through `claude_args`);
  `claude.yml` is left on the action's default. Two reasons for pinning at
  all, not one: no official source states whether the action's undocumented
  default can change silently between action releases, which matters for an
  unattended, repeated job the way it doesn't for `claude.yml`'s
  interactive, humanly-invoked sessions; and Opus 5.5 is Anthropic's own
  explicit recommendation for agentic code review specifically (a
  third-party eval measured a 72% known-bug catch rate against the prior
  Opus generation's 56%, with fewer false alarms). The fallback only
  triggers on an overload/unavailable/non-retryable-server-error response,
  never on an auth, billing, rate-limit, or policy failure -- a real,
  currently-unfixed gap (anthropics/claude-code-action#594, redirected to
  and auto-closed `not_planned` as anthropics/claude-code#8413) -- but it's
  worth having for the failure mode it does cover, and Sonnet 5 is a
  separate model pool from Opus so it isn't overloaded by the same demand
  spike.
- `claude_args` also carries an explicit `--allowedTools` naming
  `mcp__github_inline_comment__create_inline_comment` and `gh pr comment`/
  `diff`/`view` -- load-bearing, not decorative: the action's automation
  mode (a `prompt` input, no `track_progress`) only sends a review's
  findings to the PR through a tool Claude is actually granted, per
  Anthropic's own docs/en/github-actions, and omitting the allowlist fails
  silently and green -- five runs of an earlier version of this workflow
  each completed successfully with real turns and spend but left only a
  placeholder comment on the PR, no review content at all.
  `claude-pr-review.yml`'s own `if:` excludes bot-authored PRs (the
  changesets version-PR, Dependabot) and fork PRs explicitly, rather than
  relying on the action's own internal bot/permission checks, so a run
  that would just fail on missing secrets never starts -- the fork-PR half
  of that check is now also backstopped by CLAUDE.md's "Git Workflow"
  collaborators-only pull request policy, but the explicit `if:` stays as
  defense in depth. `claude.yml` has no PR to gate (it only triggers on
  issues and comments, which stay open to everyone even under
  collaborators-only PRs), so its `if:` instead requires the triggering
  actor's `author_association` to be `OWNER`, `MEMBER` or `COLLABORATOR`.
- **One-time setup, done by hand:** install the [Claude GitHub
  App](https://github.com/apps/claude), then `claude setup-token` locally
  and `gh secret set CLAUDE_CODE_OAUTH_TOKEN` -- this repo uses a Claude
  subscription's OAuth token, not a stored API key or Workload Identity
  Federation. `templates/packs/github` ships the mention-mode
  workflow as an optional pack for bootstrapped projects, defaulting to a
  stored API key instead (the more universal choice for a project of
  unknown ownership) with the other two auth options documented as
  comments in the file.
