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
**Built so far:** `packages/cli/src/manifest.ts` (schema 1) and fresh mode
writing `.groundwork/manifest.json`. Everything else, `--upgrade`, `--apply`,
the classifier and the `/upgrade` skill, is not in `packages/` yet; the paths
above are where it will land. Update this file as each piece ships, and drop
this line when the last one does.

- **Offline and deterministic, like Phase A.** `--upgrade` reads the project and
  the packaged baseline, and writes only under `.groundwork/upgrade/`:
  `plan.json` last and atomically (the commit marker, as `inventory.json` is
  for adopt), a report and `.staged` copies. It never writes a project file.
  It rejects `--name`, `--force` and `--pack`, and combines with neither
  `--adopt` nor `--fresh`. The pack list comes from the manifest. Adding a pack
  to an existing project is `--pack <name>` in adopt mode
  ([#318](https://github.com/monte3l/m3l-groundwork/issues/318)), which needs no
  manifest. The skill's stamp step records the new pack in the manifest like any
  other change.
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
  skill copy and anything under `.groundwork/`.
- **The classifier is a pure function.** `M` is the manifest hash, `C` the
  current file and `N` the new emitted file:

  | Condition                                  | Class           | Skill action         |
  | ------------------------------------------ | --------------- | -------------------- |
  | `C == N`                                   | `current`       | none, re-stamp       |
  | `N == M`, `C != M`                         | `local-only`    | none                 |
  | `C == M`, `N != M`                         | `safe-update`   | apply in the batch   |
  | `C != M`, `N != M`                         | `conflict-3way` | per-file proposal    |
  | no `M`, absent locally                     | `add`           | apply in the batch   |
  | no `M`, present locally                    | `conflict-2way` | per-file proposal    |
  | `M`, absent locally, still in the baseline | `user-deleted`  | respect, report only |
  | `M`, gone from the baseline, `C == M`      | `remove`        | propose delete       |
  | `M`, gone from the baseline, `C != M`      | `orphan-edited` | report only          |
  | `origin: merged`, `C != M`, `N` changed    | `conflict-2way` | per-file proposal    |

  A rename is a delete plus an add. JSON files apply the same table per key.
  Compare after token substitution (`applyTokens`), as `planConflicts` does.

- **No manifest means a legacy project.** Run the adopt survey and
  `planConflicts`, call every divergent file `conflict-2way`, set
  `legacy: true` in the plan, and write a manifest at stamp time.
- **The CLI hashes, the skill never does.** `--upgrade --stamp` re-hashes the
  plan's paths from disk and writes the manifest, marking `origin: merged`
  wherever the file differs from the staged new content.
- **`--apply <answers.json>` is the only write step.** It touches project files
  only when you ask, and only against a `plan.json` whose hashes still match
  the tree. A changed tree is drift and the run refuses. The `--upgrade` plan
  step never writes a project file. Exit codes 0-4 and the `--json` report are
  shared with the other modes: they are defined in
  [`headless-mode.md`](headless-mode.md). Link to it, do not copy the table.
- **The skill reaches the project through the CLI.** `--upgrade` copies
  `/upgrade` in with the guarded installer `/customize` uses
  (`installCustomizeSkillGuarded` in `plugin.ts`, paths in
  `customize-paths.ts`): `lstat` presence checks, never overwrite a changed
  copy (it goes to `.groundwork/upgrade/skill/`), `SKILL.md` last, rollback on
  failure. Generalise that function to take a skill name; do not fork it. The
  same run refreshes an unchanged `/customize` copy.
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
