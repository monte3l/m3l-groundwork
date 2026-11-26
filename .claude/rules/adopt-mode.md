---
paths:
  - "packages/cli/src/survey/**"
  - "packages/cli/src/conflicts.ts"
  - "packages/cli/src/baseline-stage.ts"
  - "packages/cli/src/pack-stage.ts"
  - "packages/cli/src/staging.ts"
  - "packages/cli/src/plugin.ts"
  - "packages/cli/src/customize-paths.ts"
  - "packages/cli/src/inventory.ts"
  - "packages/cli/src/report.ts"
  - "packages/cli/src/add-pack.ts"
  - "packages/cli/tests/add-pack*.ts"
  - "packages/cli/tests/adopt.e2e.test.ts"
---

# Adopt mode rules (the survey, staging and the inventory)

> Moved verbatim from the root `CLAUDE.md` ("Architecture notes") so it loads only when you edit the files it governs.

- **Adopt mode's contract is "the survey is an index, not an
  interpretation."** Every `survey-*.ts` collector records facts it can
  establish offline -- which files exist, their verbatim content, which
  keys are set -- and never infers a verdict (there is no `ProjectKind`
  anywhere in `packages/cli`; that inference happens once, visibly, in
  `/customize`'s Step 1, with its evidence shown). Anything a collector
  can't parse goes into `ProjectSurvey.undetermined` rather than being
  silently dropped -- a survey that looks complete but isn't is worse than
  one that admits a gap. Adopt mode writes two report files
  (`.groundwork/inventory.json`, `.groundwork/adoption-report.md`), the
  inert staged copies of the baseline additions and the packs
  (`.groundwork/baseline/`, `.groundwork/packs/`), plus one
  guarded, purely-additive copy of the `/customize` skill
  (`installCustomizeSkillGuarded` in `plugin.ts`; `customize-paths.ts` owns
  where it writes). It decides presence by `lstat`, never overwrites or
  removes a project-owned entry under `.claude/skills/customize/` (anything
  already there that is not an exact current copy sends the install to
  `.groundwork/customize/`, as does a symlinked component under `.claude`),
  lstat-guards every directory under `.groundwork/` it writes through,
  writes `SKILL.md` last and rolls back the files it wrote if a later write
  fails -- never a project file. The guard is an `lstat` check, so a
  component swapped for a symlink after the check is not covered, and
  `targetDir` itself and its ancestors are not checked; see the assurance
  case's residual risks.
  Staged baseline files carry a `.staged` suffix so no project tool (vitest,
  tsc, eslint, Claude Code's skill loader) can discover them as live source;
  `inventory.stagedBaseline.files` records each one's original `path`, its
  `staged` name and a `sha256`, and `/customize` strips the suffix on install.
  Staged packs follow the identical convention (`pack.json.staged` and
  `files/<path>.staged` under `.groundwork/packs/<name>/`, recorded in
  `inventory.stagedPacks`, added to schema 5 before it shipped); all packs are
  staged as one unit in a temp sibling directory and swapped in by rename, and
  their planned paths are scope-checked before any is written.
  `inventory.json` is the commit marker: any old one is deleted before
  staging starts, and it is written atomically (temp file, then rename) after
  the staging, the `/customize` skill copy and the report, so its presence
  means the run completed. A `.groundwork/` directory with no inventory
  therefore means an interrupted run, which `/customize` refuses to treat as
  a fresh bootstrap -- except one that holds nothing but `add-pack/` and
  `installed-packs.json`: Step 0.1 ignores those two entries, so an
  add-pack-only `.groundwork/` on a bootstrapped project continues on the
  fresh path and names the staged packs. The per-file `sha256` proves the staging is complete
  and matches the inventory, not that it is untampered.
  `adopt.e2e.test.ts` is the test of that guarantee; don't weaken it.
  An adopt re-run deletes only its four stale files and its own `packs/` and
  `baseline/` staging, so `.groundwork/add-pack/` and
  `.groundwork/installed-packs.json` survive it byte-identical, and so do
  the bootstrap's `groundwork.lock.json`, `base/` and `answers.json`: adopt
  mode never writes, rewrites or deletes them (`STALE_FILE_NAMES` stays the
  four files above).
- **`.groundwork/installed-packs.json` is the installed-packs ledger.** Only
  `/customize` writes it (`pack-install.md`'s last step, after an
  add-pack install or adopt Round 1); the CLI only reads it, leniently
  (`readInstalledPacksLedger` in `pack-installation.ts`). It is tracked in
  git, so the recommended `.gitignore` block un-ignores it. Fresh `--pack`
  now writes an entry too, but from the CLI (`record-bootstrap.ts`, `via:
"fresh"`): the CLI records what it installed itself, never the skill.
- **`--add-pack` (`add-pack.ts`) writes only `.groundwork/add-pack/<name>/`**
  (`pack.json.staged`, `files/<path>.staged`, then `plan.json` last), one pack
  at a time through `staging.ts`'s atomic swap, after every refusal and
  `assertAddPackWriteScope` check. It never runs mode detection, never writes
  the `/customize` copy and never touches the rest of `.groundwork/`.
  `add-pack.test.ts` and `add-pack.e2e.test.ts` are the tests of that
  guarantee.
- **A Claude Code plugin repo is a first-class adopt target** (inventory
  schema 6). `survey.harness.pluginLayout` is `null` unless
  `.claude-plugin/plugin.json` is a regular file; then it lists which of
  `hooks/hooks.json`, `skills/`, `agents/`, `commands/` and `.mcp.json` exist.
  A manifest that exists but is a symlink or directory leaves it `null` and
  adds an `undetermined` note, so the report never calls it "no plugin"; a
  symlinked component is likewise left out with a note. The symlink check is
  `lstat` on the final path component only. A root `hooks/` without the
  manifest is never recorded, since it could be React hooks. The harness grader reads `.claude/`, `CLAUDE.md`, the root `.mcp.json` and the root file listing, never a plugin's own components,
  so the report says plugin components are outside its scope rather than
  printing "0 of 0 checks pass". `/customize` has a fifth `plugin` kind
  (pre-selected from `pluginLayout`, which also recommends `plugin-dev`) and a
  final gate (its Step 6) that grades the harness after Round 2, from the
  staged grader files when the project has no `bin/check-harness.mjs`. Any
  `CLAUDE.md` text that names a `.claude/` file must use the full
  `.claude/...` path, because `claudemd-refs` matches that literal.
