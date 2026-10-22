---
paths:
  - ".github/workflows/release.yml"
  - "release-please-config.json"
  - ".release-please-manifest.json"
  - "packages/plugin/.claude-plugin/**"
  - "packages/*/package.json"
  - "bin/npm-stage-publish.mjs"
  - "bin/check-plugin-version.mjs"
  - "bin/lib/npm-publish-args.mjs"
  - "bin/lib/plugin-version.mjs"
---

# Release rules (`release.yml`, release-please, the two `package.json`s)

> This file is the terse checklist that auto-loads when you touch the
> release pipeline, release-please's config, or either package's manifest. See
> `SECURITY.md`'s "Verifying releases" for the consumer-facing half of this
> story.

Only `@monte3l/groundwork` (the CLI, `packages/cli`) ships to npm.
`@monte3l/groundwork-plugin` (`/customize`, `packages/plugin`) is `private`
and never published there -- it distributes only through the central
`monte3l/m3l-plugins` marketplace (marketplace name `monte3l`, install id
`m3l-groundwork-customize@monte3l`). That catalog lists it as a `git-subdir`
source (this repo, path `packages/plugin`) **pinned to a release tag**
(`@monte3l/groundwork@X.Y.Z`) and its commit. This repo ships no
`marketplace.json` of its own, and a plugin repo must not.

**The flow.** Releases follow the organisation's shared baseline
(`monte3l/.github`, `blueprint/README.md`, "Releases"). There is no changeset
to write: **the Conventional Commit type is the release.** `feat` is a minor,
`fix` a patch, `!` or a `BREAKING CHANGE:` footer a major, and `docs`, `test`,
`chore`, `ci` and `refactor` release nothing, so a user-visible change
committed as `chore` never ships. A push to `main` runs `release.yml`:

1. `prepare` (the shared `release-prepare.yml`) runs release-please with an App
   token. It opens or updates one `chore(main): release @monte3l/groundwork X.Y.Z`
   pull request (version bump, `packages/cli/CHANGELOG.md`, `plugin.json`), or,
   when that pull request has merged, tags the commit and creates a **draft**
   GitHub Release.
2. `pack` runs `pnpm audit`, the full `pnpm verify`, `pnpm test:e2e`, packs the
   tarball once and generates its SBOM. It holds `contents: read` and nothing else.
3. `publish`, the only job holding `id-token: write`, checks the draft's tag
   points at the built commit, attests the tarball (provenance, whose Sigstore
   bundle is attached as `<tarball>.sigstore.json`) and its SBOM, attaches the
   three files to the draft, reads them back, and last stages the package on
   npm with `bin/npm-stage-publish.mjs`. It sits behind the `npm-publish`
   environment.
4. `finalize` (the shared `release-finalize.yml`, called with `attest: false`
   because step 3 already attested) publishes the draft, then dispatches
   `release-published` to `m3l-plugins`, which opens the pin-bump pull request.

release-please counts a commit when it changes a file that ships: the CLI, the
templates or the plugin. `release-please-config.json` lists the directories that
do not ship under `exclude-paths`, so a `fix` that touches only `docs/` or
`.github/` releases nothing. It cannot exclude a root file, so a `fix` that
changes only a root file does release. Use `docs`, `ci` or `chore` for those. A
new top-level directory that does not ship belongs in `exclude-paths`.

**A plugin-only change is not live on merge.** Because the central catalog
pins a release tag and commit, a change under `packages/plugin` reaches
marketplace users only after (1) a release, which tags
`@monte3l/groundwork@X.Y.Z` (a `fix(plugin):` or `feat(plugin):` commit
causes one, since the plugin ships with the CLI), and (2) the pin-bump pull
request that `m3l-plugins` opens when the release is published. Review and
merge it there.

**Packs have no release of their own.** `templates/packs/<name>/` ships
inside the CLI tarball, so a user-visible change to one pack is a CLI change
and is a `feat` or `fix` commit like any other: `fix` for a change to an existing
pack, `feat` for a new pack, because pack names are public API (the README's
versioning policy, item 4) and a new one is new functionality. Use the pack name
as the commit scope (`fix(worktrees): ...`) so the changelog can be read per
pack. It is a naming convention only: no `version` field in `pack.json`, and no
per-pack `CHANGELOG.md`.

**Things that look wrong but are deliberate.**

- **Staged, not direct.** `@monte3l/groundwork`'s trusted publisher only allows
  a staged publish, not `npm publish` -- npmjs.com's own recommended,
  stronger setting, and its default for any trusted publisher created after
  2026-09-03 (this one was). A maintainer must separately run
  `npm stage approve <id>` (needs a live 2FA code: `--otp` or a prompt on the CLI, or
  npmjs.com -- **not automatable**, since no stored code stands in for it) before a version is actually
  installable. `npm stage list --package @monte3l/groundwork` finds the id;
  the staging step records the stage id in `STAGED_IDS_FILE` and a later
  "Show the staged ids to approve" step prints it and annotates the run; it also
  goes in the job summary. The
  workflow never approves anything. The alternative --
  checking "allow npm publish" -- was considered and rejected: this package
  is a solo-maintainer pre-1.0 CLI, not the "high-impact, widely-used"
  case npm is targeting, but the release PR is already a real, reviewed gate
  before anything reaches `publish` at all, and the `publish` job's own
  containment (no build/test code, `--ignore-scripts`) already limits what a
  compromised token could do -- staging adds a second, stronger gate on top
  of a design that already had one. That trade means accepting the ordering
  cost above: the GitHub Release is published by `finalize` right after the
  staging, so it can exist for a few minutes to however long approval takes
  before `npm install` actually resolves the version.
- **`bin/npm-stage-publish.mjs` stages through `libnpmpublish`, not the npm
  CLI.** The npm CLI's own bundled dependencies (undici, ip-address,
  brace-expansion, ...) carried advisories that no override can reach and no npm
  release fixed (`docs/security-review.md`); `libnpmpublish` is npm's own publish
  library as an ordinary, auditable dependency. The script does the GitHub OIDC
  to npm token exchange itself (ported from npm's `lib/utils/oidc.js`, so
  re-check it when npm changes trusted publishing) and, unlike the CLI, fails
  loudly instead of falling back to no auth. A **direct** `npm publish` is not
  allowed by the staged-only trusted publisher (see above). The workflow calls
  it with the one tarball `pack` built; `bin/lib/npm-publish-args.mjs` parses
  its arguments and refuses any flag it does not know. It was reached through a
  `pnpm publish` shim while Changesets owned the publish; the shim is gone.
- **The tarball is packed once, in `pack`, and every later job takes that file.**
  `pack` and `publish` are separate jobs so the OIDC token is never present where
  build or test code runs. `publish` installs only `tools/release` with
  `--ignore-scripts`, pinning exact `libnpmpublish` and `npm-registry-fetch`
  versions in `tools/release/package-lock.json`, not a range or `latest` --
  OpenSSF Scorecard's Pinned-Dependencies check flags a floating install the
  same way it flags an unpinned Action, and this job holds the OIDC token. The
  SBOM is made in `pack` for the same reason: `pnpm sbom` needs the root install.
  Both release-tools lockfiles (this repository's and the `publishing` pack's)
  are audit-clean; `docs/security-review.md`'s "Advisories in the pinned npm"
  section keeps the history of why the npm CLI was dropped.
- **No package-manager cache in `release.yml`**, and no `cancel-in-progress`: a
  restored cache is an input an attacker can poison in the jobs that publish,
  and a half-published release is worse than a queued one.

**Versions that must agree.** `packages/plugin/.claude-plugin/plugin.json`'s
version tracks `packages/cli/package.json`'s. release-please writes both from
`extra-files` in `release-please-config.json`, in the release pull request, and
`.release-please-manifest.json` holds the version it last released. Never edit
any of the three by hand. `check-plugin-version` (the `lint`-group gate,
`bin/check-plugin-version.mjs`) fails on drift between the two files, and
separately asserts `packages/plugin/package.json` stays `private` -- a
structural guard against this design quietly regrowing the npm-publish shape it
deliberately dropped.

**The `npm-publish` environment gates the staged publish.**
`release.yml`'s `publish` job has `environment: npm-publish`, a GitHub
environment (created once, by hand, via `gh api` -- not committed as JSON,
same reasoning as the branch ruleset) with two required reviewers (the
maintainer and a second org owner, see `GOVERNANCE.md`; self-review is
currently allowed) and deployments restricted to `main`. This pauses the job
before anything is attested, attached or staged, which is the second,
independent approval this design accepts on top of npm's own staged-publish
gate. The draft release and its tag already exist at that point, but a draft is
visible to writers only. Read the live state with
`gh api repos/monte3l/m3l-groundwork/environments/npm-publish`.

**A red "Check that the release tag points at the commit that was built" step
means the tag and the build disagree, and nothing was attested or staged.**
release-please creates the draft's tag at the commit the release pull request
merged as. The `publish` job compares it with the commit it is running for
before it attests anything. The history behind the check: under Changesets the
tag was made after the staged publish, and `@monte3l/groundwork@1.0.3`, built
from `2850f8e`, waited about 3.5 hours at the `npm-publish` gate while `main`
moved, so its tag landed on `73af011`. Moving a tag is a maintainer action,
because the `tags` ruleset blocks updating and deleting a tag with no bypass:
set that ruleset's `enforcement` to `disabled`, point the tag at the built
commit (`gh api -X PATCH repos/monte3l/m3l-groundwork/git/refs/tags/<tag>
-f sha=<built commit> -F force=true`), and set it back to `active`. It was used
once, on 2026-10-19, to move the 1.0.3 tag from `73af011` to `2850f8e`.

**Immutable releases.** The draft-first flow attaches every asset before the
release is published, so immutable releases (which lock the tag and assets at
publish) are compatible with it. They stay off until the first release through
this workflow has been published and checked with `gh release verify`.

Split-out detail: `.claude/rules/release-supply-chain.md` (Scorecard signals, SBOM, audit, OpenVEX) and `.claude/rules/release-history.md` (GA record, one-time setup, superseding versions).
