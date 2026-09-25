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

## Response process

1. **Acknowledge** the report within 7 days (see above).
2. **Triage**: confirm reproduction, assess severity and scope (this repo
   vs. what it emits into a bootstrapped project -- see "Scope" above).
3. **Fix privately** on a branch, via a GitHub security advisory. A medium-
   or-higher-severity, confirmed vulnerability gets a fix within 60 days of
   confirmation.
4. **Request a CVE** through the advisory (GHSA) when the issue warrants
   one.
5. **Release** the fix -- see [`CLAUDE.md`](CLAUDE.md#releases) -- then
   **publish the advisory**, crediting the reporter (see below) unless they
   ask not to be.

## Credit

A reporter of a vulnerability that's fixed and disclosed is credited in the
GitHub Security Advisory and the affected package's changelog entry,
unless they ask to stay anonymous. There is no bug bounty.

## What you can and cannot expect

**What this tool guarantees:** Phase A (`packages/cli`) runs fully offline
except for the `pnpm install` it triggers at the end of fresh mode; it
makes no other network call, executes no code from a target project it's
surveying (adopt mode reads project files as data only -- see
[`docs/assurance-case.md`](docs/assurance-case.md)), and has zero runtime
dependencies of its own. Releases carry npm provenance and a Sigstore
build-provenance attestation you can verify (see "Verifying releases"
below).

**What it does not guarantee:** it does not vet the dependencies your
bootstrapped project chooses to add, and `/customize` (Phase B) is an LLM
acting inside your own Claude Code session with whatever tools that session
has -- its guardrails (showing evidence, confirming changes before writing)
are behavioral, not sandboxed. A project this tool bootstraps or adopts is
yours to secure; this policy covers defects in the tool itself, not choices
made on your behalf during an interview or a guidance sweep.

## Verifying releases

`@monte3l/groundwork` ships with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
(no long-lived signing key -- it's a Sigstore-backed, OIDC-issued
attestation tied to the exact `release.yml` run that built it) and a
build-provenance attestation attached to the matching GitHub Release.

```bash
# Verify the registry signature and provenance for an installed version
npm audit signatures

# Verify the release asset's build-provenance attestation
gh attestation verify <path-to-downloaded-tarball> \
  --repo monte3l/m3l-groundwork \
  --signer-workflow monte3l/m3l-groundwork/.github/workflows/release.yml
```

Both should report an identity of
`https://github.com/monte3l/m3l-groundwork/.github/workflows/release.yml@refs/heads/main`,
issued by `https://token.actions.githubusercontent.com`. There is
intentionally no other key to distribute or compare against.

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

One finding is a genuine, but external, gap: this project hasn't yet
registered for an [OpenSSF Best Practices badge](https://www.bestpractices.dev/)
(`CIIBestPracticesID`). The repository is intended to meet the Silver
criteria -- governance, roles and access continuity
([`GOVERNANCE.md`](GOVERNANCE.md)), a roadmap ([`ROADMAP.md`](ROADMAP.md)),
a documented architecture and this security policy, a security assurance
case ([`docs/assurance-case.md`](docs/assurance-case.md)), DCO-signed
commits, strict linting, signed and attested releases, and CLI input
validation -- but registering is a maintainer action (an account and a
self-assessment questionnaire on bestpractices.dev), not something a code
change can complete on its own.

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
