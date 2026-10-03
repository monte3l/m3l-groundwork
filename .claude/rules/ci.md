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
--group <name>`, plus an `e2e` job (`pnpm build` then `pnpm test:e2e`), an
  `e2e-macos` job (the identical invocation on `macos-latest` -- a separate
  job, never an `os` matrix, on the same `.node-version` pin), a
  `node-current` job (a full `pnpm verify` + `pnpm test:e2e` on whatever
  Node.js currently calls its Current release line, so a drift against the
  pinned `.node-version` surfaces before that line becomes the next LTS --
  a separate job, never a matrix, for the same `gate-lane-parity` reason as
  below), and a `verify` aggregator (which `needs` all of them) -- the check the `main` ruleset gates on
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
- `security-audit.yml` runs `pnpm audit --audit-level=high` daily (and on
  dispatch) and opens one `security`-labelled issue if it fails. Root
  Dependabot has npm updates off on purpose and Dependency Review only sees
  what a PR changes, so this is the only thing that notices an advisory
  published against an already-locked dependency. It mirrors the workflow
  `templates/core` emits, at the root's own `pnpm/action-setup` pin.
- **`claude.yml` runs Anthropic's official `anthropics/claude-code-action`**
  (SHA-pinned, same convention as every other action here), running but
  failing cleanly on an auth error until the one-time setup below is done.
  It is interactive `@claude`-mention mode: it never opens a PR itself (it
  commits to a branch and links back to a PR-creation page), so it never
  bypasses the human-opened-PR rule above.
- **There is deliberately no automated PR review workflow.** The root
  `claude-pr-review.yml` (Anthropic's documented "Run a skill" review, the
  `code-review@claude-code-plugins` plugin posting as `claude[bot]`) was
  removed on 2026-10-03, to stay out until Anthropic fixes the bug it kept
  hitting: a green run that posts nothing is claude-code-action#1646 (this
  exact plugin and action pairing), #1499, #1852, #1523, #1679 and #1823, all
  open with no Anthropic reply and no official workaround as of 2026-10-02.
  The plugin backgrounds its sub-reviewers and the action ends the session at
  the first `result`. The last version carried three mitigations that only
  reduced it (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `Bash(gh pr
comment:*)` in `--allowedTools`, and a `Verify Claude posted` step failing
  the job when `claude[bot]` had posted nothing) and it posted as the Claude
  GitHub App, never approving or blocking, so no ruleset check ever depended
  on it. To restore it, take the file from git history (`git log --diff-filter=D
-- .github/workflows/claude-pr-review.yml`), re-check those issues first,
  and re-add the references this change removed from `CLAUDE.md`,
  `CONTRIBUTING.md` and `docs/assurance-case.md`. The `github` pack still
  ships its own `claude-pr-review.yml` twin to bootstrapped projects; that is
  deliberately unchanged here.
- `claude.yml` has no PR to gate (it only triggers on
  issues and comments, which stay open to everyone even under
  collaborators-only PRs), so its `if:` instead requires the triggering
  actor's `author_association` to be `OWNER`, `MEMBER` or `COLLABORATOR`.
- **One-time setup, done by hand:** install the [Claude GitHub
  App](https://github.com/apps/claude), then `claude setup-token` locally
  and `gh secret set CLAUDE_CODE_OAUTH_TOKEN` -- this repo uses a Claude
  subscription's OAuth token, not a stored API key or Workload Identity
  Federation. `templates/packs/github` ships both the mention-mode workflow
  and a generalized `claude-pr-review.yml` twin (plus three `gh`-CLI skills)
  as an optional pack for bootstrapped projects, defaulting to a stored API
  key instead (the more universal choice for a project of unknown
  ownership) with the other two auth options documented as comments in the
  file.
