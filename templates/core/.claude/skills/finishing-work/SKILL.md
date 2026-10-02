---
name: finishing-work
description: >-
  Runs the post-merge close-out tail creating-prs doesn't: verifies the PR
  actually merged, returns to main and pulls, deletes the merged local
  branches, prunes stale remote refs, and prompts for a work log. Use for
  /finishing-work, "clean up after this PR", "the PR merged, wrap this up",
  "delete the merged branches", "prune stale remote refs", or when a merged
  branch or stale refs linger -- even when it sounds like a one-line git
  command, because deleting a branch that never merged loses work and this
  skill checks first. GitHub stance: gh CLI.
---

# finishing-work

`creating-prs` ends with "decide the merge path" — it owns the merge itself,
but nothing checks whether that merge actually happened, let alone cleans up
afterward. Left undone, that residue accumulates silently: a stale local
branch, stale remote-tracking refs, an orphaned dispatch journal in the
scratchpad. This skill is that missing owner.

## Steps

### 1 — Confirm the PR actually merged

Don't assume "the user said it merged" is enough — verify:

```bash
gh pr view --json state,mergedAt,headRefName,baseRefName
```

- `state: "MERGED"` with a non-null `mergedAt` → proceed.
- `state: "OPEN"` → stop; the merge decision hasn't been made yet. Point back
  at `creating-prs`'s merge-path step.
- `state: "CLOSED"` with a null `mergedAt` → stop; the PR was closed without
  merging. Ask whether the branch should still be cleaned up (abandoned work)
  or left alone.

Record `headRefName` — every later step operates on this branch, not
whatever the user typed.

### 2 — Check for a linked worktree

`headRefName` may be checked out in a linked worktree (created by
`claude --worktree`, the `EnterWorktree` tool, or `git worktree add`) rather
than in the main checkout directly — check before assuming otherwise:

```bash
git worktree list --porcelain
```

If a worktree has `headRefName` checked out:

- **If the session entered it via `EnterWorktree`/`--worktree` and is still
  there**, use the `ExitWorktree` tool (keep, don't remove — removal happens
  safely in Step 4, after the merge-ancestry check) to return to the main
  checkout _first_. `git checkout main` below fails outright ("already used
  by worktree") because `main` is already checked out in the main worktree —
  git refuses to check out the same branch in two places at once, regardless
  of which branch the other worktree happens to be on. (If the session
  merely `cd`'d into a plain `git worktree add` checkout — no `EnterWorktree`
  involved — `ExitWorktree` has nothing to exit; just `cd` back to the main
  checkout instead.)
  After `ExitWorktree`, run `git config core.bare`: Claude Code's worktree
  tools have been reported to leave it `true` in a normal repository's shared
  config (anthropics/claude-code#58345, #69802), which breaks `git status`
  here. If it prints `true`, run `git config --local core.bare false` before
  going on.
- Otherwise, no action needed yet — just remember the worktree's path for
  Step 4.

### 3 — Return to `main` and pull

```bash
git checkout main
git pull
```

Skip this if already on `main` with nothing to pull.

### 4 — Delete the merged branch

**Before removing anything, confirm no backgrounded command (a `git push`,
a verify run, or similar) is still running against the branch you're about
to delete.** Once a PR has GitHub auto-merge armed, a `git push` updating it
after opening is racing the merge, not safely queued behind it. If a
follow-up commit must land in the _same_ PR, verify the push landed and the
PR still shows it as HEAD _before_ proceeding, or accept it may need a
follow-up PR instead.

Squash-merged branch commits are never ancestors of `main`, so "the PR
merged" does not mean every commit on the branch landed. Run `git log
<branch> ^origin/main --oneline` before any branch-deleting cleanup — a
non-empty result is a commit about to be abandoned, not noise.

**If Step 2 found a linked worktree for this branch, remove it before
deleting the branch** — `git branch -d`/`-D` refuses a branch that's still
checked out anywhere. `status --porcelain` only reports tracked and
untracked-but-not-ignored changes — it says nothing about a gitignored file
that only exists in this worktree (a `.env`, an in-progress scratch file),
so **confirm with the user before running `remove`**, the same as `unlock`,
rather than treating an empty `status --porcelain` alone as proof there's
nothing to lose:

```bash
git -C <worktree-path> status --porcelain   # must be empty; investigate first if not
git worktree unlock <worktree-path>          # only if locked, and only after confirming with the user
git worktree remove <worktree-path>          # confirm with the user first -- see above
git worktree prune
```

Then delete the branch itself:

```bash
git branch -d <headRefName>
```

If `git branch -d` refuses (not merged into its base by ancestry — expected
after a squash merge), don't force-delete without asking: confirm the merge
really landed via `gh pr view` above, then use `git branch -D <headRefName>`
only with the user's go-ahead.

### 5 — Prune stale remote-tracking refs

```bash
git fetch --prune
```

Cheap and safe regardless of the branch outcome above — clears the
`[deleted]` marker for this and any other already-merged branch's remote
ref.

### 6 — Work log check

If the project keeps work logs (check whether a `docs/logs/` directory or
equivalent convention exists), apply a substance test, not a commit-type
filter: skip silently for a mechanical merge with no narrative (a dependency
bump, a formatting sweep). Otherwise, ask whether one should be written now
before moving on — real-time context degrades fast once the session that did
the work is gone.

**If a log is written here, commit and land it immediately** (its own small
`docs:` commit via `writing-commits`) before moving on to any other task,
rather than leaving it as an uncommitted file. **"Commit it" does not mean
commit directly to `main`** — branch first (`git switch -c docs/<slug>-log`),
commit there, push, and open a PR, even for a trivial docs-only change, if
the project requires a PR for every change to `main`.

### 7 — Orphaned journal sweep

Check the scratchpad directory for any writer-spoke dispatch journal older
than the current task that has no corresponding open work — ask before
deleting, since a file from a different, still-in-progress task can look
identical to a genuine orphan.

### 8 — Report

One-line summary: worktree removed (if any), branch deleted (or kept, with
why), refs pruned, work log present/written/skipped, journals swept/left.

## Notes

This skill is read-and-confirm heavy by design — every destructive step
(worktree unlock/removal, branch delete, journal delete) asks first rather
than assuming. A cautious, always-asks tail beats no tail at all.
