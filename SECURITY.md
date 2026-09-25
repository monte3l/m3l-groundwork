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
