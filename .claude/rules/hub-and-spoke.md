---
paths:
  - ".claude/hooks/**"
  - ".claude/agents/**"
  - ".claude/settings.json"
---

# Hub-and-spoke guard detail and the root harness inventory

> Moved verbatim from the root `CLAUDE.md` ("Agent Operating Model") so it
> loads when you edit the hooks, agents or settings it describes. The root
> file keeps the loop and the forbidden-patterns list.

**The guard covers `Bash` as well as `Write|Edit`, but it raises the bar
rather than proving anything.** `guard-hub-src-writes.mjs` also runs on every
`Bash` call (registered under the `Bash` matcher too -- same file, no extra
hook, so the baseline's 10-hook cap is untouched) and applies the same
writer-spoke allowlist to a conservative scan of `tool_input.command`: it
blocks output redirects, `tee`, `sed -i`/`perl -i`, `cp`/`mv`/`install`/
`rsync`/`ln` into a guarded path, `rm`/`unlink`/`touch`/`truncate`, `dd of=`,
`patch`/`git apply` whose patch headers name a guarded path, a copy into, move
of, or removal of an ancestor of a guarded directory (the project root,
`packages`, `packages/<pkg>`, or a glob over them: `rsync -a /tmp/pkg/
packages/cli/`, `rm -rf packages/cli`, `rm -rf .`), and
`python`/`node`/`ruby`/`perl`/`php`/`deno`/`bun` inline code, heredocs or
out-of-project script files that write, delete or move a guarded path
(issue #96). It is a conservative screen with known misses, never a proof that a call writes nothing: an
interpreter running a script that lives inside the project, an `eval` of a
computed string, a build step or generator that writes `src/`, a formatter or
fixer (`prettier --write`, `eslint --fix`, `pnpm lint:fix`), `git rm`/`git mv`/
`git stash pop`, `find -exec`, `xargs` with no literal operand, a call whose argument list is
longer than the scanner's size cap (allowed with a stderr note), a target
spelled through a variable or command substitution, an ancestor spelled in a
way the lexical check does not recognise (a container other than `packages`, `apps` or `libs`, a parent of the project root (`rm -rf ..`), a workspace container below the project root,
a linked worktree's own root), and `tar`/`curl -o`/`git checkout|restore` all
pass. So hub-and-spoke stays a convention backed by a guard that raises the
bar, not
a proof; the `main` ruleset is the real backstop, and dispatching the review spokes is a hub convention, not enforced.
The maintainer's override is to run the command yourself with the `!`
prefix at the Claude Code prompt (it runs directly, not as a tool call, so
the `PreToolUse` guard is not in its path; upstream does not document hook
behaviour for it either way) or to
edit the hook's registration in `.claude/settings.json`; no flag or
environment variable turns the guard off.

**A Claude Code Enterprise/managed deployment sits above this and can
silently disable it.** Anthropic's settings precedence puts managed
settings (a `managed-settings.json` file, an MDM policy, or a
claude.ai-console-managed remote policy) above every project file, with
no override except a few security-sensitive keys where a stricter
lower-level value still wins. Two managed-only keys narrow this repo's own
`.claude/settings.json` further: `allowManagedHooksOnly` limits hooks to
the ones the organization deploys, and `allowManagedPermissionRulesOnly`
makes managed settings the only source of permission rules (see
[Claude Code's managed-settings docs](https://code.claude.com/docs/en/managed-settings)).
Nothing in this repo's own files can detect or gate against that -- the
managed file lives outside any project's working tree, at an OS-level path
(`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
`/etc/claude-code/managed-settings.json` on Linux, an equivalent under
`Program Files` on Windows), so `bin/check-harness.mjs` has no on-disk fact
to check and this is a documented limit, not a gate. Run `/status` before
trusting hub-and-spoke enforcement on a machine you don't control: its
"Setting sources" line lists each settings file loaded and marks
the managed one, and if
`guard-hub-src-writes.mjs`/`guard-branch-isolation.mjs` aren't among what's
actually running, treat this section as an unenforced checklist rather than
an enforced gate until confirmed otherwise.

**An installed Claude Code mod is a second silent override, below managed
settings.** Mods (plugin-shipped TypeScript handlers) are on by default from
Claude Code 2.1.286 (the upstream mods admin page documents no terminal or
desktop split). Per the
[mods events guide](https://code.claude.com/docs/en/plugins/mods/events), a mod
that handles `tool.check` can approve a call that a `PreToolUse` hook outside
managed settings blocked, and project `PreToolUse` hooks run
only after the last mod calls `next`, so a mod that answers `tool.call`
without it keeps them from running at all (same page).
Only managed-settings hooks outrank a mod. Same limit as above: nothing in
the repo can detect it. Run `/plugin` alongside `/status` before trusting the
guards on a machine you don't control: upstream says a terminal session shows a
dim `N mods active` line there naming the mods it loaded, and lists built-in
mods separately under the Installed tab's **Built-in** heading. Upstream's
reference page says the built-in `sec-default` guard (shown as
`cc-plugin-sec-default`) loads ahead of user-installed mods only on a machine
with managed settings or for a user signed in with a Team or Enterprise plan.

**The guard keys on `agent_id` as well as `agent_type`.** A call counts as a
writer spoke only with both present, so a call carrying `agent_type` but no
`agent_id` is treated as the hub and is blocked.

**Agent teams (experimental) are not covered or verified.** A split-pane
teammate is a full session with no `agent_id`, so the guard treats it as the
hub and blocks it (fail-closed). An in-process teammate has a documented
`agent_id` (hooks reference), but its `agent_type` is documented only for
subagents and `--agent` sessions, so whether one reports a writer
`agent_type` is unconfirmed. If it does, a teammate built from `code-implementer`
or `test-author` passes the guard as a writer spoke. A split-pane teammate does
not get `disallowedTools` (only an in-process one does), which is why every
spoke's `tools` list also omits `Agent`.

**Fork subagents are on by default in every surface since Claude Code 2.1.302**
(`CLAUDE_CODE_FORK_SUBAGENT=0` turns them off). A fork inherits the hub's
conversation and cannot spawn further agents. The docs don't say what its hook
payload carries; the guard treats it as the hub unless the payload reports a
writer `agent_type` together with an `agent_id` (a hub started with
`--agent code-implementer` could produce that), and the hub is blocked from
guarded paths.

**Guards that block on a crash, the secrets deny rule and `permissionMode`.**
The baseline's four invariant guards (`guard-secret-writes`,
`guard-hub-src-writes`, `guard-branch-isolation`, `guard-protected-paths`) carry
`"onFailure": "block"` (Claude Code 2.1.295 or later), so a hook that cannot
start, times out, exits with a code other than 0 or 2, or prints invalid JSON
blocks the call instead of letting it through; the style guards and `guard-git-push-signed` stay fail-open (the push
guard has its own parser, and the `main` ruleset rejects unsigned commits at
merge). `guard-hub-src-writes` is also on `Bash`, so a missing `node` blocks
every `Bash` call until fixed. `permissions.deny` carries `Read(./.env)`,
`Read(./.env.*)` and `Read(./secrets/**)`; it does not cover `grep -r` or a
script that opens the file. A session in auto, `acceptEdits` or
`bypassPermissions` mode overrides a spoke's `permissionMode`, so the hooks, not
that field, bound a spoke. Claude Code lets a subagent spawn subagents three
layers deep by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`);
`disallowedTools: Agent` keeps the roster flat.

Full dispatch-sizing and recovery guidance:
`.claude/rules/agent-dispatch.md` (auto-loads when editing
`.claude/skills/**` or `.claude/agents/**`). Path-scoped rules auto-load on
matching files the same way: `.claude/rules/src.md` on `packages/*/src/**`,
`.claude/rules/tests.md` on `**/tests/**`/`**/*.test.ts`,
`.claude/rules/refactoring.md` on both (behavior-preserving changes),
`.claude/rules/docs.md` on this repo's own markdown (`templates/**`
excluded, since it ships brand-neutral into every bootstrapped project) --
the m3l-design content conventions (bold not italics, GitHub alerts for a
must-not-miss point, plain copy, tabular data in tables) -- and six more
covering this repo's own area-specific surfaces: `.claude/rules/ci.md`,
`.claude/rules/releases.md`, `.claude/rules/design-system.md`,
`.claude/rules/docs-site.md`, `.claude/rules/environments.md`, and
`.claude/rules/evals.md` -- and twelve more, one per shipped artifact, for a
narrower focus than this file gives: `.claude/rules/package-cli.md` on
`packages/cli/**`, `.claude/rules/package-plugin.md` on `packages/plugin/**`,
`.claude/rules/baseline-core.md` on `templates/core/**`, and one per pack on
`templates/packs/<name>/**`: `.claude/rules/pack-claude-github.md`,
`.claude/rules/pack-github.md`, `.claude/rules/pack-harness-extras.md`,
`.claude/rules/pack-licensing.md`, `.claude/rules/pack-publishing.md`, `.claude/rules/pack-quality.md`,
`.claude/rules/pack-statusline.md`, `.claude/rules/pack-supply-chain.md` and
`.claude/rules/pack-worktrees.md`. A pack cannot ship a rule of its own (see
`templates/packs/README.md`), which is why these live here and not in the
pack. Each names its own trigger paths in its frontmatter.

**Root harness inventory.** The root `.claude/` also carries these wired
surfaces beyond the guards and spokes named above. `.claude/agents/Explore.md`
is a read-only search agent outside the TDD roster. It is byte-identical
to `templates/core/.claude/agents/Explore.md` and is the fifth of the
baseline's five agents.

| Surface                                      | Kind     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fires on                                                                                                         |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `.claude/hooks/inject-decision-gate.mjs`     | Hook     | Injects a branch and PR reminder so isolation is chosen up front, not discovered when a guard blocks a write on `main`                                                                                                                                                                                                                                                                                                                                                                                 | `UserPromptSubmit`, prompts with a change-intent verb; advisory, never blocks                                    |
| `.claude/hooks/post-edit-verify.mjs`         | Hook     | Runs prettier, eslint, package `tsc -b` and related vitest on an edited `.ts`/`.mts`/`.cts` under `src/` or `tests/`; other `.mjs`/`.js` get prettier and eslint only, so failures surface in-loop, not at push                                                                                                                                                                                                                                                                                        | `PostToolUse` `Write\|Edit`, ten `if` registrations (`*.ts`, `*.mts`, `*.cts`, `*.mjs`, `*.js`); exit 2 advisory |
| `.claude/hooks/nudge-invariants.mjs`         | Hook     | Reminds that CLI and emitted-twin graders, `domain-map.ts`, `design/tokens.css` and SPDX headers change together                                                                                                                                                                                                                                                                                                                                                                                       | `PostToolUse` after any edit, root only; advisory                                                                |
| `.claude/hooks/repair-core-bare.mjs`         | Hook     | Resets the `core.bare = true` that `EnterWorktree`/`ExitWorktree` leave behind, which breaks every git command in the root                                                                                                                                                                                                                                                                                                                                                                             | `SessionStart` (`startup\|resume`) and `PostToolUse` on `EnterWorktree\|ExitWorktree\|Agent`                     |
| `.claude/agents/Explore.md`                  | Agent    | Read-only search on `claude-haiku-5-5`, overriding the built-in, so lookups never spend the hub's model or edit files                                                                                                                                                                                                                                                                                                                                                                                  | Dispatched by the hub for "where is X" lookups                                                                   |
| `.claude/skills/starting-work/`              | Skill    | Picks a branch and PR target before any write, so work never starts on `main`                                                                                                                                                                                                                                                                                                                                                                                                                          | `/starting-work`, before any code change                                                                         |
| `.claude/skills/writing-commits/`            | Skill    | Drafts a Conventional Commit from the staged diff, so the `commit-msg` hook does not reject it                                                                                                                                                                                                                                                                                                                                                                                                         | `/writing-commits`, "commit this"                                                                                |
| `.claude/skills/creating-prs/`               | Skill    | Runs the gates, pushes and opens the PR with a conventional title, so a red or unsigned branch never reaches review                                                                                                                                                                                                                                                                                                                                                                                    | `/creating-prs`, "open a PR"                                                                                     |
| `.claude/skills/finishing-work/`             | Skill    | Confirms the PR merged before deleting local branches and pruning refs, so an unmerged branch is never lost                                                                                                                                                                                                                                                                                                                                                                                            | `/finishing-work`, after a merge                                                                                 |
| `.claude/skills/triaging-ci/`                | Skill    | Maps a failing run to its pipeline step with a local repro command, so CI is diagnosed from logs rather than guessed                                                                                                                                                                                                                                                                                                                                                                                   | `/triaging-ci`, "why did CI fail"                                                                                |
| `.claude/hooks/write-compact-handoff.mjs`    | Hook     | Writes branch, last commit and uncommitted files to the gitignored `tmp/compact-handoff-<session_id>.json` before a compaction, so state does not depend on the summary keeping it                                                                                                                                                                                                                                                                                                                     | `PreCompact`; never blocks                                                                                       |
| `.claude/hooks/reinject-compact-handoff.mjs` | Hook     | Reads that artifact back as `additionalContext`, and recovers an orphan one left by a killed session                                                                                                                                                                                                                                                                                                                                                                                                   | `SessionStart` (`compact\|resume\|startup`); never blocks                                                        |
| `.claude/hooks/guard-readonly-bash.mjs`      | Hook     | Judges every Bash command of a read-only review spoke (every agent not in `WRITER_SPOKES`, `baseline-impact-reviewer` included) against an allowlist of read verbs, git subcommands and per-verb flags, and blocks what it cannot read. Accepted residuals: the contents of a script file run through `node`, `pnpm <script>` or `npm run`, `tsc -b` and `vitest` writing their own outputs, `eval`/`case` bodies, shell functions and aliases, and a prefix verb's own value flags (`xargs -I {} rm`) | `PreToolUse` `Bash`; exit 2 blocks; an unclassifiable command blocks, a crash outside classification fails open  |
| `.claude/skills/reviewing-dependabot-prs/`   | Skill    | Classifies each open Dependabot PR by semver bump and check status, then merges only the batch you confirm                                                                                                                                                                                                                                                                                                                                                                                             | `/reviewing-dependabot-prs`                                                                                      |
| `.claude/skills/triaging-scan-alerts/`       | Skill    | Maps open code-scanning alerts to `file:line`, report only, so CodeQL findings are read rather than guessed at                                                                                                                                                                                                                                                                                                                                                                                         | `/triaging-scan-alerts`                                                                                          |
| `.claude/skills/watching-pr-checks/`         | Skill    | Reports a PR's check status and hands a real failure to `/triaging-ci`                                                                                                                                                                                                                                                                                                                                                                                                                                 | `/watching-pr-checks`                                                                                            |
| `bin/strip-claude-trailers.mjs`              | Git hook | Removes harness-injected `Claude-*` trailer lines (never `Co-Authored-By:`) so they do not reach `lint-commit.mjs`                                                                                                                                                                                                                                                                                                                                                                                     | `lefthook.yml` `commit-msg`, run before `node bin/lint-commit.mjs --edit`                                        |

## Decision record (moved from the root `CLAUDE.md`)

This repo runs on `templates/core`'s own harness -- installed onto its own
root by adopting itself (see "Known gaps" for how), same shape as every
project it bootstraps, with one adaptation: `packages/*/src/**` and
`packages/*/tests/**` in every path-shape rule below, not a flat `src/`/`tests/`,
matching this repo's real two-package layout.

**Hub-and-spoke is mandatory and hook-enforced, deliberately, with no
project-level opt-out.** The hub plans and dispatches to spokes, and never
writes `packages/*/src/` or `packages/*/tests/` itself -- enforced
unconditionally by `.claude/hooks/guard-hub-src-writes.mjs` (blocks any
Write/Edit whose PreToolUse payload does not carry both a writer-spoke
`agent_type` and an `agent_id`, i.e. every direct top-level edit, including
one from a session started with `--agent`) and `guard-branch-isolation.mjs` (the same block
specifically on `main`), plus `disallowedTools: Agent` on every spoke. This
was a deliberate choice among real alternatives (installing the harness
minus these two hooks, or holding off entirely) confirmed with the
maintainer during the self-adoption's Step 0 -- not a default nobody looked
at. For a piece of work with a clear contract:
