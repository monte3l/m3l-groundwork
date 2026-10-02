# templates/packs/

Optional add-on bundles, installed **on top of** `templates/core` rather
than folded into it. A pack exists for one of two reasons: an artifact was
generically useful but cut from the baseline purely to hold its hard caps
(≤5 agents, ≤8 skills, ≤10 hooks, ≤3 CI workflows, ≤12 root scripts —
`templates/core`'s own `CLAUDE.md`), or it applies to only some project
kinds and shouldn't tax every bootstrap by default.

## Layout

```
templates/packs/<name>/
├── pack.json      # manifest: budget, requires, wiring
└── files/         # the pack's own file tree, mirroring the project root
                    # exactly as templates/core/ does -- emitted the same way
```

## The wiring contract

**A pack never edits YAML or JavaScript.** It may add files under `files/`.
**A pack also can't ship a `.claude/rules/*.md` file**: the harness grader's
structural `claudemd-refs` rule fails on any rule `CLAUDE.md` doesn't name
by path, and a pack has no way to edit `CLAUDE.md` (that's not one of the
three JSON files below either). If a pack needs to state a project-wide
policy, put it in the body of a skill it ships instead — see the `worktrees`
pack's `working-in-worktrees` skill for the pattern.
It may also extend three JSON files the baseline already reads at runtime:
`.claude/settings.json` (hook registrations, and top-level harness settings
such as `statusLine`), `package.json` (`scripts`), and
`bin/lib/verify-steps.packs.json`. That last file holds gate steps, each
keyed to one of the five fixed verify groups
`templates/core/bin/lib/verify-steps.mjs` defines —
`format`/`lint`/`typecheck`/`build`/`test`. A gate registered this way runs
under `pnpm verify`, every `lefthook.yml` `pre-push` lane, and every
`.github/workflows/ci.yml` job automatically. That works because all three
already enumerate groups rather than individual steps.

`pack.json` fields:

- `schemaVersion` — currently `1`.
- `modes` — `["fresh"]` and/or `["fresh", "adopt"]`. "Adopt-capable" means
  an artifact has no dependency on the baseline's exact file layout (an
  agent, most hooks), so it's safe to install into an already-existing
  project's own layout. A gate that assumes a specific source layout isn't
  adopt-capable -- it should say so honestly in `adoptNotes` instead of
  claiming `adopt`.
- `budget` — the pack's cap deltas (`agents`/`skills`/`hooks`/`workflows`/
  `scripts`), checked against `templates/core`'s own counts by a structural
  test, never against `templates/core` + every other pack.
- `requires.paths` — baseline files a pack artifact imports (e.g.
  `bin/lib/agent-roster.mjs`). Checked at install time in fresh mode; a
  missing requirement is a hard install error, not a silent partial install.
- `wiring.settings` — a `.claude/settings.json` hook fragment, merged
  append-only and idempotently. Omit it, or leave it `{}`, for a pack that
  registers no hooks.
- `wiring.settingsTopLevel` — top-level `.claude/settings.json` keys that
  aren't hook registrations (`statusLine`, `subagentStatusLine`, …), planted
  whole. A key the project already defines with a different value is a hard
  install error, never an overwrite; `hooks` is refused here, since it
  belongs in `wiring.settings`. Optional.
- `wiring.packageScripts` — `package.json` script additions. Most packs need
  none: a gate registers directly as `["node", "bin/check-x.mjs"]` in
  `wiring.verifySteps`, not as a `pnpm` script.
- `wiring.verifySteps` — entries appended to `bin/lib/verify-steps.packs.json`.
- `adoptNotes` — free text surfaced verbatim in `/customize`'s Step 0
  confirmation round when the pack applies to an adopted project.

## Install path

- **Fresh mode**: the CLI installs a pack directly (`--pack <name>`,
  repeatable) — it wrote the baseline moments ago, so there's no uncertainty
  to defer.
- **Adopt mode**: the CLI never installs a pack. It surveys which packs
  apply and stages their payload at `.groundwork/packs/<name>/`. Later,
  `/customize` confirms the install in **Step 0** (its first, up-front
  confirmation round, before any file is written) and performs it in
  **Round 1** (the first pass of deterministic edits that follows). That
  installation translates `wiring.verifySteps`/`wiring.settings` against
  the project's _real_ gate runner and hook config — read for real by that
  point, not guessed at offline.

## Available packs

| Pack             | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness-extras` | Claude Code session ergonomics: the compaction-handoff hook pair, a read-only Bash guard, and a five-row status line (session, model, context, quota, work) plus a per-subagent row renderer. The only pack that sets top-level settings keys (`statusLine`, `subagentStatusLine`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `quality`        | Two language-level review aids: a per-file size ratchet gate (`check-file-budget.mjs`, a `build`-group verify step) and a read-only `type-design-analyzer` agent. No hooks, no settings. Adopt-capable and recommended for every project kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `github`         | GitHub-hosted collaboration: Anthropic's official Claude Code GitHub Action wired for `@claude` mention-mode, a second Action that posts an automated Claude review comment on every PR, and three `gh`-CLI skills — `reviewing-dependabot-prs`, `triaging-scan-alerts`, `watching-pr-checks`. No hooks, no gate. The two workflows need an auth secret this pack cannot create; see its `adoptNotes`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `publishing`     | A release pipeline: `release.yml` (changesets version-PR / staged, provenance-attested npm publish via trusted publishing), `check-publish-version.mjs`, `check-dts-deps.mjs`, `check-license-headers.mjs` and a `REUSE.toml` template. Fresh mode only — see "Install path" below and its `adoptNotes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `supply-chain`   | Secret scanning (`gitleaks.yml` with a `.gitleaks.toml`) and an OpenSSF Scorecard run (`scorecard.yml`) for any project on GitHub, published or not. A pure file drop of two read-only workflows: no hooks, no settings, no scripts, no gate. Adopt-capable and recommended for every project kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `worktrees`      | Enforces that all src/tests development happens inside an isolated git worktree, on any branch, for any caller: a `working-in-worktrees` skill (start/status/sync/finish/fan-out), a `SessionStart` hook that installs dependencies into a freshly created worktree, a `PreToolUse` guard stricter than the baseline's own `guard-branch-isolation.mjs`/`guard-hub-src-writes.mjs`, a `repair-core-bare.mjs` hook (`SessionStart`, and `PostToolUse` after `EnterWorktree`/`ExitWorktree`/`Agent`) that resets the `core.bare = true` Claude Code's worktree tools are reported to leave in a normal repo's shared config, and a `.worktreeinclude` copying `.env`/`.env.local`/`.env.*.local` into every worktree Claude Code creates. Changes the day-to-day workflow, not just a nicety — see its `adoptNotes`. |
