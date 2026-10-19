---
paths:
  - ".changeset/**"
  - "bin/deprecate-superseded.mjs"
  - "bin/lib/deprecation-plan.mjs"
---

# Release history, setup and deprecation (GA record, one-time setup, superseding versions)

> Split verbatim from `.claude/rules/releases.md` so it loads only when you edit the files it governs.

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
README. Read the dist-tags with `npm view @monte3l/groundwork dist-tags` (on
2026-10-16, after `1.0.3`: `latest`, `next` and `rc` all `1.0.3`). On
2026-10-19, with `1.0.4` as `latest`, every version before it is deprecated.
The messages are `Superseded by <version>. Use @monte3l/groundwork@latest.`
(the `0.1.0-next.*` releases and `1.0.0-rc.2` to `1.0.0-rc.8` name `1.0.0`;
`1.0.0` names `1.0.1`; `1.0.1` and `1.0.2` name `1.0.3`; `1.0.3` names
`1.0.4`), except `0.0.0`: `Empty placeholder. Use @monte3l/groundwork@latest
(1.0.0 or later).` `latest` moved off the `0.0.0` placeholder.

**Deprecating superseded versions is one maintainer command, run after
`npm stage approve`.** `node bin/deprecate-superseded.mjs` is a dry run that
prints the plan; `--expect <version> --apply` runs it. It deprecates every
version below `latest` that is not already deprecated (prereleases included)
with exactly `Superseded by <latest>. Use <name>@latest.` (for example
`Superseded by 1.0.4. Use @monte3l/groundwork@latest.`), the wording the
versions deprecated by hand already carry. `<name>` is the packument's `name`.
It leaves existing messages alone. The message on `0.0.0`
(`Empty placeholder. Use @monte3l/groundwork@latest (1.0.0 or later).`) was a
hand-written one-off; the script never generates it. `release.yml`'s
"Show the staged ids to approve" step prints the exact command for a stable
version. Three properties are deliberate:

- **It is not a CI step.** A staged version is not installable until
  approved, so deprecating at publish time would leave only deprecated
  versions installable until then, and for good if the approval never comes.
  The trusted publisher's OIDC token is also scoped to publishing, so running
  it in CI would mean storing a long-lived npm token, which this design avoids.
- **`--apply` requires `--expect`, which checks `latest` first.** The script
  refuses `--apply` without `--expect <version>`, and refuses when `latest` is
  not that version, which is what catches running it before the approval.
- **One `npm deprecate` call per run, never one per version.** npm's
  `deprecate` takes a version range, so the script passes the planned exact
  versions as one `a || b || c` range and npm writes the packument once, which
  means one 2FA challenge. Pass `--otp <code>` to skip the browser entirely:
  npm sets `auth-type` to `legacy` whenever `otp` is given. Without it, npm's
  web authentication opens one browser approval for the whole batch. The range
  names exact versions rather than `<latest` so existing messages are not
  overwritten.

A granular "bypass 2FA" token was rejected for this: npm documents it for
publishing only and it is long-lived. The browser's "remember for 5 minutes"
option is documented for `publish` only, so nothing here relies on it.

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
