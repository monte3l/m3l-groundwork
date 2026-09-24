---
name: creating-prs
description: >-
  Verify quality gates, push the branch, open a PR with a Conventional Commit
  title and body from commit history, then decide and execute its merge
  path. Use for /creating-prs, "open a PR", "create a pull request", "ship
  this for review", "get this merged", or after finishing a fix. Requires gh
  CLI auth.
---

# creating-prs

Takes a branch with committed work from "ready" to "opened, gated, and
merged (or left for human review)". Assumes `starting-work` already put you
on the right branch.

## Steps

### 1 — Preflight

Confirm you're not on `main` and the tree is clean (`git status --porcelain`
empty, or everything intentionally staged). If dirty, resolve before
continuing — an uncommitted file left behind silently ships in the next
commit on this branch.

### 2 — Resync with `origin/main`

```bash
git fetch origin
git rebase origin/main
```

A branch that has drifted from `main` over a long session risks a conflict
surfacing at merge time instead of now, when it's cheaper to resolve.

### 3 — Run the full quality gate

```bash
pnpm verify
```

This is the one command that reproduces what CI runs. Fix everything it
reports before pushing — a red `pnpm verify` becomes a red CI run and a
round-trip that costs more than fixing it now.

### 4 — Pre-push review (optional but recommended)

For anything beyond a trivial change, dispatch `code-reviewer` (and
`silent-failure-hunter` if the diff has error-handling paths) over the diff
before pushing. Catching a Must-fix here is strictly cheaper than catching
it after a human reviewer has already looked.

### 5 — Push

```bash
git push -u origin <branch>
```

Never `git push --force` a shared branch — if history was rewritten
(a rebase), use `--force-with-lease` and only when you're certain no one
else has pushed to this branch.

### 6 — Gather commits since `main`

```bash
git log origin/main..HEAD --oneline
```

This is the raw material for the PR title and body — read every commit
message, don't just count them.

### 7 — Title

A Conventional Commit–shaped title summarizing the PR as a whole (not just
the first commit): `<type>: <subject>`, same rules as an individual commit
subject (imperative, ≤70 chars, lowercase after the colon). If the PR
contains a `feat!:` commit, the title carries `!` too.

### 8 — Body

Structure:

```
## Summary
<1-3 sentences: what this PR does and why>

## Changes
- <bullet per meaningfully distinct change, not per commit>

## Semver impact
<one sentence: what changed in the public surface, or "none">

## Test plan
<how this was verified: `pnpm verify` passing, plus anything manual>
```

### 9 — Submit

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

### 10 — Confirm mergeability

```bash
gh pr view --json mergeable,mergeStateStatus
```

If `mergeable: "CONFLICTING"`, resolve the conflict before proceeding to the
next step — don't arm auto-merge on a PR that can't merge.

### 11 — Decide the merge path

- **CI is required and passing, and the change is low-risk** (docs, a
  mechanical chore, a well-reviewed small fix): arm auto-merge
  (`gh pr merge --auto --squash`) and move on — `finishing-work` picks up
  once it actually merges.
- **The change is substantive** (a new public symbol, a behavior change, a
  breaking change): leave the PR open for human review. Report the PR URL
  and stop here.
- **CI is still running and the change is low-risk**: arm auto-merge anyway
  — it fires the moment checks pass, no need to poll.

## Notes

- Use the `gh` CLI for every GitHub operation in this skill (issue/PR reads,
  mutations, checks) rather than the raw REST API.
- If the project has a PR template (`.github/pull_request_template.md`),
  read it first and follow its structure instead of the generic shape above.
