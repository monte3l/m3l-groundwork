# Known gaps

> Moved verbatim from the root `CLAUDE.md` ("Known gaps"): what is deliberately out of scope so far.

- `templates/packs/` ships eight packs, each covering one theme (wiring contract
  and each pack's `adoptNotes` live in `templates/packs/README.md` and its
  `pack.json` files). `harness-extras`: Claude Code session hooks
  (compaction-handoff hooks, `guard-readonly-bash`). `statusline`: the
  `statusLine` and `subagentStatusLine` renderers; the only pack using
  `wiring.settingsTopLevel`, and in adopt mode `/customize` (not `merge-json`)
  skips the `statusLine`/`subagentStatusLine` keys and the script that renders
  each when either key is already set. `quality`:
  `type-design-analyzer` agent and the `check-file-budget` ratchet. `claude-github`:
  `claude-action` in mention-mode and an automated PR-review workflow, which
  need an auth secret the pack cannot create. `github`: three `gh` skills.
  `publishing`: the release pipeline adapted from this repo's own
  (see "Releases"); **fresh mode only**, since it encodes registry and GitHub
  App decisions too project-specific to automate in adopt mode, and it cannot
  wire `@changesets/cli` because a pack never edits dependencies. `supply-chain`:
  `gitleaks.yml` and `scorecard.yml`, adopt-capable for every project kind (the
  SPDX header gate stays in `publishing` because it fails an established
  project's `pnpm verify` until a one-time backfill). `worktrees`: enforces
  worktree-only src/tests development (`guard-worktree-only.mjs`, a
  `working-in-worktrees` skill, dependency-install and `core.bare` repair
  hooks, a `.worktreeinclude`); `recommended: false` in `pack-map.ts` on
  purpose, since it changes the day-to-day workflow.
- **No standalone "add a pack to an already-bootstrapped project" flag.**
  Today that path is: re-run the CLI against the now-non-empty directory
  (it auto-detects adopt mode), then run `/customize`. Works, but is
  indirect -- a dedicated additive install mode is real future work.
- **CI does not use `pnpm/setup`**, though pnpm's docs now recommend it.
  Re-checked 2026-10-01: the original blocker is gone, since `pnpm/setup@v3`
  (2026-09-20) has a `node-version-file` input and auto-detects
  `.node-version`, so a migration needs no second Node pin and passes
  `check-node-version.mjs` unchanged as long as it spells
  `node-version-file: .node-version` (a `runtime: node@N` literal would
  evade that gate's `node-version:` regex). It is deferred, not blocked:
  v3 is days old with open reliability issues, it needs pnpm 11+, it changes
  how Node is provisioned in the publishing jobs, and the org's actions
  allowlist must add `pnpm/setup` first. `pnpm/action-setup` itself has no
  such input. Issue #47 is closed, so track the re-check in a new issue; do it when
  `pnpm/setup` ships a v3.x with no open hang or network-failure bug and the
  allowlist is settled.
- **`.claude/` harness support for working _in this repo_ (as opposed to what
  it emits) is now installed** -- see "Agent Operating Model" above for what
  and why. It arrived by running this repo's own published CLI against
  itself (`npx @monte3l/groundwork@next .` at the time, adopt mode; an adopter now
  uses the default `latest` tag, see `.claude/rules/releases.md`) and its own
  `/customize` skill, the same path any adopter follows -- self-hosting as
  the first real end-to-end proof of both, not a hand-rolled install. Grade
  it with the same rule module `templates/core`'s `bin/check-harness.mjs`
  uses (see "Definition of Done" for the command) -- 0 structural findings
  expected.
  What _does_ already exist independently is `.claude/worktrees/**`,
  created ad hoc whenever a subagent runs with
  `isolation: "worktree"`: a full second checkout of this repo, uncommitted
  state included. `.gitignore`, `.prettierignore`, `eslint.config.js` and both
  vitest configs exclude it explicitly -- without that, prettier fails on a
  sibling session's in-progress formatting and every test in the repo runs
  twice. Add the same exclusion to any new file-discovery config (a future
  ESLint plugin config, a coverage include list) rather than assuming the
  existing excludes cover it. `templates/core` carries the same four
  exclusions, plus `.gitignore` entries for `.env`/`.env.local`/
  `.env.*.local` (never commit secrets, regardless of whether a project adds
  its own `.worktreeinclude` file) so an emitted project gets the same
  protection from day one -- see
  `packages/cli/tests/survey/fs-walk.test.ts` and
  `packages/cli/tests/post-edit-verify.test.ts` for the regression coverage.
  `.claude/hooks/post-edit-verify.mjs` (both this repo's own copy and
  `templates/core`'s) resolves the git working-tree root that actually
  contains the edited file (`resolveVerifyRoot`) rather than trusting
  `CLAUDE_PROJECT_DIR`, which Claude Code pins to the session's original
  root and does not move into a worktree -- see the hook's own
  header comment. `finishing-work` and `starting-work` know about a linked
  worktree too: `finishing-work` checks `git worktree list --porcelain` before
  deleting a branch, and only `starting-work` hands the branch step to the
  optional `worktrees` pack's own skill when it's installed. This repo's own
  harness does not **enforce** worktree-only development or automate
  per-worktree dependency installation: the `worktrees` pack ships that
  (`guard-worktree-only.mjs`, `ensure-worktree-deps.mjs`), and this repo has
  not installed it.
- **Adopt mode's `inventory.json` still records `templateRoot` as an absolute
  path, but baseline additions no longer depend on it** (schema 5): they are
  staged at `.groundwork/baseline/` and hash-checked, and `/customize` never
  falls back to `templateRoot` for a schema 5+ inventory. Only a schema 1-4
  inventory still reads additions from it, and Step 0 reports a vanished path
  and asks for a re-run rather than guessing. `report.ts`'s cap estimate reads
  `templateRoot` inside the CLI run itself, where it still exists. Staged
  pack files are inert `.staged` copies, written to a temp sibling and swapped in by rename (never half-written), like
  `baseline/`; the staging refuses a symlinked `.groundwork` or `packs/`
  directory.
- **Adopt mode's post-merge cap counts (in `report.ts`) are an estimate, not
  a reconciliation.** It assumes no name overlap between the baseline's
  agents/skills/hooks and the project's own -- good enough to flag "you may
  go over budget," not precise enough to be the final word; `/customize`'s
  Step 0 confirmation round settles it for real.
- **GitHub settings live outside the repo.** Org-write and secret-write actions
  need a human, not an agent (Claude Code's permission classifier refuses an
  agent's attempt), so they were applied by hand and every item was confirmed
  applied on 2026-10-04. [`docs/github-blueprint.md`](github-blueprint.md)
  holds the exact `gh api` commands; the repo-scope ones are also scripted in
  `monte3l/.github` (`bin/apply-repo-baseline.sh`, `--check` first). The
  SHA-pinning allowlist must cover sub-path actions, so allow
  `changesets/action/*` as well as `changesets/action@*`. Immutable releases
  are deliberately off: `release.yml` uploads assets after the Release exists.

  This repository's Advanced Security settings come from the organization's
  `monte3l-default` code security configuration, enforced on the repository;
  that configuration is the source of truth. Read it with
  `gh api repos/monte3l/m3l-groundwork/code-security-configuration` and
  `gh api orgs/monte3l/code-security/configurations/<id>`. One caveat remains:
  new repositories still default to the "GitHub recommended" configuration,
  which leaves Dependabot security updates `not_set`.
