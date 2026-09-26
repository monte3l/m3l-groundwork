# Governance

**In short:** one person, the maintainer, makes every decision on this
project -- there's no committee or vote. What keeps that safe for
contributors and users is process, not trust: every change (including the
maintainer's own) still has to pass through the same required checks and
signed-commit rule before it can reach `main`, and a release still needs a
separate, non-automatable approval before it's installable. The rest of
this document spells out exactly what that means and what happens if the
maintainer becomes unavailable.

This project follows a **BDFL-style, single-maintainer** governance model
-- "BDFL" stands for Benevolent Dictator For Life, a term for a single
person who has final say over a project's direction, borrowed from
open-source projects like Python's that used it for their original creator.
Here it means: one maintainer, no vote, no board. This document exists to
satisfy the [OpenSSF Best Practices badge](https://www.bestpractices.dev/)'s
Silver-level `governance`, `roles_responsibilities` and `access_continuity`
criteria, and to give an honest account of the three Gold-level criteria
this project cannot meet with one active maintainer (`bus_factor`,
`contributors_unassociated`, `two_person_review` -- see "Gold-level criteria
this project does not meet" below) rather than an aspirational one.

## Decision-making

- **Day-to-day changes** (bug fixes, docs, dependency bumps, most features)
  are decided by the maintainer, usually while reviewing the pull request
  that proposes them. There is no separate approval step beyond the branch
  ruleset's required checks (see [`CLAUDE.md`](CLAUDE.md#git-workflow)).
  A single maintainer cannot require a second approval on their own PR.
  Requiring one would only force a standing ruleset bypass, and the empty
  `bypass_actors` list is deliberately designed to avoid exactly that.
- **Larger or breaking changes** (anything that touches the public API
  frozen in the README's ["Versioning policy"](README.md#versioning-policy),
  a change to `templates/core`'s caps, or a new `templates/packs/` pack) are
  discussed in an issue before a PR is opened, so the reasoning is public
  and searchable even though only one person is deciding.
- **Disputes**: with one maintainer there is no standing conflict to
  resolve. A contributor who disagrees with a decision can reopen the
  discussion in the issue or PR; the maintainer has final say.
- **Security decisions** (accepting or dismissing a Scorecard finding,
  triaging a vulnerability report) follow [`SECURITY.md`](SECURITY.md).

## Roles

Two release-specific terms recur in the table below. The **`npm-publish`
environment** is a GitHub-configured gate on the release workflow: it
pauses the job that would publish until a required reviewer approves it.
**`npm stage approve`** is a separate, npm-side step (2FA-protected) that
turns an already-staged package version into one people can actually
install. Both exist so that publishing a release always needs a live,
non-automatable human action -- see [`CLAUDE.md`](CLAUDE.md#releases) for
the full mechanics.

| Role                 | Held by                                                                                                           | Responsibilities                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maintainer**       | [Enrico Lionello](https://github.com/enri3l), GitHub org owner                                                    | Reviews and merges PRs, triages issues, makes release and design decisions, holds the `npm-publish` environment's required-reviewer approval and the `npm stage approve` 2FA step. |
| **Security contact** | The maintainer                                                                                                    | Receives and triages reports via [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability); follows the [response process](SECURITY.md#response-process).           |
| **Release approver** | The maintainer                                                                                                    | Approves the `npm-publish` deployment gate and runs `npm stage approve` after a staged publish (see [`CLAUDE.md`](CLAUDE.md#releases)) -- neither step is automatable by design.   |
| **Contributor**      | Anyone opening an issue (pull requests are collaborators-only, see [`CONTRIBUTING.md`](CONTRIBUTING.md#workflow)) | Follows [`CONTRIBUTING.md`](CONTRIBUTING.md); has no merge or release authority.                                                                                                   |

Adding a second maintainer means, at minimum: a GitHub org owner invite, npm
package-maintainer access on `@monte3l/groundwork`, and a reviewer seat on
the `npm-publish` GitHub environment. The first and third are done:
[giulmonte](https://github.com/giulmonte) is a `monte3l` org owner and a
required reviewer on `npm-publish` alongside the maintainer. npm
package-maintainer access is not -- see "Bus factor" below.

## Access continuity

If the maintainer becomes unavailable, the project must still be able to
triage issues, merge PRs, and cut a release within about a week. What that
depends on, concretely:

- **GitHub org ownership** -- controls the `main` branch ruleset, repo
  secrets (`APP_CLIENT_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`),
  the `npm-publish` environment's reviewer list, and the GitHub App
  installation the release workflow's `version` job uses. A second org
  owner already holds this independently -- see "Roles" above.
- **npm package ownership** on `@monte3l/groundwork`, plus the account
  holding 2FA for `npm stage approve`. Unlike GitHub, this is not
  independently held by a second person today -- recovering it depends on
  the maintainer's own npm account, which is exactly what the kit below
  covers.
- **The maintainer's GPG signing key** -- `main`'s ruleset requires signed
  commits (see [`CLAUDE.md`](CLAUDE.md#git-workflow)); losing it without a
  successor key blocks every future commit to `main` until a new key is
  configured (which anyone with org-owner access can do -- signing is
  machine-local, not tied to a specific person's identity beyond the
  commit's author line).

The plan for continuity is a maintainer-held **emergency access kit**.
It holds GitHub and npm account recovery codes, plus the GPG key's
revocation certificate and a backup of the key itself. It's held in a
password manager's emergency-access feature, or an equivalent sealed,
offline copy. It has a designated executor, but that person isn't named in
this file, for the same reason the kit's contents aren't described here
either: this is a public repository, and naming a person or storing a
secret here would defeat the purpose. Recovery, should it be needed, uses
ordinary GitHub and npm account-recovery flows, plus `gh api` calls against
this repo's ruleset and environment. Both of those are documented already,
in [`CLAUDE.md`](CLAUDE.md#git-workflow) and [`CLAUDE.md`](CLAUDE.md#releases)
respectively -- nothing here depends on undocumented tribal knowledge.

This satisfies the badge's `access_continuity` criterion, which explicitly
allows a solo-maintainer project to rely on "keys in a lockbox and a will"
rather than requiring a second active maintainer.

## Bus factor

Today's bus factor is **1** -- this is a single-maintainer project, stated
plainly rather than inflated. A second person already holds real GitHub
access (see "Roles" above), but has never reviewed, merged, or released
anything, and holds no npm access at all -- access alone doesn't make an
active co-maintainer. Growing past 1 is on the [roadmap](ROADMAP.md).

## Gold-level criteria this project does not meet

Three of the OpenSSF Best Practices badge's Gold-level criteria are
structurally impossible to meet honestly with a single active maintainer, no
matter how the project is otherwise run. Each is recorded as **Unmet** in
`.bestpractices.json` rather than argued around:

- **`bus_factor` (MUST at Gold, requiring 2 or more).** See above -- today's
  bus factor is 1.
- **`contributors_unassociated` (MUST, requiring at least two significant
  contributors not affiliated with the same organization).** All
  non-trivial contribution to date is from the maintainer.
- **`two_person_review` (MUST, requiring at least 50% of changes reviewed by
  someone other than the author before release).** With one maintainer, no
  proposed change can be reviewed by a second human before it's merged and
  released -- `claude-pr-review.yml`'s automated comment (see
  [`CONTRIBUTING.md`](CONTRIBUTING.md#code-review)) is real review signal,
  but the criterion's own wording asks for "a person other than the
  author," and an automated tool review isn't a substitute for that.

Every other Gold-level criterion is met or is not applicable to this
project -- see `.bestpractices.json` for the full, itemized self-assessment.
Closing these three depends on finding and onboarding a genuine second
active maintainer (see [`ROADMAP.md`](ROADMAP.md)), not on a code or process
change.
