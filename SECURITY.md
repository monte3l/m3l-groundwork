# Security Policy

## Scope

This covers `@monte3l/groundwork` (the CLI, `packages/cli`), the
`/customize` plugin (`packages/plugin`), and the baseline the CLI emits
(`templates/core/`, `templates/packs/`). A vulnerability in generated
project code counts only if it comes from a defect in this repo's
templates or generation logic, not from a choice the interviewer or
`/customize` made on your behalf.

## Supported versions

| Version                                                 | Supported |
| ------------------------------------------------------- | --------- |
| Latest `1.x` release                                    | Yes       |
| `1.0.0-rc.N` and `0.x` prereleases, `0.0.0` placeholder | No        |
| Anything else                                           | No        |

Only the latest release in a supported line gets a fix. This is a
single-maintainer project; there is no backport policy across major
versions yet.

### Scope and duration of support

Support covers the latest `1.x` release of `@monte3l/groundwork`, and the
`/customize` plugin as it stands on `main` (the plugin ships from `main`, so
there is no older plugin release to support).

A release is supported until the next release in its line is published. From
then on it receives no fixes, security fixes included, and the fix is to
upgrade. There is no fixed calendar duration and no long-term-support line.

When a release is superseded, the maintainer may mark it with an npm
deprecation notice (`Superseded by <version>`), as was done for `1.0.0` and
the prereleases. Do not read a missing notice as meaning a superseded release
is still supported: the rule above is the policy, the notice is a courtesy.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/monte3l/m3l-groundwork/security/advisories/new)
for this repository.

> [!IMPORTANT]
> Do not open a public issue for a suspected vulnerability.

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

## Dependency and code-scanning findings

This is the project's policy for two kinds of automated finding: software
composition analysis (SCA), meaning known vulnerabilities and licenses in
dependencies, and static analysis (SAST), meaning CodeQL. It describes what is
enforced today.

### What runs

| Check                                                                   | When                        | On a finding                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency Review (`dependency-review.yml`), a required check on `main` | Every pull request          | Fails the PR if it adds or updates a dependency with a high or critical known vulnerability, or with a license outside the allow-list in that file                                                                                                    |
| `pnpm audit` (`security-audit.yml`)                                     | Daily, and on demand        | Opens one issue when the lockfile has a high or critical advisory, which catches one published after a merge                                                                                                                                          |
| `pnpm audit` and `npm audit` (the `pack` job in `release.yml`)          | Every release               | Fails the release before anything is built or published, for the root lockfile and for the release-tools lockfile the publish job installs from                                                                                                       |
| CodeQL default setup; its `CodeQL` check is required on `main`          | Every push and pull request | Fails the PR on a new alert of error severity or critical or high security severity, which is GitHub's default threshold                                                                                                                              |
| Dependabot (`dependabot.yml`)                                           | Weekly                      | Opens update PRs for the GitHub Actions, the release-tools and deploy-tools lockfiles, and the publishing pack's own lockfile. Root npm updates are off on purpose: the CLI has no runtime dependencies, and the checks above cover the root lockfile |

### Remediation thresholds

| Finding                              | Threshold                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A critical or high SCA vulnerability | A PR that introduces one does not merge. One published against a dependency already locked is fixed (update, replace or remove) within 60 days of the daily audit raising it, and **no release is published while one is open**.                                                                  |
| A medium SCA vulnerability           | Fixed within 60 days, through a dependency update. It does not block a release.                                                                                                                                                                                                                   |
| A low SCA vulnerability              | Fixed in the normal course of dependency updates, with no deadline.                                                                                                                                                                                                                               |
| A license outside the allow-list     | A PR that adds one does not merge. Either the dependency is removed, or the license is added to the allow-list in the same PR with the reason in its description, as was done for BlueOak-1.0.0, Artistic-2.0 and CC-BY-3.0. One found on an already-locked dependency is fixed within 60 days.   |
| A SAST (CodeQL) alert                | A new alert of error severity or critical or high security severity blocks the PR. One found in code already merged, with a medium or higher security severity, is fixed within 60 days of triage; a lower one is at the maintainer's discretion. A dismissed alert records its reason in GitHub. |

### Process

1. **Identify.** The checks above, plus Dependabot and GitHub security
   advisories.
2. **Prioritize.** Severity first, then whether the code ships. The CLI has no
   runtime dependencies, so a finding in a development dependency affects
   contributors and CI, not people who install the package. A finding in what
   the package ships, the templates included, is treated as a vulnerability in
   this project and follows "Response process" above.
3. **Remediate.** Update, replace or remove the dependency. A finding in the
   release-tools lockfile is fixed by updating the pinned package.
4. **Accept, only when nothing else works.** An advisory that does not affect
   the project and has no patched version can be excluded from the root audit
   by its GHSA id under `audit.ignore` in `pnpm-workspace.yaml` (pnpm 12.4 or
   later), in a PR that records the reasoning in
   [`docs/security-review.md`](docs/security-review.md). The exclusion is the
   only way past the release gate, so it is always visible in review.

### Vulnerabilities that do not affect the project

[`docs/m3l-groundwork.openvex.json`](docs/m3l-groundwork.openvex.json) is an
[OpenVEX](https://openvex.dev) document stating which published advisories do
**not** affect the package, and why. It holds 13 statements, one for each
advisory recorded in [`docs/security-review.md`](docs/security-review.md) (the
release-tools lockfiles and the docs deploy tooling). Each is `not_affected`
with the justification `component_not_present` for versions 1.0.0, 1.0.1 and
1.0.2: the package declares no dependencies, bundles none and ships no lockfile
or `node_modules` directory, which was checked against those three tarballs.

It says nothing about the repository's own tooling, which carried those
packages until they were fixed or removed (the history is in
`docs/security-review.md`), and nothing about projects the CLI generates, which
install their own dependency trees. As of 2026-10-16 no vulnerability is open
against any component the project ships or uses: `pnpm audit` and `npm audit`
report none across all four lockfiles.

To keep it current, add a statement when a vulnerability is judged not
exploitable instead of fixed, in the same PR as the `audit.ignore` entry and the
reasoning in `docs/security-review.md`. After each release, add the new version
to every statement; the steps are in
[`.claude/rules/releases.md`](.claude/rules/releases.md).

Run `pnpm audit --audit-level=high` to see what the release gate sees.

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

# Or verify against the Sigstore bundle attached to the same Release
# (still fetches Sigstore's trust root over the network)
gh attestation verify <path-to-downloaded-tarball> \
  --bundle <path-to-downloaded-tarball>.sigstore.json \
  --repo monte3l/m3l-groundwork

# Verify the SBOM attestation for the same tarball
gh attestation verify <path-to-downloaded-tarball> \
  --repo monte3l/m3l-groundwork \
  --predicate-type https://cyclonedx.org/bom
```

Each GitHub Release carries the tarball and a `<tarball>.sigstore.json`
bundle of the same attestation. A release published before the bundle was
attached has only the tarball; verify it with the first `gh attestation
verify` command above.

Releases published after 1.0.2 also carry a CycloneDX software bill of
materials, `<tarball>.cdx.json`, attested against the tarball (its own
attestation is in GitHub's store, not a release asset). The package has no runtime
dependencies, so the SBOM lists the package itself and nothing else; that is
accurate, not an omission. Its root component records the tarball's
SHA-256, so the SBOM can be matched to the exact file it describes. It is
generated from `pnpm-lock.yaml` with `pnpm sbom`, so it carries a generation
timestamp and is not byte-for-byte reproducible the way the tarball is.

`npm audit signatures` confirms the registry signature and provenance
attestation both check out. `gh attestation verify` additionally prints the
signer's identity, which should read
`https://github.com/monte3l/m3l-groundwork/.github/workflows/release.yml@refs/heads/main`,
issued by `https://token.actions.githubusercontent.com`. There is
intentionally no other key to distribute or compare against.

In plain terms: a successful verification means both commands exit
without error and print that identity -- proof the package or tarball you
have really was built by this repository's own `release.yml` workflow, not
substituted or tampered with afterward.

> [!WARNING]
> If either command errors, or reports a different identity, treat the
> artifact as unverified and do not install or use it.

### Reproducing a release

The build is reproducible: two independent, clean builds of the same source
produce byte-identical tarballs (`pack.e2e.test.ts`'s reproducible-build
case checks this -- it's excluded from the fast default `pnpm test` run like
every other `*.e2e.test.ts` file, but CI's `e2e` job runs it on every push
and on every PR that changes more than documentation, via `pnpm test:e2e`,
and `release.yml`'s `pack` job re-runs it before
every release, not only at release time). To confirm a published release
yourself:

```bash
git checkout <tag>          # e.g. @monte3l/groundwork@1.0.0
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @monte3l/groundwork pack
shasum -a 256 packages/cli/*.tgz
```

Compare the resulting SHA-256 against the tarball attached to the matching
[GitHub Release](https://github.com/monte3l/m3l-groundwork/releases) -- the
same artifact `gh attestation verify` above checks the provenance of, and
byte-identical to the tarball npm serves (checked for `1.0.0-rc.5`: same
SHA-256, same sha512 `dist.integrity`). A
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

Background, not core policy: this section explains automated scoring
context for anyone who looks up this repo's Scorecard results. Nothing
here changes the reporting or response process described above.

`scorecard.yml` runs weekly and surfaces its findings as GitHub Code
Scanning alerts. Some are dismissed as deliberate, documented trade-offs
rather than defects -- don't re-open these by "fixing" them into a
standing bypass that undermines the design:

- **Branch-Protection / Code-Review** (0 required approvals on `main`): a
  single-maintainer project can't require an approval on its own PR
  without a standing bypass, which the `main` ruleset's empty
  `bypass_actors` list is deliberately designed to avoid. See
  [`CLAUDE.md`](CLAUDE.md#git-workflow), "Three choices are deliberate,
  not defaults." The same reasoning is why `.github/CODEOWNERS` (`*` owned
  by the two org owners) is advisory and `require_code_owner_review` stays
  off: GitHub doesn't let a PR author approve their own PR, so enforcing it
  would either block every maintainer PR outright or make every PR wait on
  the second owner, the same standing-bypass trap the 0-approvals choice
  above already avoids. Pull requests are collaborators-only (see
  [`CLAUDE.md`](CLAUDE.md#git-workflow)), so the file names who owns the
  repository rather than routing external, unreviewed code.
- **Contributors** (fewer than three contributing organizations):
  Scorecard counts commit authors' GitHub `Company` field across the last 30
  commits. A single-maintainer project has one, and the check's own
  remediation says there is none beyond recruiting contributors from other
  organizations. See [`ROADMAP.md`](ROADMAP.md) for how that grows.
- **Maintained** (repository age): purely time-based (Scorecard checks
  whether a repo is older than 90 days); it self-resolves and needs no
  action.

One finding is a partial, external gap: this project registered for an
[OpenSSF Best Practices badge](https://www.bestpractices.dev/projects/14937)
(project 14937) and has achieved Silver (Passing included), linked from the
README and the docs site. The repository is intended to meet the Gold criteria, excluding
the handful that inherently require more than one active contributor
(`bus_factor`, `contributors_unassociated`, `two_person_review` -- see
[`GOVERNANCE.md`](GOVERNANCE.md#bus-factor), stated honestly as unmet rather
than worked around; `version_tags_signed`, a SUGGESTED rather than required
criterion, is also Unmet in `.bestpractices.json` because changesets creates
unsigned tags) -- governance, roles and access continuity
([`GOVERNANCE.md`](GOVERNANCE.md)), a roadmap ([`ROADMAP.md`](ROADMAP.md)),
a documented architecture, this security policy, a per-file
copyright/license statement (`REUSE.toml` plus inline SPDX headers -- see
`CLAUDE.md`'s "Definition of Done"), a 90%/80% statement/branch coverage
gate, a reproducible build, dynamic analysis, a dated security review
([`docs/security-review.md`](docs/security-review.md)), a security assurance
case ([`docs/assurance-case.md`](docs/assurance-case.md)), DCO-signed
commits, strict linting, attested releases (a Sigstore bundle on each
GitHub Release, plus npm provenance), and CLI input
validation. The project's questionnaire shows the Silver badge achieved
(project 14937); `.bestpractices.json` holds the drafted answers, and the
Gold-level criteria still open are the three single-maintainer ones listed in
[`GOVERNANCE.md`](GOVERNANCE.md#gold-level-criteria-this-project-does-not-meet).

## Reading the Socket score

Background, not core policy: same as the Scorecard section above -- this
explains a third-party badge, not this project's vulnerability response.

The README's [Socket](https://socket.dev) badge scores five categories
(Supply Chain Risk, Quality, Maintenance, Vulnerability, License).
Two of those are structurally suppressed for a package this new and this
small, independent of any actual defect, and should not be chased with a
design change:

- **Supply Chain Risk and Maintenance** scale with download count,
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
  written with a **library** in mind. `@monte3l/groundwork` deliberately
  has none of those -- it's a CLI, not a library, and removing them was
  a considered breaking change (see the CLI's `CHANGELOG.md`), not an
  oversight. Re-adding a fake type export to satisfy a generic heuristic
  would reintroduce exactly what that change removed. The genuine
  quality signals this project controls -- a real README, a license
  field, a repository link, keywords, zero runtime dependencies -- are
  already all present.
