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

`npm audit signatures` confirms the registry signature and provenance
attestation both check out. `gh attestation verify` additionally prints the
signer's identity, which should read
`https://github.com/monte3l/m3l-groundwork/.github/workflows/release.yml@refs/heads/main`,
issued by `https://token.actions.githubusercontent.com`. There is
intentionally no other key to distribute or compare against.

In plain terms: a successful verification means both commands exit
without error and print that identity -- proof the package or tarball you
have really was built by this repository's own `release.yml` workflow, not
substituted or tampered with afterward. If either command errors, or
reports a different identity, treat the artifact as unverified and do not
install or use it.

### Reproducing a release

The build is reproducible: two independent, clean builds of the same source
produce byte-identical tarballs (`pack.e2e.test.ts`'s reproducible-build
case checks this -- it's excluded from the fast default `pnpm test` run like
every other `*.e2e.test.ts` file, but CI's `e2e` job runs it on every push
and PR via `pnpm test:e2e`, and `release.yml`'s `pack` job re-runs it before
every release, not only at release time). To confirm a published release
yourself:

```bash
git checkout <tag>          # e.g. @monte3l/groundwork@1.0.0-rc.N
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @monte3l/groundwork pack
shasum -a 256 packages/cli/*.tgz
```

Compare the resulting SHA-256 against the tarball attached to the matching
[GitHub Release](https://github.com/monte3l/m3l-groundwork/releases) -- the
same artifact `gh attestation verify` above checks the provenance of. A
match means the release you're installing was built from exactly the source
at that tag, with nothing added or substituted in between.

## Dynamic analysis

Property-based tests (`fast-check`, files named `*.property.test.ts`) run
inside `pnpm test` -- on every push, every PR, and in `release.yml`'s `pack`
job before any release ships. They exercise the CLI's parsers and boundary
logic (JSONC parsing, token substitution, the dotfile-escaping map, the
pack-merge functions) across their full input domain, generated rather than
hand-picked, and differentially fuzz the harness grader's TypeScript
`frontmatter.ts` implementation against its emitted JavaScript twin (the
toolchain grader's own property tests check it never throws and degrades to
`{checked:0}` rather than guessing, not a twin diff -- see
[`docs/security-review.md`](docs/security-review.md) for the distinction).
`node:assert` invariants at the trust boundaries named in
[`docs/assurance-case.md`](docs/assurance-case.md) run live whenever the
guarded code path executes -- in these property tests, in the rest of
`pnpm test`'s example-based suite, and in the e2e suite -- so a violation
fails the build rather than passing silently. See
[`docs/security-review.md`](docs/security-review.md) for the full write-up.

## What this is not

This policy is about vulnerabilities in the tool itself: how it parses
input, what it writes to disk, what it runs (`pnpm install`, `git init`,
`claude plugin eval`), and how it publishes releases. It isn't the place
to report a vulnerability in a dependency your bootstrapped project picked
up -- report that upstream, or to GitHub's Dependabot alerts on your own
repo.

## Accepted OpenSSF Scorecard findings

_Background, not core policy: this section explains automated scoring
context for anyone who looks up this repo's Scorecard results. Nothing
here changes the reporting or response process described above._

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
- **Fuzzing** (no OSS-Fuzz integration): Scorecard's `Fuzzing` check looks
  specifically for OSS-Fuzz/ClusterFuzzLite integration or a handful of
  recognized fuzzing harnesses, none of which fits a CLI with no
  long-running network-facing service. This project does apply dynamic
  analysis -- property-based tests via `fast-check`, run on every push, PR,
  and pre-release build (see "Dynamic analysis" above and
  [`docs/security-review.md`](docs/security-review.md)) -- Scorecard's
  heuristic simply doesn't recognize that shape of tool.
- **Maintained** (repository age): purely time-based (Scorecard checks
  whether a repo is older than 90 days); it self-resolves and needs no
  action.

One finding is a genuine, but external, gap: this project hasn't yet
registered for an [OpenSSF Best Practices badge](https://www.bestpractices.dev/)
(`CIIBestPracticesID`). The repository is intended to meet the Gold
criteria, excluding the handful that inherently require more than one active
contributor (`bus_factor`, `contributors_unassociated`, `two_person_review`
-- see [`GOVERNANCE.md`](GOVERNANCE.md#bus-factor), stated honestly as unmet
rather than worked around) -- governance, roles and access continuity
([`GOVERNANCE.md`](GOVERNANCE.md)), a roadmap ([`ROADMAP.md`](ROADMAP.md)),
a documented architecture, this security policy, a per-file
copyright/license statement (`REUSE.toml` plus inline SPDX headers -- see
`CLAUDE.md`'s "Definition of Done"), a 90%/80% statement/branch coverage
gate, a reproducible build, dynamic analysis, a dated security review
([`docs/security-review.md`](docs/security-review.md)), a security assurance
case ([`docs/assurance-case.md`](docs/assurance-case.md)), DCO-signed
commits, strict linting, signed and attested releases, and CLI input
validation -- but registering is a maintainer action (an account and a
self-assessment questionnaire on bestpractices.dev), not something a code
change can complete on its own.

## Reading the Socket score

_Background, not core policy: same as the Scorecard section above -- this
explains a third-party badge, not this project's vulnerability response._

The README's [Socket](https://socket.dev) badge scores five categories
(Supply Chain Security, Quality, Maintenance, Vulnerability, License).
Two of those are structurally suppressed for a package this new and this
small, independent of any actual defect, and should not be chased with a
design change:

- **Supply Chain Security and Maintenance** scale with download count,
  account age, and publish history -- a package with only a small number of
  releases so far can't score as high as an established one on these axes
  yet, the same way OpenSSF Scorecard's `Maintained` check flags any
  repository under 90 days old. This self-corrects with adoption and time;
  there is no action to take against it. (Check
  [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md) for the current
  release count rather than hardcoding a number here, which would only go
  stale again.)
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
