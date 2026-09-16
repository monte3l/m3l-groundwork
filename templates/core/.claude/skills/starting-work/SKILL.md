---
name: starting-work
description: >-
  The pre-work decision gate: inspects git state, recommends branch
  (feat/fix <slug>) and push target, decides whether a PR is required — all
  confirmed before any write. Invoke for "implement", "build", "fix",
  "refactor", even unnamed. Skip for research/questions.
---

# starting-work

This skill is the single place the project answers "where do I do this
work?" before touching anything. `guard-branch-isolation.mjs` hard-blocks
writes to `src/**` and `tests/**` while `HEAD` is `main` — that's a
backstop, not a plan: if you discover it when a write is rejected, you're
already mid-task with a dirty tree. This skill is the workflow half — it
branches _before_ the block can fire.

## The contract

**Infer and recommend all decisions, then confirm every one with the user in
a single round. Do not write files or create a branch until the user has
confirmed.** The user is always free to override a recommendation; your job
is to make the right default obvious, not to force it.

## Steps

### 1 — Inspect git state (read-only)

```bash
git rev-parse --abbrev-ref HEAD      # branch name; "HEAD" means detached
git status --porcelain               # is the tree already dirty?
```

- A detached HEAD sitting on the `main` commit is treated as `main` for
  isolation purposes — it's the same tree state the guard protects.
- **Re-run this inspection after any conversational gap, not just at the
  start.** The branch is not a stable fact across a long session.

### 2 — Infer the change scope

From the task in front of you, work out **which paths will be edited** and
whether any are _guarded_ (under `src/**` or `tests/**`). This drives the PR
decision and whether isolation is even required. A docs-only or `.claude/`
-only change touches no guarded path, so the guard won't fire and a PR may
be optional; a change under `src/` or `tests/` always needs isolation and a
PR.

### 3 — Recommend each decision

- **Branch** — recommend `feat/<slug>` (or `fix/<slug>` for a bug fix), with
  the slug derived from the task (kebab-case, short). If the repo is already
  on a suitable non-`main` branch, recommend **staying** on it. Never
  recommend `main` or a detached-on-`main` HEAD for guarded work.
- **PR required?** — **yes** whenever a guarded path is in scope: land via
  PR, never a direct commit to `main`. For docs/config-only changes, note
  that a PR is optional but still recommended.
- **Push target** — `origin <the recommended branch>`. Never `origin main`.

### 4 — Confirm with the user (blocking)

Ask every decision that applies in **one** `AskUserQuestion` call — branch,
PR-required, and push target — one question per decision, with your inferred
recommendation listed **first** and labelled "(Recommended)". For the
branch, offer the inferred `feat/<slug>` plus an "Other" path for a custom
slug. Make it explicit in your framing that **nothing is written and no
branch is created until they confirm** — this is the whole point of the
gate.

If the user has _already_ told you the branch to use (e.g. "do it on
`fix/foo`"), don't re-ask that dimension — treat it as confirmed and only
surface the decisions still open.

### 5 — Act on the confirmed decisions

```bash
git switch -c feat/<slug>   # or fix/<slug>
```

Verify `HEAD` is neither `main` nor detached-on-`main` before handing back;
if it is, loop back to Step 4 rather than proceeding into a write that the
guard will reject. When **resuming an existing feature branch** that may
have fallen behind, resync it with `origin/main` before working (or defer to
the resync step in `creating-prs`) so the branch does not drift from the
base over multiple sessions.

### 6 — Hand back

Report a one-line summary of the confirmed decisions — branch, PR
(yes/no), push target — so the calling skill or the user proceeds with the
context recorded.
