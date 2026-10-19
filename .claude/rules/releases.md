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

**Packs have no release of their own.** `templates/packs/<name>/` ships
inside the CLI tarball, so a user-visible change to one pack is a CLI change
and takes a `patch` changeset like any other. Start its summary with `pack(<name>):`
(`pack(worktrees): ...`) so the CLI changelog can be read per pack. It is a
naming convention only: no `version` field in `pack.json` (`packs.ts` would
accept an unknown key, but nothing reads it), and no per-pack
`CHANGELOG.md`.

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

**A red "Check that the release tag points at the commit that was built"
step means the tag and the attestations disagree.** `changesets/action/publish`
makes the tag with the git refs API at the run's commit and, if that call fails,
only logs a warning; the GitHub Release it creates next then makes the missing
tag at the head of `main`. That happened once: `@monte3l/groundwork@1.0.3` was
built from `2850f8e`, waited about 3.5 hours at the `npm-publish` gate while
`main` moved, and its tag landed on `73af011`. The refs call returned 403
(`Resource not accessible by integration`) on that run and succeeded on 1.0.4;
the cause is not known, so the only trigger recorded is `main` having moved
during the wait. Approve the gate soon after the build finishes. The package
and its attestations are unaffected, since both name the built commit; only the
tag is wrong. The `tags` ruleset blocks updating and deleting a tag with no
bypass, so moving one is a maintainer action: set that ruleset's `enforcement`
to `disabled`, point the tag at the built commit
(`gh api -X PATCH repos/monte3l/m3l-groundwork/git/refs/tags/<tag>
-f sha=<built commit> -F force=true`), and set it back to `active`. It was
used once, on 2026-10-19, to move the 1.0.3 tag from `73af011` to `2850f8e`; the
ruleset was active again afterwards, with the same rules and no bypass actor.
Rebuilding 1.0.3 from `2850f8e` gave a tarball with the published SHA-256, which
the tag at `73af011` did not.

Split-out detail: `.claude/rules/release-supply-chain.md` (Scorecard signals, SBOM, audit, OpenVEX) and `.claude/rules/release-history.md` (GA record, one-time setup, superseding versions).
