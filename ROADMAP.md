# Roadmap

What this project intends to do, and not do, over roughly the next year.
Kept in one file rather than GitHub Issues/Projects so it survives outside
any one tool -- see `documentation_roadmap` in the
[OpenSSF Best Practices badge](https://www.bestpractices.dev/) criteria.
This file lists what is still ahead; what has shipped is in the git history
and the GitHub Releases.

## Now: the 1.0 series

The public API has been frozen since the first `1.0.0-rc`
(see the README's ["Versioning policy"](README.md#versioning-policy)), and
`1.0.0` shipped it unchanged. The series is at `1.0.4`. Only `patch`
[changesets](docs/glossary.md#changeset) land in it, so anything that adds a
CLI flag or mode waits for a `1.1` release (see
[`.claude/rules/releases.md`](.claude/rules/releases.md), which
[`CLAUDE.md`](CLAUDE.md#releases) summarises).

## Next 12 months

- **A standalone "add a pack" mode, targeted at 1.1.** Today, adding an
  optional pack to an already-bootstrapped project means re-running the CLI
  (auto-detected as adopt mode) and then `/customize`. A dedicated
  additive-install flag is real, planned work, and it extends adopt mode's
  survey-only contract rather than loosening it -- see
  [`CLAUDE.md`](CLAUDE.md#known-gaps-deliberately-out-of-scope-so-far).
- **Growing the bus factor past 1.** See [`GOVERNANCE.md`](GOVERNANCE.md#bus-factor).
  A second org owner already approves and merges every pull request, and the
  `main` ruleset requires it, so `two_person_review` closes on its own as
  reviewed changes outnumber older ones. The other two criteria need people,
  not code: `bus_factor` needs a second maintainer who takes on release and
  security-response duties (and npm access, which no one else holds), and
  `contributors_unassociated` needs significant contributors from outside the
  organization. No committed timeline. See
  [`GOVERNANCE.md`](GOVERNANCE.md#gold-level-criteria-this-project-does-not-meet).
- **`pnpm/setup` in CI.** Its v3 reads Node's version from `.node-version`
  through a `node-version-file` input, so the original blocker is gone. What
  is left is reliability and trust surface: v3 is new with open hang and
  network-failure issues, it provisions Node through `pnpm runtime set` in
  the publish jobs that hold the OIDC token, and it needs pnpm 11 or newer.
  Migration waits for those to settle. The old tracking issue is closed, so
  the re-check needs a new one -- see
  [`CLAUDE.md`](CLAUDE.md#known-gaps-deliberately-out-of-scope-so-far).
- **Automated PR review, only if it can be made reliable.** This repository
  has none: the `claude-code-action` workflow was removed because it could
  finish green without posting anything (see
  [`.claude/rules/ci.md`](.claude/rules/ci.md)). The candidate replacement is
  a manually dispatched workflow that runs the Claude Code CLI's
  `/code-review` directly, not through that action. It is unproven. It goes
  ahead only if it posts reliably, its per-review cost is acceptable, and it
  fails the job when nothing was posted. It will never be a required check.
  The `claude-github` pack's own review workflow is a separate implementation and
  is not affected.
- Keeping `templates/core` and `templates/packs/` current against upstream
  TypeScript and Anthropic guidance is ongoing, ordinary maintenance, not a
  one-time milestone -- see `docs/research/*.md` and the `typescript-guidance`
  / `harness-guidance` skills.

## What this project will not do

- **Add a runtime dependency to `packages/cli`** without a very strong
  reason (see [`CLAUDE.md`](CLAUDE.md#architecture-notes)). The CLI's zero-
  dependency, offline-except-for-`pnpm install` design is a hard constraint,
  not a style preference, and every roadmap item above is expected to
  respect it.
- **Add a templating engine.** Token substitution stays a plain, auditable
  string replace (`packages/cli/src/tokens.ts`) -- see `CLAUDE.md`'s
  "Architecture notes" and `tokens.ts`'s own header comment.
- **Publish `@monte3l/groundwork-plugin` to npm.** It ships only through the
  Claude Code marketplace; see the README's ["Releasing"](README.md#releasing)
  section for why.
- **Let adopt mode write project files directly.** Its contract --
  survey-only, `.groundwork/` plus a guarded copy of `/customize` -- is
  load-bearing and asserted by `adopt.e2e.test.ts`; every future adopt-mode
  feature (including the additive-pack-install mode above) extends that
  contract rather than weakening it.
- **Chase a generic npm-package-quality heuristic that doesn't fit a CLI**
  (a fake `types`/`exports["."]` entry, for example) -- see `SECURITY.md`'s
  note on the Socket score for the reasoning already applied once.
