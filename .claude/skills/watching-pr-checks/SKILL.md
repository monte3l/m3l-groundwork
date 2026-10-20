---
name: watching-pr-checks
description: >-
  Checks a pull request's CI status via gh pr checks: reports ready-to-merge
  and asks before merging on green, or reads the real failing job log and
  hands off to /triaging-ci on red -- never guesses at a failure from the
  check name alone. Use for /watching-pr-checks, "check this PR's status",
  "is this PR ready to merge", "did CI pass on my PR". GitHub stance: gh
  CLI.
---

Check one pull request's CI status and act on what the checks actually
say, rather than assuming green or guessing at a failure. This is a
single check, not a polling loop -- if checks are still running, report
that plainly and let the user decide whether to ask again later or wait.

## Steps

### 1 — Resolve the PR

If the user gave an explicit PR number or URL, use it. Otherwise, resolve
the PR for the current branch:

```bash
gh pr view --json number,headRefName,state
```

If there is no PR for the current branch, or its `state` isn't `OPEN` (a
merged or closed PR still resolves by branch name), say so and stop --
there is nothing to watch.

### 2 — Check status

```bash
gh pr checks <number> --json name,bucket,link,workflow
```

`bucket` (not `conclusion` -- `gh pr checks --json` has no `conclusion`
field) is the ready-made summary each check reduces to: `pass`, `fail`,
`pending`, `skipping`, or `cancel`. Reduce the whole set to one of:

- **all green**: every check's `bucket` is `pass` or `skipping`.
- **still running**: at least one `pending` and none `fail`/`cancel`.
- **failed**: at least one `fail` or `cancel`.
- **no checks configured**: the list is empty -- report this plainly rather
  than treating it as either green or failed; there is nothing to watch
  until the repository has CI wired up for this PR.

### 3a — All green

Report the PR is ready to merge, name every check that passed, and ask the
user before merging -- never merge without that confirmation, even when
every check is green:

```bash
gh pr merge <number> --squash --auto
```

If `gh` rejects `--squash --auto` (squash merges disabled, or "Allow
auto-merge" itself is off -- GitHub's own default), fall back to whichever
merge method the repository actually allows, or drop `--auto` and report
that the PR is ready but must be merged by hand -- don't report the
rejection as this skill's own failure. (`--auto` respects any
branch-protection requirement still pending -- see
`reviewing-dependabot-prs`'s step 6 for the same reasoning if that skill is
also installed.)

### 3b — Still running

Report which checks are still pending and which have already passed. Do
not guess at the eventual outcome. Suggest the user re-invoke this skill
in a few minutes, or -- if the calling session supports scheduling a
recurring check -- offer to check again automatically rather than blocking
on a manual re-ask.

### 3c — Failed

Do not report the failure from the check's name alone -- pull the actual
job log before describing what went wrong. The failing check's `workflow`
field distinguishes a GitHub Actions run (has a log `gh run view` can read)
from a third-party check (a status-only integration with no run to fetch):

```bash
gh run view <run-id> --log-failed
```

(`<run-id>` comes from the failing check's `link`, a
`.../actions/runs/<run-id>/job/...` URL -- a check with no such `link`, or
whose `workflow` is empty, is from an external app; report its `link` and
that no log is available to read rather than guessing at why it failed.)
Once the real failure is in hand, hand off to `/triaging-ci` (if the
project has it installed) to map the failure to its root cause and present
fix options -- this skill's own job ends at "here's what actually failed
and why," not at proposing or applying a fix.
