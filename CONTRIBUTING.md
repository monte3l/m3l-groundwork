# Contributing

This is a single-maintainer project. External contributions are welcome as
issues and pull requests. For how the project is organized -- the two
phases, the packages, what lives where -- start with
[`docs/architecture.md`](docs/architecture.md); it's written for a human
reading the project rather than editing it. [`CLAUDE.md`](CLAUDE.md) is the
deeper, exhaustive reference, but it's written for Claude Code agents
working in this repo, so expect a different register and a lot more detail
than you need for a first PR.

## Prerequisites

- **Node 24+**. `.node-version` is the authority; `check:node-version`
  gates any drift from it in CI.
- **pnpm**, pinned via the `packageManager` field in `package.json` --
  install a matching version with [Corepack](https://nodejs.org/api/corepack.html)
  or your own package manager.
- **A GPG signing key**, configured for commit signing. `main`'s branch
  ruleset requires every commit to be signed; see GitHub's guide on
  [signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits)
  if you haven't set one up before.
- **A DCO sign-off** on every commit. This just means adding a
  `Signed-off-by:` trailer certifying you have the right to submit your
  change -- `git commit -s` adds it for you. See "Developer Certificate of
  Origin" below.
- **Two-factor authentication (2FA) on your GitHub account.** The `monte3l`
  organization requires it for anyone who can push to this repository or
  read a private vulnerability report -- see "Account security" below.

## Setup

```bash
git clone https://github.com/monte3l/m3l-groundwork.git
cd m3l-groundwork
pnpm install
pnpm prepare   # installs lefthook git hooks
```

## Before opening a PR

Run `pnpm verify` -- it's the same aggregator `lefthook`'s `pre-push` hook
and every CI lane run, keyed by group (`format`/`lint`/`typecheck`/`build`/
`test`). If your change touches `packages/cli/src/`, `templates/core/`, or
`packages/plugin/skills/customize/`, also run `pnpm test:e2e` -- it's the
real acceptance test and has caught real bugs unit tests missed (see
[`CLAUDE.md`](CLAUDE.md#testing)).

- **Conventional Commits**, enforced by the `commit-msg` hook. This is the
  same convention `templates/core` emits into every bootstrapped project.
- **Signed commits** -- `main`'s branch ruleset requires them (see
  "Prerequisites" above).
- **A DCO sign-off trailer** on every commit -- `git commit -s`, or add
  `Signed-off-by: Your Name <you@example.com>` yourself. The `commit-msg`
  hook rejects a commit without one; see "Developer Certificate of Origin"
  below.
- **A changeset** (`pnpm changeset`) for any user-visible change to
  `@monte3l/groundwork` (the CLI). The plugin never takes one -- it has no
  release of its own; see ["Releasing"](#releasing) below.
- **Add a `Co-Authored-By:` trailer** if an AI assistant substantially
  helped write the commit.

## Developer Certificate of Origin

By signing off a commit (`git commit -s`), you certify the
[Developer Certificate of Origin](https://developercertificate.org/): that
you wrote the change, or otherwise have the right to submit it under this
project's license. This is enforced locally by `commitlint.config.js`'s
`trailer-exists` rule -- including on a local merge or revert commit made
without `-s`, not just an ordinary commit -- but it isn't re-checked on a
squash merge or the release bot's own commits (neither passes through the
local hook), which is why
[`pull_request_template.md`](.github/pull_request_template.md)'s checklist
also asks for it.

## Coding standards

- **TypeScript**: `strict` plus the extra flags in `tsconfig.base.json`
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, and others -- see the file's own comments).
- **ESLint**: `eslint.config.js`'s flat config, built on
  `typescript-eslint`'s `recommendedTypeChecked` plus this repo's own rules
  (no `any`, no floating promises, exhaustive `switch`, `.js` extensions on
  relative imports, named exports only). `pnpm lint` runs with
  `--max-warnings 0` -- a warning fails the gate the same as an error.
- **Prettier**, for everything, including Markdown and JSON.
- **Conventional Commits** for every commit message (see above).

All four are enforced by `pnpm verify`, the pre-commit/pre-push hooks, and
CI -- there's no separate style review, the tooling is the standard.

## Account security

The `monte3l` GitHub organization requires two-factor authentication for
every member -- changing this repository, or accessing a private
vulnerability report, isn't possible without it. Use an authenticator app
(TOTP) or a hardware security key, not SMS: GitHub supports TOTP directly,
and an SMS-based second factor is unencrypted and doesn't meet this
project's own bar (see the badge's `secure_2FA` criterion). The same applies
to the npm account behind `npm stage approve` during a release -- see
[`CLAUDE.md`](CLAUDE.md#releases).

## Workflow

Every change lands through a pull request -- nobody, maintainer included,
can push directly to `main` (see [`CLAUDE.md`](CLAUDE.md#git-workflow)).
Branch off `main`, keep the PR focused, and make sure CI's `verify`
aggregator, Dependency Review, and CodeQL are all green before asking for a
merge.

## Code review

Every pull request is reviewed before merging -- by the maintainer, and by
[`claude-pr-review.yml`](.github/workflows/claude-pr-review.yml)'s automated
comment on every non-bot, non-fork PR. What review checks:

- **Correctness**: the change does what it says, and new functionality or a
  bug fix comes with tests (see "Scope of a PR" below).
- **Error handling**: no silently swallowed error, no unchained `cause`, no
  optional-chaining that masks a failure that should surface.
- **Security**: input validation at any new boundary, no new runtime
  dependency added without strong justification (see
  [`CLAUDE.md`](CLAUDE.md#architecture-notes)), no new network call, no
  secret written to disk.
- **Documentation drift**: `CLAUDE.md`, `README.md`, and any other doc the
  change touches stay in sync with the code in the same PR.
- **Process**: a changeset for a user-visible CLI change, DCO sign-off, and
  a signed commit (see "Before opening a PR" above).

A PR merges once every required CI check is green and every review thread is
resolved. This project is honest that it does not meet the badge's
`two_person_review` criterion: with one maintainer, no proposed change can
be reviewed by a second human before release -- see
[`GOVERNANCE.md`](GOVERNANCE.md#bus-factor).

## Small tasks for newcomers

Issues labeled [`good first issue`](https://github.com/monte3l/m3l-groundwork/labels/good%20first%20issue)
or [`help wanted`](https://github.com/monte3l/m3l-groundwork/labels/help%20wanted)
are scoped for a first-time or casual contributor -- not necessarily new
functionality; documentation, an added test case, or a small, well-defined
fix all count. If nothing currently open looks approachable, ask in a new
issue and it'll get labeled appropriately.

## Scope of a PR

- **New functionality MUST come with tests.** A change to
  `packages/cli/src/` or `packages/plugin/src/` that adds behavior needs
  tests covering it (see `CLAUDE.md`'s "Testing" and coverage-gate notes).
- **A bug fix MUST add a regression test** that fails against the old code
  and passes against the fix -- not just a fix with no test proving the bug
  is gone.
- A change to `templates/core/` is a change to what every future
  bootstrapped project gets -- it needs `pnpm test:e2e`. If it adds or
  removes a `.claude/` agent, skill, hook, CI workflow, or root
  `package.json` script, the baseline's caps must still hold -- these are
  counted by tests around `packages/cli/src/caps.ts` (`pnpm test`, part of
  `pnpm verify`'s `test` group), not by `pnpm check:harness` or
  `pnpm check:toolchain` -- those two grade the harness and toolchain
  against a rubric, a separate concern from the raw counts.
- A new file under `templates/core/` must be claimed by
  `packages/plugin/src/domain-map.ts`'s glob lists, or
  `domain-map.test.ts` fails on purpose.

## Releasing

`@monte3l/groundwork` is released with [Changesets](https://github.com/changesets/changesets)
and published to npm through trusted publishing (no stored token). A PR
that changes the CLI's user-visible behavior adds a changeset with
`pnpm changeset`. Merging to `main` opens a "Version Packages" PR; merging
that runs the full gate, stages the package with provenance, and creates a
git tag and a GitHub Release -- a maintainer still has to approve the
staged version (2FA, via `npm stage approve`) before it's actually
installable, npm's own recommended flow for trusted publishers.

`@monte3l/groundwork-plugin` is never published to npm -- it ships only
through the Claude Code marketplace (`.claude-plugin/marketplace.json`), so
a change to it is live the moment it lands on `main`; its `plugin.json`
version just tracks the CLI's, for display.

The full design -- why staging is a separate gate from npm's own 2FA step,
the one-time setup it depends on, and the GitHub App used for the version
PR -- is in [`CLAUDE.md`](CLAUDE.md#releases).

## Project docs

- [`GOVERNANCE.md`](GOVERNANCE.md) -- how decisions are made and who holds
  which role.
- [`ROADMAP.md`](ROADMAP.md) -- what's planned, and what's explicitly out
  of scope.
- [`docs/architecture.md`](docs/architecture.md) -- a high-level map of how
  the two phases fit together.
- [`docs/assurance-case.md`](docs/assurance-case.md) -- the threat model
  and security design argument.
- [`docs/glossary.md`](docs/glossary.md) -- plain-English definitions of
  this repo's jargon.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Reporting a security issue

Don't open a public issue -- see [`SECURITY.md`](SECURITY.md).
