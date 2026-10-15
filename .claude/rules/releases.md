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
Release with `gh release upload`, together with the attestation's Sigstore
bundle as `<tarball>.sigstore.json` -- a second, independent proof alongside
npm provenance itself. A plugin-only change needs no changeset of its own.

**Two release signals exist only for OpenSSF Scorecard's parsers.**
Signed-Releases scores release **assets** named `*.sigstore.json` (8) or
`*.intoto.jsonl` (10) and never reads GitHub's attestation store, so the
bundle is uploaded as an asset. Name it `.sigstore.json`: it is a Sigstore
bundle, and `.intoto.jsonl` would claim a format it is not. Packaging only
recognises an npm publish job that has `actions/setup-node` with
`registry-url: https://registry.npmjs.org` **and** a step running
`npm ... publish`, so the `publish` job sets that `registry-url`. It is safe
because `bin/npm-stage-publish.mjs` never reads `.npmrc` or `NODE_AUTH_TOKEN`:
it exchanges the GitHub OIDC token itself and passes the result to
`libnpmpublish` explicitly. Re-check that if the publisher is ever rewritten
to use the npm CLI.

**The SBOM (OSPS Baseline OSPS-QA-02.02, level 3) is generated, attested and
attached in the same best-effort block.** `pnpm --filter @monte3l/groundwork
sbom` writes `<tarball>.cdx.json` (CycloneDX 1.6, `--prod --lockfile-only`),
`actions/attest` attests it against the tarball, and the existing `gh release
upload` attaches it only if that attestation succeeded. Three things are
easy to get wrong. **Use `--filter`, never `-C <dir>` or a cd into the
package**: both silently describe the workspace root (`m3l-groundwork@0.0.0`)
and would attest the wrong package. **The SBOM attestation's bundle is not
uploaded**, because a second `*.sigstore.json` beside the provenance bundle
would blur what that name means to Scorecard's Signed-Releases check;
consumers verify with `--predicate-type https://cyclonedx.org/bom`. **Do not
add `artifact-metadata: write`** to the `publish` job for it: the provenance
step already runs without it, and a wider token on the OIDC job needs a
reason. The step refuses to run when the tarball's version differs from
`packages/cli/package.json`. Scorecard v5.5.0 has no SBOM check, so this does
not move the score; its value is Baseline level 3 and consumers. An empty
`components` list is correct while the CLI has no runtime dependencies.

**Backfilling the bundle onto an older release.** Scorecard averages the last
five releases, so a release published before the bundle was attached scores
as unsigned until it rolls off. For a release whose tarball was attested,
the maintainer can attach the bundle by hand. Read the tarball's own digest
from the release asset, never from a local rebuild:

```bash
gh release download "@monte3l/groundwork@<version>" --repo monte3l/m3l-groundwork \
  --pattern '*.tgz' --dir /tmp/rel
gh attestation download /tmp/rel/monte3l-groundwork-<version>.tgz \
  --repo monte3l/m3l-groundwork
# writes sha256:<digest>.jsonl in the current directory; keep one bundle line
head -n1 sha256:*.jsonl > /tmp/rel/monte3l-groundwork-<version>.tgz.sigstore.json
gh attestation verify /tmp/rel/monte3l-groundwork-<version>.tgz \
  --bundle /tmp/rel/monte3l-groundwork-<version>.tgz.sigstore.json \
  --repo monte3l/m3l-groundwork
gh release upload "@monte3l/groundwork@<version>" \
  /tmp/rel/monte3l-groundwork-<version>.tgz.sigstore.json --repo monte3l/m3l-groundwork
```

Only upload after `gh attestation verify` passes. A release with no
attestation is left alone and rolls off as new releases ship.

**Packs have no release of their own.** `templates/packs/<name>/` ships
inside the CLI tarball, so a user-visible change to one pack is a CLI change
and takes a `patch` changeset like any other. Start its summary with `pack(<name>):`
(`pack(worktrees): ...`) so the CLI changelog can be read per pack. It is a
naming convention only: no `version` field in `pack.json` (`packs.ts` would
accept an unknown key, but nothing reads it), and no per-pack
`CHANGELOG.md`.

**Prerelease mode is over.** The CLI shipped one `0.x` line
(`0.1.0-next.N`, on the `next` dist-tag), then `1.0.0-rc.N` on the `rc`
dist-tag, and left `rc` mode with `pnpm changeset pre exit` in the PR that
made `1.0.0`; the version PR deleted `.changeset/pre.json`. `1.0.0` is the
same code as `1.0.0-rc.8`, published on `latest` (which had pointed at the
`0.0.0` placeholder). The public API (see the README's "Versioning policy")
has been frozen since the first `rc`: only `patch` changesets land in the
1.0 series, by convention, and any further API change waits for `1.1`. To
use prerelease mode again, run `pnpm changeset pre exit` and
`pnpm changeset pre enter <tag>` in one commit when switching tags:
splitting them lets `changeset version` run in the intervening `exit` state
and skip the prerelease suffix. Changesets' prerelease counter does not reset
across a tag switch, and it warns against sitting in pre mode on the default
branch indefinitely.

**GA promotion checklist** (kept as the record of how `1.0.0` was gated, and
the template for the next major). Every item was true when `rc` was left; each
one has a command or a file that proves it.

1. **The public API is unchanged since the first `rc`.** No `minor` or
   `major` changeset has landed (`.changeset/` and `git log` since the first
   `1.0.0-rc.N` tag), and every surface in the README's "Versioning policy"
   still matches the code.
2. **`main` is green and the last `rc` works from the registry.** The
   `verify` aggregator passes on `main`, and a manual `soak.yml` run against
   the published `rc` passes on Linux x64, Linux arm64 and macOS.
3. **The last `rc` is installable.** `npm view @monte3l/groundwork dist-tags`
   shows it on `rc`, so its `npm stage approve` (a live 2FA code, never run by
   the workflow) is done.
4. **No open high-severity finding.** There is no open `security-audit.yml`
   issue, no open high-severity Dependabot or code-scanning alert, and the
   open npm bundled-dependency advisories in `docs/security-review.md` are
   either fixed upstream or still recorded there as accepted.
5. **The plugin and the CLI agree.** `pnpm check:plugin-version` passes, so
   marketplace users get the stable plugin with the stable CLI.
6. **The docs say what the live settings are.** `pnpm verify` passes (the
   `docs` step included), and the read-only `gh api` commands in
   `docs/github-blueprint.md` still return the values that file states.

The exit was: `pnpm changeset pre exit` and a `patch` changeset in one PR,
the version PR, the `npm-publish` environment approval and `npm stage
approve`. Once `latest` pointed at `1.0.0`, a docs PR dropped `@rc` from the
README. After the publish the `next` and `rc` dist-tags were repointed to
`1.0.0`, and `0.0.0`, the `0.1.0-next.*` releases and `1.0.0-rc.2` to
`1.0.0-rc.8` were deprecated ("Superseded by 1.0.0"). `latest` moved off the
`0.0.0` placeholder. npm needs an interactive login for dist-tag and
deprecate commands, so the maintainer runs them.

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
**Allow GitHub Actions to create and approve pull requests** toggle
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
  a staged publish, not `npm publish` -- npmjs.com's own recommended,
  stronger setting, and its default for any trusted publisher created after
  2026-09-03 (this one was). A maintainer must separately run
  `npm stage approve <id>` (needs a live 2FA code: `--otp` or a prompt on the CLI, or
  npmjs.com -- **not automatable**, since no stored code stands in for it) before a version is actually
  installable. `npm stage list --package @monte3l/groundwork` finds the id;
  the `publish` step records the stage id in `STAGED_IDS_FILE` (changesets
  swallows the publisher's stdout) and a later "Show the staged ids to approve"
  step prints it and annotates the run; it also goes in the job summary. The
  workflow never approves anything. The alternative --
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
- **`bin/pnpm-publish-shim.mjs` reroutes `pnpm publish` to
  `bin/npm-stage-publish.mjs`, which stages through `libnpmpublish`, not the npm
  CLI.** The npm CLI's own bundled dependencies (undici, ip-address,
  brace-expansion, ...) carried advisories that no override can reach and no npm
  release fixed (`docs/security-review.md`); `libnpmpublish` is npm's own publish
  library as an ordinary, auditable dependency. The script does the GitHub OIDC
  to npm token exchange itself (ported from npm's `lib/utils/oidc.js`, so
  re-check it when npm changes trusted publishing) and, unlike the CLI, fails
  loudly instead of falling back to no auth. Changesets publishes through
  `pnpm publish` in a pnpm workspace, and a **direct** `npm publish` is not
  allowed by the staged-only trusted publisher (see above). The shim translates only changesets' exact
  invocation and refuses any flag it does not recognise; everything else
  passes through to pnpm.
- **Changesets, not a hand-written publish script, owns the publish plan, tags
  and Releases.** Tarballs are packed in one job and published in another so the
  OIDC token is never present where build or test code runs. The `publish` job
  installs with `--ignore-scripts` and pins exact `libnpmpublish` and
  `npm-registry-fetch` versions in `tools/release/package-lock.json`,
  not a range or `latest` -- OpenSSF Scorecard's
  Pinned-Dependencies check flags a floating install the same way it flags
  an unpinned Action, and this job holds the OIDC token.
  Both release-tools lockfiles (this repository's and the `publishing`
  pack's) are audit-clean; `docs/security-review.md`'s "Advisories in the
  pinned npm" section keeps the history of why the npm CLI was dropped.
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
