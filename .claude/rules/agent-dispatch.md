---
paths:
  - ".claude/skills/**"
  - ".claude/agents/**"
---

# Subagent dispatch rules (hub-and-spoke TDD loop, truncation prevention & recovery)

> The terse checklist consulted when dispatching or resuming a spoke. No
> natural path-glob covers "dispatching a subagent," so this rule is also
> referenced from CLAUDE.md's Agent Operating Model section.

## The loop

Hub-and-spoke: the hub plans and dispatches, and never writes `src/`/test
code itself — enforced by `guard-hub-src-writes.mjs` and
`disallowedTools: Agent` on every spoke. For a piece of work with a clear
contract (a documented behavior, an interface to satisfy):

1. `test-author` writes failing tests from the contract (RED) and confirms
   they fail for the right reason.
2. `code-implementer` makes them pass with the minimal correct implementation,
   then refactors while green (GREEN).
3. Read-only reviewers (`code-reviewer` always; `silent-failure-hunter` when
   the change has try/catch, async/await, or retry/poll logic;
   `baseline-impact-reviewer` when the diff touches `templates/core/` or
   `templates/packs/`) run in parallel over the diff. Must-fix findings
   route back to `code-implementer` and the loop repeats until clean.

**Spokes do not nest, and their `permissionMode` is not a safety property.**
Claude Code lets a subagent spawn its own, three layers deep by default
(`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`); every spoke here sets
`disallowedTools: Agent`, which is what keeps the roster flat. A session in
auto, `acceptEdits` or `bypassPermissions` mode overrides a spoke's
`permissionMode` (the field applies only under `default`, `dontAsk` or
`plan`), so `acceptEdits` on the writer spokes is often inert. The PreToolUse
guards bound a spoke, not `permissionMode`. Source:
[sub-agents](https://code.claude.com/docs/en/sub-agents).

## Guard limits and overrides (detail)

Sources: [hooks](https://code.claude.com/docs/en/hooks),
[hooks guide](https://code.claude.com/docs/en/hooks-guide),
[managed settings](https://code.claude.com/docs/en/managed-settings),
[mods events](https://code.claude.com/docs/en/plugins/mods/events),
[sub-agents](https://code.claude.com/docs/en/sub-agents) and
[agent teams](https://code.claude.com/docs/en/agent-teams).

- **The `Bash` screen is conservative.** `guard-hub-src-writes.mjs` blocks
  redirects, `tee`, `sed -i`, `cp`/`mv` into a guarded path, an interpreter
  snippet that writes there, and a copy, move or removal of a parent
  (`rsync -a /tmp/x/ ./`, `rm -rf .`). It cannot see an interpreter running a
  script from a project file, an `eval`, a computed path, a parent of the
  project root (`rm -rf ..`), a workspace container below the project root, a
  build step, a formatter or fixer (`prettier --write`, `eslint --fix`),
  `git rm`/`git mv`, `find -exec`, `xargs` with a computed operand,
  `tar`/`curl -o`, or a very long interpreter call (allowed with a stderr
  note).
- **Managed settings outrank every project file.** A `managed-settings.json`
  file, an MDM policy or a console-managed policy has no project-level
  override, and `allowManagedHooksOnly` and `allowManagedPermissionRulesOnly`
  mean only managed hooks run and only managed permission rules apply. The
  file lives outside any working tree, so nothing here can detect it. On a
  machine you don't control, run `/status` and read its "Setting sources"
  line: if `guard-hub-src-writes.mjs` and `guard-branch-isolation.mjs` aren't
  running, treat hub-and-spoke as an unenforced checklist.
- **An installed mod sits below managed settings and above project hooks.** A
  mod that handles `tool.check` can approve a call a non-managed `PreToolUse`
  hook blocked, and project `PreToolUse` hooks run only after the last mod
  calls `next`. Only managed hooks outrank a mod. Check `/plugin` alongside
  `/status`.
- **Who counts as a writer.** The guard needs a writer-spoke `agent_type` and a
  non-empty `agent_id`. A fork subagent (on by default in every surface since
  Claude Code 2.1.302) is not a writer spoke, so unless its payload reports a
  writer `agent_type` it is treated as the hub (the docs don't say what a
  fork's payload carries). A fork cannot spawn further agents. With agent teams on, an in-process
  teammate has a documented `agent_id`; one built from a writer definition that
  also reports that `agent_type` passes as a writer. A split-pane teammate does
  not get `disallowedTools` (only an in-process one does), so every spoke's
  `tools` list also omits `Agent`.
- **What `onFailure: "block"` covers.** A failure is a hook that cannot start,
  times out, exits with any code other than 0 or 2, or prints invalid JSON. It
  has no effect on `Stop`, `SubagentStop`, `TaskCompleted`, `TeammateIdle` or
  async hooks.

## Dispatch sizing

- **Decompose before you dispatch.** Scale the dispatch to task complexity —
  a module spanning many files gets split into bounded sub-dispatches up
  front, not handed to one spoke as an indivisible turn. A single-file test
  suite over ~40 tests, or a fix round over ~5 findings, splits into
  checkpointed batches the same way. Hand a spoke an explicit file list
  **and** a byte/file-count budget, measured before dispatch; a spoke told
  the ceiling shrinks the file instead of ratcheting the baseline.
- **Size a FIX round by file, not by finding count.** Regroup findings by
  file — one spoke per file (or tight file group), every finding for that
  file in one prompt — so each spoke loads one file's context. This also
  removes write conflicts, so spokes can run concurrently.
- **Bound review-spoke INPUT scope too, not just output.** Give each review
  spoke a tight per-spoke file list (2–5 files) and split a review dispatch
  by concern once the diff exceeds ~3–4 files or a few hundred lines. Every
  review-spoke prompt also carries a **converge and report** instruction —
  stop once its checklist is answered rather than re-verifying indefinitely.
- **Pre-resolve the facts a writer would otherwise discover, not just its
  output scope.** Discovery, not writing, is what exhausts a turn budget.
  Resolve the exact fixture contents, a collaborator's return shape, and the
  precise `file:line` anchors yourself before dispatch, so the spoke's first
  tool call is a write, not a search.
- **Two independent review lenses landing on the same line is signal, not
  redundancy.** Treat a convergent finding as confirmed and fix it — never
  discount the second report as a duplicate of the first.
- **Re-review every substantive fix round, bounded.** Must-fix fixes are new
  writer code with no reviewer between them and the commit. Dispatch a
  focused confirmation pass — the reviewer(s) whose findings drove the fixes,
  scoped to the changed files only — before declaring the review loop
  closed.
- **Don't raise the turn-limit as the fix.** More context/turns is not free
  — accuracy degrades as token count grows. Scoping, journaling, and pacing
  are the preferred levers.

## Journaling & recovery

- **Hand writer spokes (`test-author`, `code-implementer`) an explicit
  journal path** in the dispatch prompt.
- **Never trust a "final" report at face value.** A mid-thought fragment is
  the signature of a truncated turn, not a benign quirk — verify on-disk
  state yourself (the spoke's journal, `git status`/`git diff`, re-run
  typecheck/lint/test/coverage) before deciding what's actually done.
- **A spoke's scratchpad journal doesn't survive a session-level restart,
  but its git-worktree edits do.** After a harness/process restart
  mid-dispatch, check `git status`/`git diff` **in the worktree the spoke
  ran in**, not this repo's own root — the edits may already be there even
  with no journal left to read.
- **A coherent-looking report can still be wrong — a separate failure mode
  from truncation.** Re-verify a fix round's completion (re-read the diff,
  re-run the gates) regardless of how confident the report reads.
- **Resume the SAME spoke via a follow-up message**, never a fresh
  dispatch — a fresh agent has no memory of the prior exploration and
  restarts the whole budget from zero. Hand it a punch-list, not a recap.
- **Verification can conclude "no resume needed."** A truncated return whose
  artifacts are already on disk (files written, gates green when you run
  them yourself) needs no resume at all — re-running the verification
  battery from the hub is cheaper. Reserve resumes for truncations where the
  work itself is genuinely unfinished.

## Boundaries

- **Review spokes return a bounded digest**, not an open-ended report — the
  full report travels back inline in the response, capped at roughly 8,000
  characters (~2,000 tokens). No review spoke writes a scratchpad file.
- **Do not assume plan mode makes a dispatched subagent read-only.** A
  live probe on Claude Code 2.1.296 (2026-10-11) dispatched `test-author` and
  a `general-purpose` agent from a session in plan mode, each told to write
  one file outside the repo: both writes succeeded. Anthropic's
  [subagent docs](https://code.claude.com/docs/en/sub-agents.md) say a
  subagent that sets its own `permissionMode` keeps it, and our writer
  spokes set `acceptEdits`. The main session itself may still decline to
  dispatch a writer in plan mode. If a design depends on a subagent writing
  or not writing a file, verify with `git status`/`ls` after the dispatch
  rather than trusting the return value's success claim.
- **A `SubagentStop`/`PreToolUse` hook flagging a dispatch is a prompt to
  verify, not a replacement for verifying.** Treat its stderr reminder as a
  signal to check state yourself.
- **A hook that visibly fails to fire may be an Enterprise-managed override,
  not a bug in the hook.** If `guard-hub-src-writes.mjs`/
  `guard-branch-isolation.mjs` let a top-level `packages/*/src/`/`tests/`
  write through unblocked, check `/status`'s "Setting sources" line for a
  managed source before debugging the hook script itself -- a managed
  `allowManagedHooksOnly` policy (CLAUDE.md's "Agent Operating Model")
  runs only managed hooks, with no repo-visible signal that it's
  active.
- **A templated dispatch prompt needs a per-target assumption check, not
  just a per-target file-list check.** Verify the template's implicit
  assumptions against each target's own docs/tests before dispatch, not
  just the file scope — a defect here can be semantically wrong but
  syntactically valid, passing typecheck/lint/build clean.
- **Make barrel/index wiring its own numbered, separately-verified step in
  any multi-file dispatch.** It's the step most often left for last, so it's
  the step truncation most often lands on — a missing re-export line passes
  the suite green while nothing in the new module is actually reachable.

## Before wiring a new hook or workflow script

- **Run it against known-good input before wiring it, not only against the
  failure cases it was built from.** An advisory hook that fires on every
  event of a type must be proven **quiet** on that type's normal output; one
  that cries wolf trains the reader to ignore it, which is worse than not
  shipping it.
- **A live end-to-end run on a small real input is the acceptance test for a
  script — static gates and review passes cannot see runtime behavior.**
  Review reads a hook or workflow script; nothing else runs it.
