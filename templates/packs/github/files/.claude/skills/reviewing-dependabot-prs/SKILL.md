---
name: reviewing-dependabot-prs
description: >-
  Reviews every open Dependabot pull request, classifies each by semver bump
  level and CI check status, and proposes merge/hold/close per PR -- then
  acts only on the batch the user confirms, never a PR the user didn't
  approve. Use for /reviewing-dependabot-prs, "review the dependabot PRs",
  "triage dependency updates", or when several Dependabot PRs have
  accumulated. GitHub stance: gh CLI.
---

Triage every open Dependabot pull request in this repository: classify each
by how risky its bump is and whether its checks are green, propose an
action per PR, then act only on the batch the user actually confirms. This
skill never merges or closes a PR the user hasn't approved, and never
guesses at a version bump's safety from the checks alone -- a major bump is
always held for a human look, checks or no checks.

## Steps

### 1 — List every open Dependabot PR

```bash
gh pr list --search "author:app/dependabot" --state open --limit 100 --json \
  number,title,headRefName,isDraft,mergeable,statusCheckRollup
```

`--limit 100` avoids `gh pr list`'s 30-result default silently truncating a
large backlog. If this returns nothing, report that there is nothing to
triage and stop.

### 2 — Classify each PR's bump level

Dependabot's own titles follow `Bump <package> from <old> to <new>` (or
`Bump <package> in <dir> from <old> to <new>` for a monorepo/directory-scoped
config) -- but a project with a `commit-message.prefix` in its
`dependabot.yml` gets a prefixed, often-lowercased title instead, e.g.
`chore(deps): bump <package> from <old> to <new>`. Match case-insensitively
and allow an optional prefix before `bump`, then parse `<old>`/`<new>` and
compare them as semver:

- **major**: the leftmost _non-zero_ version segment differs (not simply
  the first segment -- under semver a `0.x` package treats its second
  segment as breaking, so `0.3.0 -> 0.4.0` is major, not minor). A major
  bump is a breaking-change risk by definition, regardless of check status.
- **minor**/**patch**: lower risk, but still gated on checks (next step).
- **unparseable** (a non-semver ecosystem, a grouped-update PR covering
  several packages, or a title that doesn't match the pattern even with the
  prefix/case allowance above): mark it **unknown** and never guess a risk
  level for it -- always propose _hold_ for a human look, and say why
  parsing failed.

### 3 — Classify each PR's check status and mergeability

`statusCheckRollup` mixes two entry shapes: a GitHub Actions **check run**
(carries `conclusion`) and a third-party **commit status** (carries `state`
instead -- no `conclusion` field at all). Read whichever field the entry
actually has, and reduce the whole set to one of:

- **green**: every entry's `conclusion` is `SUCCESS`, `NEUTRAL`, or
  `SKIPPED` (not a failure), or its `state` is `SUCCESS`.
- **red**: at least one entry's `conclusion` is `FAILURE`, `CANCELLED`,
  `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, or `STALE`, or its
  `state` is `FAILURE`/`ERROR`.
- **pending**: at least one entry is still queued/in-progress (`conclusion`
  absent, or `state: PENDING`) and none are red.
- **no checks configured**: `statusCheckRollup` is empty -- this is _not_
  the same as green; propose **hold** and say the repository has no CI
  configured for this PR, rather than treating silence as success.

Also read `mergeable`: a PR reported as `CONFLICTING` is never proposed for
merge regardless of bump level or check status. A draft PR (`isDraft:
true`) is never proposed for merge either.

### 4 — Propose an action per PR

| Bump level          | Checks    | Mergeable        | Draft | Proposal                                              |
| ------------------- | --------- | ---------------- | ----- | ----------------------------------------------------- |
| patch/minor         | green     | yes              | no    | **merge**                                             |
| patch/minor         | red       | any              | no    | **hold** -- name the failing check                    |
| patch/minor         | pending   | any              | no    | **hold** -- checks still running, re-check later      |
| patch/minor         | no checks | any              | no    | **hold** -- no CI configured, needs a human look      |
| any                 | any       | no (conflicting) | any   | **hold** -- merge conflict, needs a rebase/human look |
| major               | any       | any              | no    | **hold** -- breaking-change risk, needs a human read  |
| unknown/unparseable | any       | any              | any   | **hold** -- couldn't classify the bump safely         |
| any                 | any       | any              | yes   | **skip** -- draft PR                                  |

For a **held** PR whose changelog or release notes look clearly abandoned,
irrelevant, or superseded by a newer PR for the same package, note **close**
as an alternative to raise with the user in the next step -- this skill
never closes a PR on its own initiative, only on explicit confirmation.

### 5 — Present the report and confirm the batch

Show one table: PR number, title, bump level, check status, mergeable,
proposed action. Then ask the user which of the **merge**-proposed PRs to
actually merge, and separately whether any **held** PR should instead be
**closed** -- offer "all of them", a subset by number, or none for each.
Never treat silence or a general "looks good" as consent to act; get an
explicit list or an explicit "yes, all of them" for merges, and a separate
explicit confirmation for any close.

### 6 — Act only on the confirmed batch

For each confirmed merge:

```bash
gh pr merge <number> --squash --auto
```

Prefer `--squash` (the common convention for a Dependabot PR), but if `gh`
rejects it (squash merges disabled by the repository, or "Allow auto-merge"
itself is off -- GitHub's own default), fall back to whichever merge method
the repository actually allows (`--merge`/`--rebase`, or drop `--auto` and
report that the PR is ready but must be merged by hand) rather than treating
the rejection as this skill's own failure. `--auto` arms auto-merge rather
than forcing an immediate merge -- if the repository's branch protection
requires checks or reviews, the merge still waits for those; this skill does
not bypass a repository's own merge rules. If `gh pr merge` reports the PR
isn't mergeable (a conflict, a newly-failed check since step 1), report that
PR's failure and continue with the rest of the batch rather than aborting it.

For each confirmed close:

```bash
gh pr close <number> --comment "<one-line reason from step 4>"
```

### 7 — Report outcomes

Summarize what was merged, what's queued behind `--auto`, what was closed,
and what was held or skipped, with a one-line reason for every held/skipped/
closed PR.
