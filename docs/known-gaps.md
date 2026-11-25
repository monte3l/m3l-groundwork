# Known gaps

> Moved verbatim from the root `CLAUDE.md` ("Known gaps"): what is deliberately out of scope so far.

- `templates/packs/` ships eleven packs, each covering one theme (wiring contract
  and each pack's `adoptNotes` live in `templates/packs/README.md` and its
  `pack.json` files). `harness-extras`: Claude Code session hooks
  (compaction-handoff hooks, `guard-readonly-bash`). `statusline`: the
  `statusLine` renderer and the `subagent-rows` mod (a project-local plugin
  that replaces the deprecated `subagentStatusLine` key); the only pack using
  `wiring.settingsTopLevel`, and in adopt mode `/customize` (not `merge-json`)
  skips the `statusLine` key and its two scripts when the key is already set,
  installing only the mod. The status line has an opt-in m3l-design palette
  (`GROUNDWORK_STATUSLINE_THEME`, offered by `/customize`, never the default),
  and the `subagent-rows` mod reads it through the documented
  `$.settings.read({ key: "env" })`, since its hook module has no `process.env`.
  That path is tested only through fakes, never seen in a live session (a probe
  could not get a row on screen), and the mod assumes a dark terminal because it
  cannot see `COLORFGBG`. `quality`:
  `type-design-analyzer` agent and the `check-file-budget` ratchet. `claude-github`:
  `claude-action` in mention-mode and an automated PR-review workflow, which
  need an auth secret the pack cannot create. `github`: three `gh` skills.
  `publishing`: the release pipeline adapted from the Changesets one this
  repo used before release-please (see "Releases"); **fresh mode only**, since it encodes registry and GitHub
  App decisions too project-specific to automate in adopt mode, and it cannot
  wire `@changesets/cli` because a pack never edits dependencies. `supply-chain`:
  `gitleaks.yml` and `scorecard.yml`, adopt-capable for every project kind (the
  SPDX header gate is the separate fresh-only `licensing` pack, because it
  fails an established project's `pnpm verify` until a one-time backfill). `worktrees`: enforces
  worktree-only src/tests development (`guard-worktree-only.mjs`, a
  `working-in-worktrees` skill, dependency-install and `core.bare` repair
  hooks, a `.worktreeinclude`); `recommended: false` in `pack-map.ts` on
  purpose, since it changes the day-to-day workflow. `frontend`: a read-only
  `ui-reviewer` agent (a static WCAG 2.2 review, with anything needing a
  browser reported as `NOT CHECKED`) and a `new-component` skill that mirrors
  a sibling component; recommended only for the `frontend` kind. `service`: a
  read-only `performance-analyzer` agent (a static review for blocking calls
  and unbounded work, with anything needing profiling reported as
  `NOT CHECKED`) and an `api-doc` skill that writes an OpenAPI description
  from the routes the code defines; recommended only for the `service` kind.
- **Fresh `--pack` writes no installed-packs ledger.** Only `/customize`
  writes `.groundwork/installed-packs.json` (after `/customize add-pack` or
  adopt Round 1). A pack installed at bootstrap with `--pack` is not in it,
  so `--list-packs` and `--add-pack` tell that it is installed by detecting
  its files on disk. To record it, stage it again with
  `npx @monte3l/groundwork . --add-pack <name> --reinstall` (the CLI refuses
  an installed pack without `--reinstall`) and then run
  `/customize add-pack <name>`.
- **CI uses `pnpm/setup` only in part.** Re-checked 2026-11-25 against
  v3.2.0 (#319): no open hang report, and the one possible network bug
  (pnpm/setup#97, `tls handshake eof`) comes from behind a corporate registry.
  The `ci.yml` lanes that read `.node-version` (format, lint, typecheck, build,
  test, `e2e`, `e2e-macos`) and `security-audit.yml` now use it, with
  `node-version-file: .node-version`, `install: false` and its store cache off
  (pnpm/setup#67 and #102: it restores almost nothing, or a stale store).
  `check-node-version.mjs` also rejects a `runtime: node@N` literal now, so
  the Node pin cannot slip in through that input. These stay on
  `pnpm/action-setup` + `actions/setup-node`, on purpose:
  - `release.yml` holds the OIDC token. `pnpm/setup` restores and saves a
    lockfile-verification cache on every run, whatever `cache` says, and the
    file forbids any restored cache; it has no `registry-url` for the
    Scorecard Packaging check either.
  - `soak.yml` stands in for an adopter, runs `npx` (pnpm/setup#66) and runs
    on arm (pnpm/setup#29).
  - `node-current` and `node-previous-lts` pin Node release lines (`>=26`,
    `lts/-1`) that `node-version-file` cannot express.
  - `templates/core` keeps `pnpm/action-setup`: an adopter's org may restrict
    actions as well, and the baseline should not require `pnpm/setup`.

  The org's actions allowlist needs `pnpm/setup@*` for the migrated lanes
  (`docs/github-blueprint.md`, row 5). Revisit the rest when #66, #67 and #102
  are fixed upstream.

- **`.claude/` harness support for working _in this repo_ (as opposed to what
  it emits) is now installed** -- see "Agent Operating Model" above for what
  and why. It arrived by running this repo's own published CLI against
  itself (`npx @monte3l/groundwork@next .` at the time, adopt mode; an adopter now
  uses the default `latest` tag, see `.claude/rules/releases.md`) and its own
  `/customize` skill, the same path any adopter follows -- self-hosting as
  the first real end-to-end proof of both, not a hand-rolled install. Grade
  it with the same rule module `templates/core`'s `bin/check-harness.mjs`
  uses (see "Definition of Done" for the command) -- 0 structural findings
  expected. A later `/customize` pass (2026-10-20) back-ported the baseline
  fixes this copy had missed and installed two packs on top of the
  `statusline` pack it already had: `harness-extras` (the compaction-handoff
  hooks and `guard-readonly-bash`) and `github` (`reviewing-dependabot-prs`,
  `triaging-scan-alerts`, `watching-pr-checks`). It kept every toolchain and
  CI file as this repo's own, as the first pass did.
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
  `googleapis/release-please-action@*` for the shared release workflow. Immutable
  releases are on: the draft-first `release.yml` attaches every asset before
  publishing, and `@monte3l/groundwork@1.1.1` passes `gh release verify`.

  This repository's Advanced Security settings come from the organization's
  `monte3l-default` code security configuration, enforced on the repository;
  that configuration is the source of truth. Read it with
  `gh api repos/monte3l/m3l-groundwork/code-security-configuration` and
  `gh api orgs/monte3l/code-security/configurations/<id>`. One caveat remains:
  new repositories still default to the "GitHub recommended" configuration,
  which leaves Dependabot security updates `not_set`.
