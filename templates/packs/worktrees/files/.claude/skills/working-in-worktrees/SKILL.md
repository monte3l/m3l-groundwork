---
name: working-in-worktrees
description: >-
  Creates, lists, syncs, and safely tears down an isolated git worktree per
  unit of work -- required once the `worktrees` pack is installed, since
  `guard-worktree-only.mjs` blocks every src/tests write outside one, on any
  branch. Use for /working-in-worktrees, "start a worktree", "work in a
  worktree", "what worktrees are open", "sync this worktree with main", or
  "finish this worktree" -- and from `starting-work`'s own branch step, which
  hands off here automatically when this skill is installed.
---

# working-in-worktrees

Once this pack is installed, `guard-worktree-only.mjs` blocks a src/tests
write outside a linked worktree under `.claude/worktrees/` -- on any branch,
for any caller. `starting-work`'s plain `git switch -c` is no longer enough
by itself: it puts you on the right branch, but not inside a worktree the
guard will accept. This skill is the missing piece.

Hub-only. Never dispatched as a spoke's own tool.

## Modes

### start `<slug>`

1. `git fetch origin` (or the project's own default-branch equivalent).
2. Create the worktree with a plain `git worktree add .claude/worktrees/<slug> -b feat/<slug> origin/main`
   (or `fix/<slug>` for a bug fix) -- **not** `EnterWorktree(name: <slug>)`,
   which names the branch `worktree-<slug>` instead. Create it with the
   final branch name up front, so no rename is ever needed.
3. `EnterWorktree(path: .claude/worktrees/<slug>)` to switch the session's
   working directory into it (this is the documented way to adopt session
   tracking for a worktree you created yourself -- see the tool's own "on
   first entry from the launch directory, the path must appear in
   `git worktree list`" note).
   **Known side effect:** Claude Code's `EnterWorktree`/`ExitWorktree` have
   been reported to leave `core.bare = true` in the main repository's shared
   `.git/config` (anthropics/claude-code#58345, #69802, both closed "not
   planned"), which breaks `git status` in the main checkout while worktrees
   keep working. This pack's `repair-core-bare.mjs` hook resets it after
   either tool runs; if `git status` ever says "this operation must be run in
   a work tree", the manual fix is `git config --local core.bare false`. Prefer
   the `path:` and `keep` forms used in this skill; `EnterWorktree(name: ...)` and
   `ExitWorktree(remove)` are the calls the upstream reports tie to it.
4. Copy any of `.env`, `.env.local`, `.env.*.local` that exist in the main
   checkout into the new worktree (the same list as `.worktreeinclude`). `.worktreeinclude` (this pack ships one) only fires for a
   worktree Claude Code itself creates -- since this skill creates the
   directory with plain `git worktree add`, that processing never runs here,
   so the copy is done by hand.
5. `pnpm install --frozen-lockfile --prefer-offline` inside the worktree.
   `ensure-worktree-deps.mjs`'s own `SessionStart` hook is a backstop for
   `claude --worktree`/a resumed session, not a substitute for this step --
   it does not fire on a mid-session `EnterWorktree`, which is what steps 2-3
   just did.

### status

`git worktree list --porcelain`, then for each entry under
`.claude/worktrees/`: ahead/behind counts against its upstream
(`git rev-list --left-right --count <branch>...origin/<branch>`), dirty
state (`git -C <worktree> status --porcelain`), and whether it's locked
(a `locked` line in the porcelain output).

### sync `<slug>`

Inside `.claude/worktrees/<slug>`: `git fetch origin` then
`git rebase origin/main`. Report a conflict rather than resolving it
silently -- the person driving decides how. If this branch was already
pushed and has an open PR, a rebase means the next push needs
`--force-with-lease`, never a bare `--force` (CLAUDE.md's "never
`git push --force`") -- confirm with the user before that push, the same
as `creating-prs`'s own resync step does.

### finish `<slug>`

The identical safe sequence `finishing-work`'s own worktree-aware steps
use, applied here directly (this skill's `finish` mode and that skill's
Step 2/4 exist for the same reason and must never drift apart):

1. Confirm the PR for this branch actually merged (`gh pr view --json
state,mergedAt`) -- never remove a worktree whose work never landed
   without asking first. Then `git fetch origin` and run
   `git log feat/<slug> ^origin/main --oneline`: a squash merge never makes
   the branch's commits ancestors of `main`, so a non-empty result is either
   the squashed originals (expected) or a commit added after the PR merged
   that is about to be abandoned -- compare it with the merged PR's commits
   and ask before going further, exactly as `finishing-work` Step 4 does.
2. If the session is still inside this worktree, `ExitWorktree(keep)` to
   return to the main checkout.
3. `git -C .claude/worktrees/<slug> status --porcelain` must be empty --
   investigate first if not. This only sees tracked/untracked-but-not-
   ignored changes; it says nothing about a gitignored file (a `.env`, an
   in-progress scratch file) that exists ONLY in this worktree, so **confirm
   with the user before removing**, not just when `status --porcelain` is
   non-empty.
4. `git worktree unlock .claude/worktrees/<slug>` -- only if locked, and
   only after confirming with the user.
5. `git worktree remove .claude/worktrees/<slug>` -- confirmed per step 3.
6. `git worktree prune`.
7. `git branch -d feat/<slug>` (or `-D` only with the user's go-ahead, per
   the same squash-merge reasoning `finishing-work` documents).

### fan-out

For genuinely independent units of work only -- not the sequential TDD
pipeline below. Dispatch each independent unit to its own subagent with
`isolation: "worktree"` in the Agent call; Claude Code creates and tracks
that worktree automatically (base ref governed by the `worktree.baseRef`
setting, default `"fresh"` = the remote default branch). Each unit's result
becomes its own PR -- a fanned-out worktree is not a place to accumulate one
combined change across several unrelated units.

`ensure-worktree-deps.mjs` only runs at `SessionStart`, so a worktree created
this way has **no `node_modules`** when its subagent starts: the first
`post-edit-verify` run would stop with a "no node_modules" error. Put the
install in every fan-out brief as its first step (`pnpm install
--frozen-lockfile --prefer-offline` inside that worktree) -- and dispatch a
writer spoke for it, since a read-only spoke cannot run it when the
`harness-extras` pack's `guard-readonly-bash` is installed.

## Policy

- **One worktree per unit of work.** Don't reuse a worktree across unrelated
  tasks, and don't split one task across worktrees.
- **The TDD pipeline runs sequentially inside the SAME worktree, with no
  `isolation` on any spoke.** `test-author` writes the failing tests,
  `code-implementer` makes them pass, and the review spokes read the diff --
  all inside the one worktree `start` created. A spoke dispatched from a hub
  session that is itself inside a worktree inherits that same isolation
  (Claude Code's own enforcement explicitly covers "every subagent Claude
  spawns from the isolated session"), so this is safe by construction: a
  spoke given its own separate `isolation: "worktree"` here would branch
  from `baseRef` and never see the RED tests `test-author` just wrote.
- **Per-call `isolation: "worktree"` is only for the fan-out case above** --
  independent units with no shared in-progress state to see.
- **Never `git stash` inside a worktree.** The stash stack is shared across
  every worktree of a repository; stashing here can silently pop into (or
  clobber) unrelated work in the main checkout or another worktree.
