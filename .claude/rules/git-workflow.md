---
paths:
  - ".github/CODEOWNERS"
  - "lefthook.yml"
  - "commitlint.config.js"
  - "bin/lint-commit.mjs"
  - "bin/strip-claude-trailers.mjs"
  - "CONTRIBUTING.md"
  - ".claude/skills/starting-work/**"
  - ".claude/skills/writing-commits/**"
  - ".claude/skills/creating-prs/**"
  - ".claude/skills/finishing-work/**"
---

# Git workflow rules (commits, PRs, the `main` ruleset)

> Moved verbatim from the root `CLAUDE.md` ("Git Workflow") so it loads when
> you edit the files that implement it. The root file keeps a summary.

Single-maintainer project on GitHub (`monte3l/m3l-groundwork`, public).
**Pull request creation is collaborators-only**
(`pull_request_creation_policy: collaborators_only`, a repo setting, not a
ruleset rule -- read it with `gh api repos/monte3l/m3l-groundwork --jq
.pull_request_creation_policy`), added 2026-09-26 after a fork account
opened several PRs that had the shape of automated "good first issue"
farming (a thin, low-signal profile bulk-forking many unrelated repos in a
tight window). Issues stay open to everyone; a contribution starts as an
issue, and a collaborator opens the PR (see CONTRIBUTING.md's "Small tasks
for newcomers"). This also simplifies the fork-PR secrets question:
`gitleaks.yml`'s license secret no longer needs to handle a fork-originated PR
run at all, since one is not expected (the workflow has no fork guard of its own).
Conventional Commits, enforced by the `commit-msg` hook
(`bin/lint-commit.mjs`) -- same convention `templates/core` emits into every
bootstrapped project. Add a `Co-Authored-By:` trailer when Claude authored or
substantially assisted a commit. The release workflow's version PR and commit
use `chore(release): version packages` so they satisfy the same convention.
Every commit also needs a DCO `Signed-off-by:` trailer (`git commit -s`),
enforced by the same hook via `commitlint.config.js`'s `trailer-exists` rule,
which `bin/lint-commit.mjs` extends to merge, revert and fixup!/squash! messages
and to a non-empty value -- see [`CONTRIBUTING.md`](../../CONTRIBUTING.md#developer-certificate-of-origin).
The hook is local, so CI repeats the check: `ci.yml`'s `dco` job fails a PR
when a commit it adds has no `Signed-off-by` trailer matching its author or
committer email (merge commits skipped; commits by `dependabot[bot]` and
`m3l-groundwork-release[bot]` exempt only inside a PR that same bot opened), and the `verify`
aggregator waits on it, so it is a required check with no ruleset change. It
reads a PR's own commits, not the commit GitHub writes on a squash merge,
which is why the PR template also carries a sign-off checkbox.

CI runs on every push and PR to `main` (see `.claude/rules/ci.md`), and a
repository ruleset named `main` enforces the rest. It targets
`~DEFAULT_BRANCH` with an empty `bypass_actors` list -- nobody, the org owner
included, can push to `main` directly, force-push it, or delete it while the
ruleset is active. Every change lands through a pull request whose `verify`
(the aggregator), `Dependency Review`, `CodeQL` and `Gitleaks` checks are green, which
has one approval from a code owner other than its author, whose
review threads are resolved, and whose commits are all signed. Each required
check is matched on both its name and its producing app (`integration_id`), so
a same-named status from a different app doesn't satisfy it.

Three choices are deliberate, not defaults. **Approvals are 1**: the two
org owners approve each other's PRs. The approval must come from a code owner
(`.github/CODEOWNERS` names both owners for every path), the most recent push
must be approved by someone other than whoever pushed it, and a stale
approval is dismissed on push. This replaced an earlier 0, which existed because one maintainer
cannot approve their own PR and requiring one would have forced a standing
bypass; a second owner now reviews every PR, so the rule is enforceable. The
cost is availability: if one owner is away, the other cannot merge their own
PR without the ruleset being set to `disabled` and back (GitHub logs it),
never a bypass actor. **Rebase-merge is not an allowed method**: GitHub rewrites
those commits and has no key to sign them, so under required signatures the
button would always error; merge and squash remain. **A branch must be
up to date before merging** (`strict` is on). It was off until 2026-10-16:
with weekly Dependabot PRs, no auto-merge and no merge queue, strict mode
re-runs every lane, e2e included, once per remaining PR after every merge,
and it dismisses the approval each time the branch is updated, so the other
owner approves again. Two PRs that each pass `verify` can no longer combine
into a broken `main`, and OpenSSF Scorecard's Branch-Protection check asks
for it, which is why the cost is now accepted. After merging a PR, update the
next one's branch (the **Update branch** button, or `@dependabot rebase`) and
expect one re-approval.

Signing is machine-local: `commit.gpgsign` is in `~/.gitconfig` but
`user.signingkey` is tracked nowhere in this repo, so on a fresh box
`git commit` fails outright (`gpg failed to sign the data`) until the key is
configured. Fix the key -- never `commit.gpgsign=false`, which produces
commits the ruleset rejects only at merge time. No guard blocks it
(`bin/soak.sh` sets it false through `GIT_CONFIG` env, the one sanctioned exception). `guard-branch-isolation.mjs`
**is** installed on this repo's own root (see "Agent Operating Model" below)
and blocks a `packages/*/src/`/`packages/*/tests/` write while `HEAD` is
`main` -- but nothing in this repo's own hooks blocks committing any other
file straight to `main` locally; the ruleset is the remote-side catch: it rejects a
direct push to `main` at push time and gates a PR's merge at merge time, so
branch first regardless.

The ruleset is configured with `gh api`, not committed as JSON: GitHub never
reads a checked-in export, so it would drift silently, and a gate to keep it
in sync would be exactly the "checks documentation about the repo itself"
kind that `templates/core`'s caps pin at zero. Read the live state with
`gh api repos/monte3l/m3l-groundwork/rules/branches/main`. Maintenance that
needs a force-push means `PUT`ting the ruleset to `enforcement=disabled` and
back (a toggle GitHub is meant to log), not adding a bypass actor.
