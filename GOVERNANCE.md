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
  are decided by the maintainer, who proposes them as a pull request.
  The branch ruleset requires one approval from someone other than the
  author, besides its required checks (see
  [`CLAUDE.md`](CLAUDE.md#git-workflow)). The two org owners approve each
  other's pull requests, and the empty `bypass_actors` list means no one
  can skip that. If one owner is unavailable, the other cannot merge their
  own pull request until the ruleset is switched to `disabled` and back,
  which GitHub logs.
- **Larger or breaking changes** (anything that touches the public API
  frozen in the README's ["Versioning policy"](README.md#versioning-policy),
  a change to `templates/core`'s caps, or a new `templates/packs/` pack) should
  be discussed in an issue before a PR is opened, especially when someone
  other than the maintainer is involved, so the reasoning is public
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

| Role                 | Held by                                                                                                           | Responsibilities                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maintainer**       | [Enrico Lionello](https://github.com/enri3l), GitHub org owner                                                    | Reviews and merges PRs, triages issues, makes release and design decisions, is a required reviewer on the `npm-publish` environment and holds the `npm stage approve` 2FA step.                                |
| **Security contact** | The maintainer                                                                                                    | Receives and triages reports via [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability); follows the [response process](SECURITY.md#response-process).                                       |
| **Release approver** | A required reviewer on `npm-publish` other than whoever triggered the run (the maintainer or giulmonte)           | Approves the `npm-publish` deployment gate (`prevent_self_review` is on) and runs `npm stage approve` after a staged publish (see [`CLAUDE.md`](CLAUDE.md#releases)) -- neither step is automatable by design. |
| **Contributor**      | Anyone opening an issue (pull requests are collaborators-only, see [`CONTRIBUTING.md`](CONTRIBUTING.md#workflow)) | Follows [`CONTRIBUTING.md`](CONTRIBUTING.md); has no merge or release authority.                                                                                                                               |

Adding a second maintainer means, at minimum: a GitHub org owner invite, npm
package-maintainer access on `@monte3l/groundwork`, and a reviewer seat on
the `npm-publish` GitHub environment. The first and third are done:
[giulmonte](https://github.com/giulmonte) is a `monte3l` org owner and a
required reviewer on `npm-publish` alongside the maintainer. npm
package-maintainer access is not -- see "Bus factor" below.

## Granting access

This is the policy for giving anyone more than read access. It covers
**write or admin access to this repository, membership of the `monte3l`
organization, a seat as a required reviewer on the `npm-publish`
environment, and npm package-maintainer access**. Write access is treated as
access to secrets, because a workflow run from a branch can reach a
repository-level secret.

- **Who decides.** Only an org owner grants access, and the other owner
  agrees first. Nobody else, and no automation, grants or widens it.
- **Review before the grant.** The owner granting access checks both of
  these first, and neither can be skipped:
  - **Track record.** The person has a history of accepted contributions,
    made through issues because pull requests are collaborators-only, or in
    another project the owners can look at.
  - **Identity.** The person's GitHub account has two-factor authentication
    on, and an owner has confirmed who they are through a channel outside
    GitHub, such as their employer, another project's maintainer listing or
    a call. An owner records which check was used in the issue that proposes
    the access.
- **Least privilege.** Access starts at `triage`. It moves to `write` after
  accepted contributions, and to `admin`, org ownership, the `npm-publish`
  reviewer seat or npm access only for a co-maintainer, which needs both
  checks above to be repeated for the wider scope.
- **Secrets.** No credential is shared with a collaborator, in a message or
  a file. The secrets that exist, and where each one is reachable from, are
  listed in [`SECURITY.md`](SECURITY.md#secrets-and-credentials).
- **Revocation.** Either owner can remove access at any time, without the
  other's agreement, and tells the other owner afterwards. Access is
  reviewed at least once a year, and a collaborator with no activity for 12
  months is reduced to `triage` or removed.

Today the people holding access are the two org owners listed under "Roles".
There is no other collaborator. The entry for each future grant is the issue
that proposed it.

## Related repositories

This project is one repository, [`monte3l/m3l-groundwork`](https://github.com/monte3l/m3l-groundwork).
The `@monte3l/groundwork` npm package, its GitHub Release and the
`/customize` plugin are all built from this repository alone. Three other
repositories in the `monte3l` organization are related to it. This is the
list of them, with what each is for and whether anything from it reaches a
release.

| Repository                                                                        | What it is                                                                                                                       | In this project's releases?                                                                                                                                                                               | Status                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [`monte3l/m3l-design`](https://github.com/monte3l/m3l-design)                     | The organization's design system: tokens, components, contrast tables                                                            | Yes, as a copy. It is vendored verbatim under [`design/`](design/README.md), and the CLI's terminal colors in `packages/cli/src/palette.ts` are generated from the vendored tokens. There is no live link | `v1.0.0` released and vendored |
| [`monte3l/.github`](https://github.com/monte3l/.github)                           | The organization's defaults: community health files, issue and PR templates, workflow templates, a repository settings blueprint | No. Nothing from it is built into a release. Its repository baseline script only checks this repository's settings                                                                                        | No releases                    |
| [`monte3l/m3l-prompt-optimizer`](https://github.com/monte3l/m3l-prompt-optimizer) | A separate Claude Code plugin that refines the prompts a user types                                                              | No. This repository neither depends on it nor ships it                                                                                                                                                    | Separate project               |

The vendored copy of `m3l-design` is the only code from another `monte3l`
repository that ends up in a release. Its `design/source/` is never
hand-edited here: it moves to a new release only through
`bin/sync-design.sh`, as [`design/README.md`](design/README.md) describes.

## Access continuity

If the maintainer becomes unavailable, the project must still be able to
triage issues, merge PRs, and cut a release within about a week. What that
depends on, concretely:

- **GitHub org ownership** -- controls the `main` branch ruleset, repo
  secrets (repo: `RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`; `docs-cloudflare`
  environment: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; org:
  `GITLEAKS_LICENSE`, `JANITOR_APP_CLIENT_ID`, `JANITOR_APP_PRIVATE_KEY`), the `npm-publish`
  environment's reviewer list, and the two GitHub App installations
  (the release workflow's `version` job, and the environment-cleanup
  workflow -- see `docs/environment-janitor.md`). A second org owner
  already holds this independently -- see "Roles" above.
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
access (see "Roles" above), and has merged pull requests (the merges of
#198 to #209 in the git history) and approved `npm-publish` deployments, but
holds no npm access at all. That person approves and merges the
maintainer's pull requests, and the ruleset now requires it, but access and
review alone don't make an active co-maintainer. Growing past 1 is on the [roadmap](ROADMAP.md).

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
  someone other than the author before release).** The ruleset now requires
  one approval from a person other than the author, so every new change
  meets this. The criterion counts changes, though, and most of the history
  predates the rule: 17 of the last 60 merged pull requests carry such an
  approval. It stays **Unmet** until the majority of recent changes do, and
  an automated tool review is not a substitute for a person (see
  [`CONTRIBUTING.md`](CONTRIBUTING.md#code-review) for the review this
  project does run). It also depends on the second owner staying active,
  which is the bus-factor question below.

`version_tags_signed` (SUGGESTED, not a MUST) is also recorded as **Unmet**:
changesets creates the release tags and they are unsigned, though the
commits they point at are GPG-signed.

Every other Gold-level criterion is met or is not applicable to this
project -- see `.bestpractices.json` for the full, itemized self-assessment.
These three do not close the same way, and a second active maintainer from
inside the organization closes only two of them.

- **`two_person_review`** closes with time. The ruleset requires one approval
  from a code owner other than the author, so every new change is reviewed, and
  the criterion clears once most recent changes carry one.
- **`bus_factor`** closes when the second owner can run the project without
  the maintainer: npm package-maintainer access, driving a release end to end,
  and authoring changes. Review access alone does not do it.
- **`contributors_unassociated`** does not close that way. It asks for two
  significant contributors who are not paid by the same organization, and both
  people who hold access here belong to the `monte3l` organization. They are
  treated as associated, so more contribution from either of them leaves it
  **Unmet**. It needs a significant contributor from outside `monte3l`.

Onboarding a genuine second maintainer and an outside contributor is what
closes these (see [`ROADMAP.md`](ROADMAP.md)), not a code or process change.
