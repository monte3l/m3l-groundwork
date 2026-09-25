# Security Policy

## Scope

This covers `@monte3l/groundwork` (the CLI, `packages/cli`), the
`/customize` plugin (`packages/plugin`), and the baseline the CLI emits
(`templates/core/`, `templates/packs/`). A vulnerability in generated
project code counts only if it comes from a defect in this repo's
templates or generation logic, not from a choice the interviewer or
`/customize` made on your behalf.

## Supported versions

| Version                                                  | Supported        |
| -------------------------------------------------------- | ---------------- |
| Latest `1.x` release                                     | Yes              |
| Latest prerelease (`-rc`/`-next`, while no `1.x` exists) | Yes, best effort |
| `0.0.0` (npm placeholder)                                | No               |
| Anything else                                            | No               |

Only the latest release in a supported line gets a fix. This is a
single-maintainer project; there is no backport policy across major
versions yet.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/monte3l/m3l-groundwork/security/advisories/new)
for this repository. Do not open a public issue for a suspected
vulnerability.

Include what you'd include in any good bug report: affected version,
reproduction steps, and the impact you think it has. If it's specific to
what the CLI or `/customize` emits into a bootstrapped project, say which
file or gate.

You should get an acknowledgment within 7 days. There's no fixed
disclosure timeline beyond that -- it depends on severity and whether a fix
needs a major-version change to the CLI's public API (see
[`CLAUDE.md`](CLAUDE.md) and the README's versioning policy) -- but you'll
hear back before a fix ships.

## What this is not

This policy is about vulnerabilities in the tool itself: how it parses
input, what it writes to disk, what it runs (`pnpm install`, `git init`,
`claude plugin eval`), and how it publishes releases. It isn't the place
to report a vulnerability in a dependency your bootstrapped project picked
up -- report that upstream, or to GitHub's Dependabot alerts on your own
repo.

## Accepted OpenSSF Scorecard findings

`scorecard.yml` runs weekly and surfaces its findings as GitHub Code
Scanning alerts. Some are dismissed as deliberate, documented trade-offs
rather than defects -- don't re-open these by "fixing" them into a
standing bypass that undermines the design:

- **Branch-Protection / Code-Review** (0 required approvals on `main`): a
  single-maintainer project can't require an approval on its own PR
  without a standing bypass, which the `main` ruleset's empty
  `bypass_actors` list is deliberately designed to avoid. See
  [`CLAUDE.md`](CLAUDE.md#git-workflow), "Three choices are deliberate,
  not defaults."
- **Fuzzing** (no OSS-Fuzz integration): this CLI has no untrusted binary
  or network-facing parser of the kind fuzzing targets -- its inputs are
  argv, local JSON/JSONC config, and its own template tree.
- **Maintained** (repository age): purely time-based (Scorecard checks
  whether a repo is older than 90 days); it self-resolves and needs no
  action.

One finding is a genuine, but external, gap: this project hasn't
registered for an [OpenSSF Best Practices badge](https://www.bestpractices.dev/)
yet (`CIIBestPracticesID`). That's a maintainer action (an account and a
self-assessment questionnaire on bestpractices.dev), not something fixed
by a code change.

## Reading the Socket score

The README's [Socket](https://socket.dev) badge scores five categories
(Supply Chain Security, Quality, Maintenance, Vulnerability, License).
Two of those are structurally suppressed for a package this new and this
small, independent of any actual defect, and should not be chased with a
design change:

- **Supply Chain Security and Maintenance** scale with download count,
  account age, and publish history -- a package with only two releases
  can't score as high as an established one on these axes yet, the same
  way OpenSSF Scorecard's `Maintained` check flags any repository under
  90 days old. This self-corrects with adoption and time; there is no
  action to take against it.
- **Quality** partly reflects generic npm-package hygiene heuristics
  (a `types` field, an importable `main`/`exports["."]` entry) that are
  written with a _library_ in mind. `@monte3l/groundwork` deliberately
  has none of those -- it's a CLI, not a library, and removing them was
  a considered breaking change (see the CLI's `CHANGELOG.md`), not an
  oversight. Re-adding a fake type export to satisfy a generic heuristic
  would reintroduce exactly what that change removed. The genuine
  quality signals this project controls -- a real README, a license
  field, a repository link, keywords, zero runtime dependencies -- are
  already all present.
