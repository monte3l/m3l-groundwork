---
paths:
  - ".github/workflows/release.yml"
  - ".changeset/**"
  - ".claude-plugin/**"
  - "packages/plugin/.claude-plugin/**"
  - "packages/*/package.json"
  - "bin/pnpm-publish-shim.mjs"
  - "bin/sync-plugin-version.mjs"
  - "bin/check-plugin-version.mjs"
  - "bin/lib/npm-publish-args.mjs"
  - "bin/lib/plugin-version.mjs"
---

# Release rules (`release.yml`, changesets, the two `package.json`s)

> This file is the terse checklist that auto-loads when you touch the
> release pipeline, changeset state, or either package's manifest. See
> `SECURITY.md`'s "Verifying releases" for the consumer-facing half of this
> story.

Only `@monte3l/groundwork` (the CLI, `packages/cli`) ships to npm.
`@monte3l/groundwork-plugin` (`/customize`, `packages/plugin`) is `private`
and never published there -- it distributes only through the Claude Code
marketplace, `.claude-plugin/marketplace.json`'s single entry, whose `source`
is a **relative path** into `packages/plugin` in this same repo, not an npm
source -- the documented, no-registry way to ship a Claude Code plugin that
lives in the same repo as its CLI, and there is no equivalent reason to run
the plugin through a registry the way `npx @scope/pkg` needs one for the CLI.

**The flow.** A PR with a user-visible change to the CLI adds a changeset
(`pnpm changeset`) -- the plugin never takes one, since it has no release of
its own. A push to `main` runs `release.yml`, whose `select-mode` job decides:
with a changeset pending it opens a `chore(release): version packages` PR
(`pnpm version:packages` = `changeset version`, then
`bin/sync-plugin-version.mjs` copying the new CLI version into `plugin.json`,
then a lockfile refresh); with none pending and an unpublished version it
publishes. Publishing is `pack` (the full `pnpm verify`, then `pnpm test:e2e`,
then `changesets/action/pack`) followed by `publish`, the only job holding
`id-token: write`. The CLI gets provenance, a git tag and a GitHub Release
with its changelog -- **at the moment `npm stage publish` succeeds, not at the
moment the package is actually live**; see "staged, not direct" below.
`publish` also fetches the exact tarball `pack` already built and tested
back out of its own artifact (never rebuilt), runs
`actions/attest-build-provenance` on it, and attaches it to the GitHub
Release with `gh release upload` -- a second, independent proof alongside
npm provenance itself. A plugin-only change needs no release step at all: it
is live for marketplace users (`/plugin marketplace update`) the moment it
lands on `main`; `plugin.json`'s version just trails the CLI's for display.

**Packs have no release of their own.** `templates/packs/<name>/` ships
inside the CLI tarball, so a user-visible change to one pack is a CLI change
and takes a `patch` changeset like any other. Start its summary with `pack(<name>):`
(`pack(worktrees): ...`) so the CLI changelog can be read per pack. It is a
naming convention only: no `version` field in `pack.json` (`packs.ts` would
accept an unknown key, but nothing reads it), and no per-pack
`CHANGELOG.md`.

**Prerelease mode is on** (`.changeset/pre.json`, tag `rc`): the CLI shipped
one `0.x` line (`0.1.0-next.0`/`.1`, on the `next` dist-tag) before the public
API was defined, then switched tags (`pnpm changeset pre exit` immediately
followed by `pnpm changeset pre enter rc`, both in one commit -- splitting
them across commits lets `changeset version` run in the intervening `exit`
state and skip the prerelease suffix entirely) alongside a `major` changeset.
Changesets' prerelease counter does not reset across a tag switch, so the
first `rc` version continued from the `next` line's counter rather than
starting at `.0` or `.1` -- read `pnpm changeset status --verbose` before
relying on a specific number. The CLI's versions are now `1.0.0-rc.N` on the
`rc` dist-tag, so the README says `npx @monte3l/groundwork@rc`; `@next`
users must switch explicitly, since a prerelease range never crosses from
`0.1.0-next.N` to `1.0.0-rc.N` on its own. The public API (see the README's
"Versioning policy") is frozen as of the first `rc`: only `patch` changesets
land for the rest of the series, and any further API change waits for a
`1.1` after GA. Leave `rc` mode with `pnpm changeset pre exit` plus a normal
version PR once the promotion checklist is met, then drop `@rc` from the
README (and repoint the `next` dist-tag, and any marketplace channel, to the
stable release -- see the release plan for the full GA checklist).
Changesets itself warns against sitting in pre mode on the default branch
indefinitely.

**One-time setup, done by hand, that this design depends on.** npm cannot
configure a trusted publisher for a package that does not exist yet, so
`@monte3l/groundwork` was first published once as a `0.0.0` placeholder with a
temporary token (`@monte3l/groundwork-plugin` needs none of this -- it never
touches npm). That is also why `latest` points at `0.0.0` until the first
stable release. **The trusted publisher is bound to the workflow filename
`release.yml` (the bare name, not a path): renaming or moving that file
breaks publishing** until it is reconfigured on npmjs.com. The version job's
PR is opened with a GitHub App installation token, not the default
`GITHUB_TOKEN` (see "The version PR authenticates as a GitHub App" below),
so despite an earlier version of this doc, the repo's own
_Allow GitHub Actions to create and approve pull requests_ toggle
(`can_approve_pull_request_reviews`) is not actually needed for that step --
see CLAUDE.md's "Known gaps" for turning it off. The trusted publisher's
**allowed actions is staged-only** (`npm stage publish`, no direct
`npm publish`) -- npm's own default for any trusted publisher created since
2026-09-03, and its explicit recommendation over direct publish; see
"staged, not direct" below for what that costs and why it was kept rather
than switched off.

**The version PR authenticates as a GitHub App, not the default
`GITHUB_TOKEN`.** `main`'s branch ruleset (see CLAUDE.md's "Git Workflow")
requires `verify`, `Dependency Review`, `CodeQL` and `Gitleaks` on every PR, with an
empty bypass list -- including this one. A PR opened with the default
`GITHUB_TOKEN` never triggers `pull_request`-event workflows (GitHub's own
anti-recursion rule), so those four checks would never post and the PR could
never merge. `release.yml`'s `version` job instead mints a one-hour
installation token from a GitHub App installed on just this repo
(`actions/create-github-app-token@v3`, reading the `APP_CLIENT_ID` /
`APP_PRIVATE_KEY` repo secrets) and passes it as `changesets/action/version`'s
`github-token`. That makes the PR behave like any human-opened one: the same
four checks run and satisfy the ruleset through its normal path, and the
`version` job's own `permissions:` stays `contents: read` -- the App token
does the actual writing, scoped to exactly `contents: write` +
`pull-requests: write` on the App itself. This is what both GitHub's own docs
("GITHUB_TOKEN") and changesets' own automating guide recommend for this
exact situation -- an App token over a PAT (shorter-lived, not tied to a
person) or a ruleset bypass (which would skip the checks rather than
satisfy them, undermining the empty `bypass_actors` list "Git Workflow"
describes).

**Things that look wrong but are deliberate.**

- **Staged, not direct.** `@monte3l/groundwork`'s trusted publisher only allows
  `npm stage publish`, not `npm publish` -- npmjs.com's own recommended,
  stronger setting, and its default for any trusted publisher created after
  2026-09-03 (this one was). A maintainer must separately run
  `npm stage approve <id>` (2FA, on the CLI or npmjs.com -- **never
  automatable**, by npm's own design) before a version is actually
  installable. `npm stage list --package @monte3l/groundwork` finds the id;
  the `publish` job's last step only runs `npm stage list ... || true`, best-effort
  (it never approves anything, and that job holds no login session so it may
  print nothing). The alternative --
  checking "allow npm publish" -- was considered and rejected: this package
  is a solo-maintainer pre-1.0 CLI, not the "high-impact, widely-used"
  case npm is targeting, but the version PR is already a real, reviewed gate
  before anything reaches `publish` at all, and the `publish` job's own
  containment (no build/test code, `--ignore-scripts`) already limits what a
  compromised token could do -- staging adds a second, stronger gate on top
  of a design that already had one. That trade means accepting the ordering
  cost above: the git tag and GitHub Release exist for a few minutes to
  however long approval takes, before `npm install` actually resolves the
  version.
- **`bin/pnpm-publish-shim.mjs` reroutes `pnpm publish` to `npm stage
publish`.** Two stacked reasons, not one: changesets publishes through
  `pnpm publish` in a pnpm workspace, and pnpm 12's native publish is
  rejected by npmjs.com's OIDC exchange (403 "OIDC permission denied"; still
  unfixed through pnpm 12.5.1 when this was written) -- and separately, a
  _direct_ `npm publish` would get the identical 403 for the unrelated
  staged-only reason above. The shim translates only changesets' exact
  invocation and refuses any flag it does not recognise; everything else
  passes through to pnpm. Delete the pnpm-OIDC half of this once pnpm's
  publish authenticates; the staged-vs-direct half stays regardless.
- **Changesets, not a hand-written publish script, owns the publish plan, tags
  and Releases.** Tarballs are packed in one job and published in another so the
  OIDC token is never present where build or test code runs. The `publish` job
  installs with `--ignore-scripts` and pins an exact `npm@` version (`npm
stage publish` needs >= 11.15.0, Node >= 22.14.0 -- already covered by
  `.node-version`'s 24), not a range or `latest` -- OpenSSF Scorecard's
  Pinned-Dependencies check flags a floating install the same way it flags
  an unpinned Action, and this job holds the OIDC token.
  The pinned npm currently carries open advisories in its bundled
  dependencies, tracked in `docs/security-review.md`'s "Open advisories in the
  pinned npm" section: run its day-of-release re-check before approving a
  release (`npm stage approve`).
- **No package-manager cache in `release.yml`**, and no `cancel-in-progress`: a
  restored cache is an input an attacker can poison in the jobs that publish,
  and a half-published release is worse than a queued one.

**Versions that must agree.** `packages/plugin/.claude-plugin/plugin.json`'s
version tracks `packages/cli/package.json`'s (`bin/sync-plugin-version.mjs`
edits the text in place, not re-serializing JSON, so Prettier stays
satisfied). `check-plugin-version` (the `lint`-group gate,
`bin/check-plugin-version.mjs`) fails on that drift, and separately asserts
`packages/plugin/package.json` stays `private` and that
`.claude-plugin/marketplace.json`'s entry names the plugin correctly, points
at a non-npm source, and carries no version pin of its own -- three structural
guards against this design quietly regrowing the npm-publish shape it
deliberately dropped.

**The `npm-publish` environment closes the tag/Release ordering gap.**
`release.yml`'s `publish` job has `environment: npm-publish`, a GitHub
environment (created once, by hand, via `gh api` -- not committed as JSON,
same reasoning as the branch ruleset) with two required reviewers (the
maintainer and a second org owner, see `GOVERNANCE.md`; self-review is
currently allowed) and deployments
restricted to `main`. This pauses the job itself -- before the git tag, the
GitHub Release, or `npm stage publish` exist -- rather than only gating
`npm stage approve` afterward, which is the second, independent approval
this design accepts on top of npm's own staged-publish gate. Read the live
state with `gh api repos/monte3l/m3l-groundwork/environments/npm-publish`.
