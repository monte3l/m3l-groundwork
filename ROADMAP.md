---
reviewed: 2026-11-20
---

# Roadmap

What this project intends to do, and not do, over roughly the next year.
Work that can be closed is a GitHub issue, linked from here. What stays true
until something changes is written here, so it survives outside any one tool --
see `documentation_roadmap` in the
[OpenSSF Best Practices badge](https://www.bestpractices.dev/) criteria. The
rule for which goes where is the org's
[tracking policy](https://github.com/monte3l/.github/blob/main/blueprint/tracking.md).
This file lists what is still ahead; what has shipped is in the git history
and the GitHub Releases.

## Now: the 1.x series

The public API has been frozen since the first `1.0.0-rc`
(see the README's ["Versioning policy"](README.md#versioning-policy)), and
`1.0.0` shipped it unchanged. The project follows SemVer from there: `fix`
commits ship as patch releases and backwards-compatible `feat` commits as
minor releases (`1.4.0` is the latest), while a breaking change to the
public API waits for a major release. Which commit type releases what is in
[`.claude/rules/releases.md`](.claude/rules/releases.md), which
[`CLAUDE.md`](CLAUDE.md#releases) summarises.

Adding a pack to an existing project has shipped
([#377](https://github.com/monte3l/m3l-groundwork/issues/377)):
`m3l-groundwork <dir> --add-pack <name>` stages the pack under
`.groundwork/add-pack/<name>/` and installs nothing, and
`/customize add-pack <name>` confirms and installs it, then records it in
`.groundwork/installed-packs.json`. It extends adopt mode's survey-only
contract rather than loosening it; what is left is in
[`docs/known-gaps.md`](docs/known-gaps.md).

Keeping `templates/core` and `templates/packs/` current against upstream
TypeScript and Anthropic guidance is ongoing, ordinary maintenance, not a
one-time milestone -- see `docs/research/*.md` and the `typescript-guidance`
/ `harness-guidance` skills.

## Next 12 months

- **`pnpm/setup` for the rest of CI.** The main lanes moved in
  [#319](https://github.com/monte3l/m3l-groundwork/issues/319). The publish
  jobs, the soak, the two Node-line lanes and the emitted baseline stay on
  `pnpm/action-setup` until the upstream cache and PATH bugs are fixed -- see
  [`docs/known-gaps.md`](docs/known-gaps.md).
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

## Known limits

The detail behind each of these, and the other accepted gaps, is in
[`docs/known-gaps.md`](docs/known-gaps.md).

- **Growing the bus factor past 1 needs people, not code.** See
  [`GOVERNANCE.md`](GOVERNANCE.md#bus-factor). A second org owner already
  approves and merges every pull request, and the `main` ruleset requires it,
  so `two_person_review` closes on its own as reviewed changes outnumber older
  ones. The other two criteria need people: `bus_factor` needs a second
  maintainer who takes on release and security-response duties (and npm
  access, which no one else holds), and `contributors_unassociated` needs
  significant contributors from outside the organization. No committed
  timeline. See
  [`GOVERNANCE.md`](GOVERNANCE.md#gold-level-criteria-this-project-does-not-meet).
- **Adopt mode's post-merge cap counts are an estimate.** They assume no name
  overlap between the baseline's agents, skills and hooks and the project's
  own. That is enough to flag "you may go over budget", and `/customize`'s Step 0
  confirmation settles it.
- **Only a schema 1-4 adopt inventory still reads additions from an absolute
  `templateRoot`.** From schema 5 they are staged and hash-checked, and Step 0
  reports a vanished path and asks for a re-run.
- **This repository's harness does not enforce worktree-only development.** The
  `worktrees` pack ships that, and this repository has not installed it.
- **GitHub settings live outside the repository.** Org-write and secret-write
  actions need a human, so they were applied by hand. The commands are in
  [`docs/github-blueprint.md`](docs/github-blueprint.md).
- **This repository has no automated PR review.** See the candidate above.

## Unverified

| Claim                                                                                                      | Source                                                                       | Date       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| A manually dispatched workflow that runs the Claude Code CLI's `/code-review` directly would post reliably | This roadmap called it unproven. Carried over and not tested for this change | 2026-11-20 |

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
  central `monte3l/m3l-plugins` Claude Code marketplace; see the README's ["Releasing"](README.md#releasing)
  section for why.
- **Let adopt mode write project files directly.** Its contract --
  survey-only, `.groundwork/` plus a guarded copy of `/customize` -- is
  load-bearing and asserted by `adopt.e2e.test.ts`; every future adopt-mode
  feature extends that contract rather than weakening it: `--add-pack`, for
  example, stages only under `.groundwork/add-pack/` and leaves the install
  to `/customize add-pack`.
- **Chase a generic npm-package-quality heuristic that doesn't fit a CLI**
  (a fake `types`/`exports["."]` entry, for example) -- see `SECURITY.md`'s
  note on the Socket score for the reasoning already applied once.
