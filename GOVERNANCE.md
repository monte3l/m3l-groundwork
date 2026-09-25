# Governance

This project follows a **BDFL-style, single-maintainer** governance model.
It exists to satisfy the [OpenSSF Best Practices badge](https://www.bestpractices.dev/)'s
Silver-level `governance`, `roles_responsibilities`, `access_continuity` and
`bus_factor` criteria with an honest description of how the project
actually runs today, not an aspirational one.

## Decision-making

- **Day-to-day changes** (bug fixes, docs, dependency bumps, most features)
  are decided by the maintainer, usually while reviewing the pull request
  that proposes them. There is no separate approval step beyond the
  branch ruleset's required checks (see [`CLAUDE.md`](CLAUDE.md#git-workflow))
  -- a single maintainer cannot require a second approval on their own PR
  without a standing ruleset bypass, which the empty `bypass_actors` list is
  deliberately designed to avoid.
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

| Role                  | Held by                                                             | Responsibilities                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Maintainer**        | [Enrico Lionello](https://github.com/enri3l), GitHub org owner       | Reviews and merges PRs, triages issues, makes release and design decisions, holds the `npm-publish` environment's required-reviewer approval and the `npm stage approve` 2FA step. |
| **Security contact**  | The maintainer                                                        | Receives and triages reports via [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability); follows the [response process](SECURITY.md#response-process).            |
| **Release approver**  | The maintainer                                                        | Approves the `npm-publish` deployment gate and runs `npm stage approve` after a staged publish (see [`CLAUDE.md`](CLAUDE.md#releases)) -- neither step is automatable by design.     |
| **Contributor**       | Anyone opening an issue or PR                                        | Follows [`CONTRIBUTING.md`](CONTRIBUTING.md); has no merge or release authority.                                                                                                     |

Adding a second maintainer means, at minimum: a GitHub org owner invite, npm
package-maintainer access on `@monte3l/groundwork`, and a reviewer seat on
the `npm-publish` GitHub environment. None of that has happened yet -- see
"Bus factor" below.

## Access continuity

If the maintainer becomes unavailable, the project must still be able to
triage issues, merge PRs, and cut a release within about a week. What that
depends on, concretely:

- **GitHub org ownership** -- controls the `main` branch ruleset, repo
  secrets (`APP_CLIENT_ID`, `APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`),
  the `npm-publish` environment's reviewer list, and the GitHub App
  installation the release workflow's `version` job uses.
- **npm package ownership** on `@monte3l/groundwork`, plus the account
  holding 2FA for `npm stage approve`.
- **The maintainer's GPG signing key** -- `main`'s ruleset requires signed
  commits (see [`CLAUDE.md`](CLAUDE.md#git-workflow)); losing it without a
  successor key blocks every future commit to `main` until a new key is
  configured (which anyone with org-owner access can do -- signing is
  machine-local, not tied to a specific person's identity beyond the
  commit's author line).

The plan for continuity is a maintainer-held **emergency access kit**: GitHub
and npm account recovery codes, and the GPG key's revocation certificate
and backup, held in a password manager's emergency-access feature (or an
equivalent sealed, offline copy) with a designated executor who is not
named in this file for the same reason the kit itself isn't -- this is a
public repository, and naming a person or storing a secret here would
defeat the purpose. Recovery, should it be needed, uses ordinary GitHub and
npm account-recovery flows plus `gh api` calls against this repo's ruleset
and environment (both documented in [`CLAUDE.md`](CLAUDE.md#git-workflow)
and [`CLAUDE.md`](CLAUDE.md#releases)) -- nothing here depends on
undocumented tribal knowledge.

This satisfies the badge's `access_continuity` criterion, which explicitly
allows a solo-maintainer project to rely on "keys in a lockbox and a will"
rather than requiring a second active maintainer.

## Bus factor

Today's bus factor is **1** -- this is a single-maintainer project, stated
plainly rather than inflated. The badge's `bus_factor` criterion is a
SHOULD, not a MUST, precisely for projects in this position. Growing past 1
is on the [roadmap](ROADMAP.md).
