---
paths:
  - "packages/cli/src/upgrade/**"
  - "packages/cli/src/manifest.ts"
  - "packages/cli/src/plugin.ts"
  - "packages/cli/src/customize-paths.ts"
  - "packages/cli/src/mode.ts"
  - "packages/cli/tests/upgrade.e2e.test.ts"
  - "packages/plugin/skills/upgrade/**"
---

# Upgrade mode (design record, partly built)

The CLI's third mode and the `/upgrade` skill. The decision and its
alternatives are in
[`docs/decisions/0001-upgrade-flow.md`](../../docs/decisions/0001-upgrade-flow.md).
**Built so far:** `packages/cli/src/manifest.ts` (schema 1) with fresh mode
writing `.groundwork/manifest.json`, the pure classifier
(`upgrade/classify.ts`), the plan computation (`upgrade/plan.ts`) and the
`--upgrade` mode that stages the plan (`upgrade/stage.ts`, `upgrade/report.ts`,
`runUpgrade` in `main.ts`) and `--upgrade --stamp` (`upgrade/stamp.ts`,
`runUpgradeStamp` in `main.ts`). Everything else, `--apply`,
the legacy no-manifest plan, the `--json` plan report and the `/upgrade` skill,
is not in `packages/` yet; the paths above are where it will land. Update this
file as each piece ships, and drop this line when the last one does.

- **Offline and deterministic, like Phase A.** `--upgrade` reads the project and
  the packaged baseline, and writes only under `.groundwork/upgrade/`:
  the `staged/<path>.staged` copies of the rendered file for every `add`,
  `safe-update`, `conflict-2way` and `conflict-3way` entry, then
  `upgrade-report.md`, then `plan.json` last (the commit marker, as
  `inventory.json` is for adopt). Every staged byte is read and checked against
  the plan's `nextSha256` before anything is written, so a release copy that
  changed after the plan was computed fails the run with nothing touched. The
  whole directory is built in a work directory and swapped in by rename
  (`stageAtomically`), so a failed run leaves the previous plan intact. Re-running
  replaces the directory wholesale and warns by name when it discards anything
  but `plan.json`, `upgrade-report.md` and `staged/` (a recorded decision is only
  valid beside its own plan); a regular file at `.groundwork/upgrade` is refused.
  The directory names live in one module, `upgrade/paths.ts`. `/customize`
  ignores `upgrade/` and `.upgrade-*` when it classifies `.groundwork/`. It never
  writes a project file or the manifest. It rejects `--name`, `--force`,
  `--pack`, `--skip-install` and `--json` (plan reports wait for the headless
  series), needs an existing directory, and combines with neither `--adopt` nor
  `--fresh`. A project with **no manifest** is refused (exit 2) with advice to
  re-run the CLI in adopt mode and then `/customize`; the legacy two-way plan is
  a later change. `plan.json` is the plan plus `legacy: false` and a `staged`
  list of `{path, staged, sha256}`, with no timestamps or absolute paths, so two
  runs on the same inputs are byte-identical. Until the `/upgrade` skill ships,
  the report's Next step (and the run's `Next:` line) says to apply the
  staged files by hand and then run `--upgrade --stamp`; when nothing is
  listed under Needs a decision, Safe to apply or Removed upstream
  (`nothingToApply` in `upgrade/report.ts`, the one predicate both read), it
  says there is nothing to apply and that `--upgrade --stamp` still records
  the new release in the manifest (and drops the entries for files gone from
  both the release and the project). The pack list comes from the manifest. Adding a pack
  to an existing project is `--pack <name>` in adopt mode
  ([#318](https://github.com/monte3l/m3l-groundwork/issues/318)), which needs no
  manifest. The skill's stamp step records the new pack in the manifest like any
  other change.
- **The plan is computed by rendering the new release, not by reading
  `templates/`.** `renderRelease` (`upgrade/plan.ts`) emits the baseline and then
  each pack **the manifest lists** into a temp directory with **the manifest's
  tokens**, through the same `emitTemplate` and `installPack` fresh mode uses, so
  pack merges into shared files are exact. Packs install in sorted, de-duplicated
  order, as fresh mode does. The manifest's tokens must be exactly
  `REQUIRED_TOKEN_KEYS` (`tokens.ts`, shared with `buildTokens`) with non-empty
  values, or a damaged manifest would render a literal `__PROJECT_NAME__` and
  classify real files as safe updates. `computePlan` then hashes the project and
  classifies every path and JSON key with `classifyAll`. It is read-only on the
  project, refuses a managed file or ancestor that is a symlink, a directory or
  unparseable (naming the path, never quoting file text), and refuses a release
  rendered for a different manifest. A file's own class wins over its key
  entries; the keys only matter when the file is present and a JSON object. The
  lstat-then-read walk has the same check-then-use race the guarded
  `/customize` install documents, and the apply step's hash check is the
  backstop. Callers must `dispose()` the release; `dispose` never throws.
- **The manifest is the only record.** `.groundwork/manifest.json` is tracked
  and must never be in `STALE_FILE_NAMES` (`main.ts`): an adopt re-run must not
  delete it. It stores `cliVersion`, `tokens`, `packs`, a sha256 per file with
  an `origin` of `emitted` or `merged`, and a sha256 per JSON key for
  `package.json`, `tsconfig*.json` and `.claude/settings.json`. A JSON key is
  named by a JSON Pointer (RFC 6901): a top-level key is `/scripts`, an inner
  key of a non-empty top-level object is `/scripts/verify`, `~` and `/` inside a
  name are escaped as `~0` and `~1`, and an empty object is one `/x` entry. A
  dotted name would collide (`a.b` as a key versus `b` inside `a`). Hash the
  post-pack output, since packs merge into shared files. Schema 1, written by
  fresh mode today, holds exactly those fields and `parseManifest` rejects any
  other top-level key. The change that makes `/customize` or `--apply` write
  `answers.interview` and the mechanical Round 1 actions (agent removal, the
  verify-policy JSON, the Dependabot swap), so the old base can be rebuilt with
  the tailoring replayed, must extend `parseManifest` with them (and bump
  `schemaVersion` if an older reader would misread the result) and keep them in
  step with Round 1 in `/customize`. Fresh mode's `files` omit the `/customize`
  skill copy and anything under `.groundwork/`. **Two other surfaces read the
  `.groundwork/` directory and must keep knowing about it:** `/customize`
  Step 0.1 (a `.groundwork/` holding only `manifest.json` is a fresh bootstrap,
  not an interrupted run, and a clone holding the tracked reports plus the
  manifest is still a clone of an adopted project), and the recommended
  `.gitignore` block in Step 7 and the adoption report (`report.ts`), which
  must keep `!.groundwork/manifest.json` or the manifest never reaches git. A
  new file under `.groundwork/` that is meant to be tracked needs the same
  three updates.
- **The classifier is a pure function** (`classifyPath` and `classifyAll` in
  `packages/cli/src/upgrade/classify.ts`). `M` is the manifest hash, `C` the
  current file and `N` the new emitted file; an absent file has no hash. The
  rows are read **in order**, the first match wins, so a row never has to
  repeat an earlier row's exclusion:

  | Row | Condition                               | Class           | Skill action          |
  | --- | --------------------------------------- | --------------- | --------------------- |
  | 1   | no `M` and no `N`                       | (error)         | not a baseline path   |
  | 2   | no `M`, `C` absent                      | `add`           | apply in the batch    |
  | 3   | no `M`, `C == N`                        | `current`       | none, re-stamp        |
  | 4   | no `M`, `C != N`                        | `conflict-2way` | per-file proposal     |
  | 5   | `M` and `N`, `C` absent                 | `user-deleted`  | respect, report only  |
  | 6   | `M` and `N`, `C == N`                   | `current`       | none, re-stamp        |
  | 7   | `M` and `N`, `origin: merged`           | `conflict-2way` | per-file proposal     |
  | 8   | `M` and `N`, `N == M`                   | `local-only`    | none                  |
  | 9   | `M` and `N`, `C == M`                   | `safe-update`   | apply in the batch    |
  | 10  | `M` and `N`, anything else              | `conflict-3way` | per-file proposal     |
  | 11  | `M`, no `N` (gone upstream), `C` absent | `gone`          | stamp drops the entry |
  | 12  | `M`, no `N`, `origin: merged`           | `orphan-edited` | report only           |
  | 13  | `M`, no `N`, `C == M`                   | `remove`        | propose delete        |
  | 14  | `M`, no `N`, `C != M`                   | `orphan-edited` | report only           |

  `current` (rows 3 and 6) and `gone` (row 11) are different on purpose.
  `current` means the file exists and already matches the new release, so
  `--upgrade --stamp` re-hashes it from disk. `gone` means the path is recorded
  but is absent from both the new release and the project, so there is nothing
  to hash: stamp must **drop** its manifest entry, or the entry would come back
  as `gone` on every later upgrade.

  A `merged` origin means the recorded base is a hand-merged file that the old
  CLI cannot rebuild, so it is never a 3-way base: row 7 turns every
  difference into a two-way conflict, and row 12 refuses to delete a file the
  user merged, even if it still equals its recorded hash. The classifier
  never lists a path that is only in the project (the project's own file).
  A rename is a delete plus an add. JSON files apply the same rows per key
  (every key is `emitted`). Compare after token substitution (`applyTokens`),
  as `planConflicts` does. Safety property, tested: `safe-update` and `remove`
  are returned only for an `emitted` file whose current hash still equals its
  recorded hash.

- **No manifest means a legacy project.** Run the adopt survey and
  `planConflicts`, call every divergent file `conflict-2way`, set
  `legacy: true` in the plan, and write a manifest at stamp time.
- **The CLI hashes, the skill never does.** `--upgrade --stamp`
  (`stampUpgrade` in `upgrade/stamp.ts`) re-hashes the plan's paths from disk
  and writes the manifest, and nothing else: it never renders, plans or
  stages. It reads `plan.json` `lstat`-first (a regular file only), validates
  it strictly (schema 1, `legacy: false`; read, parse and validation fail
  separately, naming `plan.json` and never quoting its text, a version, an
  unknown key or a token value; both versions must be semantic versions, and
  an unknown key anywhere is refused) and refuses a stale plan (`stale-plan`):
  `fromCliVersion` must equal the manifest's `cliVersion`, the tokens and
  packs must match, and **every entry's `recordedSha256` must equal the
  manifest's hash for that file or JSON key** (no `recordedSha256` needs no
  manifest entry). So a plan from another version, or one whose entries no
  longer match the manifest (as after a stamp that changed any of them), is
  refused as stale; the per-entry message names the path, never a hash. The
  new manifest has the plan's `toCliVersion`. **Base invariant:** the manifest
  has one `cliVersion`, so a kept entry whose hash is not the new release's
  (or that has no new release hash) is recorded as `{old hash, merged}`: its
  base can no longer be rebuilt, and the next upgrade compares it two-way. An
  entry whose hash is the new release's, or that is already `merged`, stays
  as it is. With `D` the disk hash, `R` the plan's `recordedSha256` and `N`
  its `nextSha256`: `gone` drops the entry when the file is absent and keeps
  it when one is there; `orphan-edited` and `local-only` keep it;
  `user-deleted` and a present `remove` keep the old hash, always as
  `merged`; an absent `remove` is dropped; every other class keeps the old
  entry (or none) when the file is absent, records `{N, emitted}` when
  `D == N`, keeps the old entry when `D == R` (not applied, or declined) and
  records `{D, merged}` otherwise; every kept entry goes through the base
  invariant. JSON keys: a present JSON-object file records `N`
  where the key equals it, drops a key absent from both the release and the
  file, and keeps the rest; an absent file drops the keys with no `N` and
  keeps the rest; a non-object keeps every old hash; a present file that does
  not parse or is too deep to hash is `unreadable-file` ("could not hash the
  JSON keys of `<path>`", with `cause`), before anything is written. JSON
  keys carry no origin, so a key kept with its old hash stays a 3-way base
  under the new `cliVersion` until a schema change adds a per-key origin. A file's
  key entry is dropped once empty or with its file entry. Paths and keys the
  plan does not list are kept. No manifest is the same usage error as
  `--upgrade` (with the stamp error as `cause`); no `plan.json` is exit 2 with
  "no plan to stamp -- run --upgrade first"; any other refusal is exit 1. The
  project walk and the token comparison are shared with the plan step in
  `upgrade/project-read.ts`.
- **`--apply <answers.json>` is the only write step.** It touches project files
  only when you ask, and only against a `plan.json` whose hashes still match
  the tree. A changed tree is drift and the run refuses. The `--upgrade` plan
  step never writes a project file. Exit codes 0-4 and the `--json` report are
  shared with the other modes: they are defined in
  [`headless-mode.md`](headless-mode.md). Link to it, do not copy the table.
- **The skill reaches the project through the CLI.** `--upgrade` copies
  `/upgrade` in with the guarded installer `/customize` uses: `lstat`
  presence checks, never overwrite a changed copy (it goes to
  `.groundwork/upgrade/skill/`), `SKILL.md` last, rollback on failure. That
  installer is already generic: `installSkill` and `installSkillGuarded` in
  `plugin.ts` take a `SkillSpec` (`skill-spec.ts`: name, entry file, write
  order, both destinations, where each file is read from), and
  `installCustomizeSkill`/`installCustomizeSkillGuarded` are thin wrappers
  over `CUSTOMIZE_SKILL`. `/upgrade` needs only its own `SkillSpec`; do not
  fork the installer. The same run refreshes an unchanged `/customize` copy.
- **The skill rebuilds an old base with a released CLI.**
  `npx @monte3l/groundwork@<old> --fresh --skip-install --name <n> --pack ... <tmp>`
  needs no new flag for the base itself; the recorded tailoring is replayed on
  top. It records decisions in `.groundwork/upgrade/decisions.json` so a
  compacted session does not re-ask, and checks `plan.json.schemaVersion`
  before reading it. Conflict decisions have one shape, shared with the
  `answers.upgrade` section of an `--apply` answers file:
  `[{path, resolution: keep|take|delegate}]`.
- **A change here is `feat(cli)`,** so it ships as a minor release. The e2e test
  swaps a second fixture template root in after a first bootstrap, so it proves
  the plan without a published release.
