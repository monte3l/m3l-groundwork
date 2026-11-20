---
paths:
  - "packages/cli/src/headless/**"
  - "packages/cli/src/output.ts"
  - "packages/cli/src/run-result.ts"
  - "packages/cli/src/exit-codes.ts"
  - "packages/cli/src/fatal.ts"
  - "packages/cli/src/main.ts"
  - "packages/cli/schemas/**"
  - "packages/cli/tests/headless*.test.ts"
  - "packages/plugin/skills/customize/**"
  - "packages/plugin/skills/upgrade/**"
---

# Headless mode (design record, partly built)

Unattended runs of all three modes -- fresh, adopt and upgrade -- for `claude -p`
agents, fleet scripts, local scripts and CI. This file is the contract the CLI,
the `/customize` skill and the `/upgrade` skill share. Shipped so far: the
exit-code table (`exit-codes.ts`), the `--json` flag for fresh mode and the
adopt survey, the success and error shapes of `report` v1
(`headless/report.ts` plus `schemas/report.v1.schema.json`), and the
`answers` v1 contract (`headless/contract.ts` plus
`schemas/answers.v1.schema.json`); both schemas ship in the tarball; and the
adopt survey's pending document under `--json` (`headless/pending.ts`). Each
is marked **(shipped)** below. Everything else
is design only; the paths above are where it will land. Update this file as
each piece ships, and drop this line when the last one does.

- **Fail closed, never guess.** A decision nobody supplied stops the run with
  exit 3 and a pending document in the answers schema. The caller fills it in
  and re-runs. `kind` and `runtime` have no default (the interview gives none),
  so a run without them is always pending.
- **Plan, then apply.** The `--adopt` survey and the `--upgrade` plan stay
  read-only: they write only under `.groundwork/`. A new
  `--apply <answers.json>` is the only step that writes project files. It reads
  `inventory.json` or `plan.json`, checks every recorded hash against the tree,
  and refuses with exit 4 on drift. Fresh mode validates the answers before its
  first `mkdir`, then bootstraps and applies in one run. `mode` in the answers
  is required and never inferred from the directory.
- **Exit codes** (shipped as `EXIT_CODES`; checked in this order: usage, load the plan, drift,
  completeness, apply). Only these are part of the contract:

  | Code | Meaning                                                               |
  | ---- | --------------------------------------------------------------------- |
  | 0    | Done, or nothing to do (`status` is `ok` or `noop`)                   |
  | 1    | Runtime error                                                         |
  | 2    | Usage error, or an answers/inventory/CLI schema-version mismatch      |
  | 3    | Decisions pending; the pending document was written                   |
  | 4    | Drift: the tree changed since the survey or plan, nothing was written |

- **`--json` keeps stdout pure (shipped for fresh and the adopt survey).** One
  report document on stdout, human text on stderr (`createOut({ json: true })`;
  `Out.notice` carries the warning-painted lines that go to stdout in human
  mode), and child processes (`git init`, `pnpm install`) get
  `["ignore", 2, 2]`. `bin/m3l-groundwork.mjs` looks for `--json` before
  `parseArgs`, so a usage error also produces a JSON envelope; it writes the
  report exactly once, after `main()` returns or after `handleFatal` has
  printed the human error, and the exit codes do not change. `main()` writes
  no report itself. `--version --json` and `--list-packs --json` print their
  own single-line `groundwork.version` and `groundwork.packs` documents;
  `--help` is the one exception and always prints the usage text.
  `--dry-run` (not built) writes nothing, not even under `.groundwork/`.
- **`answers` v1** (`schema: "groundwork.answers"`, `schemaVersion: 1`). One
  file for every mode; the pending document uses the same schema under a
  `partial` profile that allows `null`. Sections: `mode`, `basis`
  (`inventorySha256` or `planSha256`; a mismatch is exit 4), `fresh`
  (`name`, `skipInstall`), `interview` (the field names of `InterviewAnswers`
  in `packages/plugin/src/kind-facet-map.ts`), `adopt` (`additions`,
  `conflicts`, `missedNotes`; the field names of `adoption-decisions.json`
  `step0`), `upgrade` (`applySafe`, `removals`, `conflicts`), `packs`,
  `plugins`, `guidance` and `pending` (`pointer`, `reason`, `choices`,
  `evidence`). Collections are arrays of `{path, ...}`, never path-keyed
  objects, so a path can never land on a prototype key; reuse
  `isPrototypeSensitiveKey` (`merge-json.ts`). Conflict resolutions are `keep`,
  `take` or `delegate`; adopt adds `merge-keys` for key-level JSON.
  `upgrade.conflicts` has the same shape as `.groundwork/upgrade/decisions.json`:
  one record, not two. **Shipped:** the tuples, types and
  `validateAnswers(value, profile)` in `headless/contract.ts`, the gate a
  later `--apply` trusts to drive file writes. It never throws, and every
  error (a `ValidationIssue`) carries a JSON pointer; it stops early at 100
  errors or once its per-call work budget of 1,000,000 units is spent (one
  per object, key, array and array slot, one per path plus one per 256 of its
  characters; beyond it the document is rejected with one error, and a
  document at every top-level cap passes). On success it returns a
  new, deeply frozen plain structure built from values read exactly once,
  sharing no reference with the input. Only plain objects (prototype
  `Object.prototype` or `null`) are accepted; an array's `length` is read
  once and capped at 10,000 entries; strings are capped (10,000 characters
  for `missedNotes`, `reason` and `evidence`, 1,000 for pointers, names,
  domains, plugin ids and `takeKeys` entries); `basis` hashes are 64
  lowercase hex digits; `fresh.name` follows the `--name` rule
  (`npm-name.ts`). The validator counts string lengths in UTF-16 code units,
  JSON Schema `maxLength` in code points, so the validator is the stricter of
  the two. Paths are relative POSIX paths of at most 4,096 characters, with
  no empty, `.` or `..` segment, no segment ending in `.` or a space, no `:`
  in any segment (NTFS alternate data streams), no backslash, drive letter,
  control character or lone surrogate (the validator always rejects a lone
  surrogate; a schema engine that is neither per-code-unit nor per-code-point
  ECMA-262 may not), and a first segment other than `.git`, `.groundwork` or
  `git~1` (the NTFS 8.3 short name of `.git`), compared case-insensitively.
  Only the first segment is protected: a nested `sub/.git/hooks/...` is
  allowed by design, and the `--apply` PR must decide it explicitly. Paths
  are unique per array after NFC normalization, upper-casing and then
  lower-casing (so `ſ`, `ı` and the Kelvin sign fold to `s`, `i`, `k`);
  uniqueness is per collection, so the same path may appear in both
  `additions` and `conflicts`, and the `--apply` PR must define the rule.
  `takeKeys` is
  allowed only with `merge-keys`. `answers.v1.schema.json` is the structural
  (`partial`) shape; `headless-schemas.test.ts` keeps its property names,
  enums, `required` lists, `maxItems` and path pattern in step with the
  validator. `complete` additionally requires the mode's own section and a
  matching `basis` (`inventorySha256` for adopt, `planSha256` for upgrade,
  `null` for fresh), every other mode section `null`, `interview.kind` and
  `runtime` for fresh and adopt, every conflict `resolution`, every
  `additions[].action`, `upgrade.applySafe` and `upgrade.removals` decided,
  and `pending` empty. `interview.testsMandatory`, `ciDepth` and
  `keepAgents` may stay `null` under `complete`: `null` means "use the
  baseline default". Not built yet: `--apply` reading a pending or answers
  document (the adopt survey writes one, see "Pending location").
- **`report` v1** (`schema: "groundwork.report"`, `schemaVersion: 1`):
  `cliVersion`, `mode` (`fresh`, `adopt`, `upgrade` or `null`), `phase`
  (`survey`, `plan`, `apply`, `stamp` or `null`; both are `null` in an error
  envelope), `dryRun`, `status` (`ok`, `noop`, `pending`, `drift`, `error`
  or `usage`), `exitCode`, `target`, `artifacts` (`inventory`, `manifest`,
  `plan`, `pending`, `commitMsg`, `prBody`, each a target-relative path or
  `null`), `changes` (`path`, `action`, `class`, `sha256Before`,
  `sha256After`), `pending`, `handoff`, `drift`, `setupSteps`, `warnings`,
  `nextStep` and `error`, always in that order with no field omitted.
  **Shipped:** `schemas/report.v1.schema.json`, and `buildReport` (a fresh run is `phase: "apply"` with
  `artifacts.manifest` `.groundwork/manifest.json`, copied from
  `RunResult.manifest`; an adopt survey `phase: "survey"` with
  `artifacts.inventory` `.groundwork/inventory.json` and `artifacts.manifest`
  `null`; `artifacts.pending` and `pending` copied from
  `RunResult.pendingPath` and `RunResult.pending`) and `buildErrorReport`
  (`status` `error` for exit 1, `usage` for exit 2, `mode`/`phase` and every
  `artifacts` path `null` **even when the failed run had already written
  files** (a failed `pending.json` write leaves a complete `inventory.json` on
  disk; the error message names what exists, and a typed error that carries the
  written artifacts is planned for the apply step), `pending` empty, `error.chain` the
  message then each chained value's as strings, through `format-error.ts`'s
  `errorMessageChain`: cycle-safe, depth-capped, never throws). `dryRun` is
  always `false` and `changes`, `handoff` and `drift` are always empty until
  `--apply` ships; `pending` holds `PendingEntry` objects, non-empty only for
  an `--adopt --json` survey (see "Pending location"); the `noop`, `pending`
  and `drift` statuses and the `plan` and `stamp` phases are not produced yet.
- **Pending location.** Adopt and upgrade write
  `.groundwork/headless/pending.json`. Fresh must leave the target untouched,
  so its pending document goes only in the report, plus `--pending-out <path>`.
  **Shipped for the adopt survey, under `--json` only:** `runAdopt` writes it
  after `inventory.json`, atomically (temp file plus rename, 2-space JSON and
  a trailing newline), from `buildAdoptPending` (`headless/pending.ts`). It is
  an answers v1 document that passes `partial` and never `complete`, bound to
  the survey by `basis.inventorySha256` (the lowercase hex sha256 of
  `inventory.json`'s bytes as written). Prefilled defaults:
  `interview.testsMandatory` `true`, `ciDepth` `standard`, `keepAgents` every
  baseline agent, packs, plugins and guidance empty or off, `missedNotes`
  empty, each absent baseline file an `add` addition (identical ones
  omitted). Pending, with `null` in the document: `interview.kind`,
  `interview.runtime` (evidence `null`) and each divergent baseline file's
  `resolution` (choices `keep`, `take`, `delegate`, plus `merge-keys` for a
  key-level difference; evidence names the differing keys or says the whole
  file differs). The report's `artifacts.pending` and `pending` mirror it,
  and the survey still exits 0 with `status: "ok"`: exit 3 belongs to
  `--apply`. A failed write is exit 1 with an error naming `pending.json`;
  `inventory.json` and the report stay. Every adopt run, with or without
  `--json`, deletes a previous `pending.json` at its point of no return, and
  `.groundwork/headless/` only when that leaves it empty, so a pending
  document never outlives the inventory it is bound to.
- **What the CLI applies, with no Claude.** Per-file `keep`, `take`, `add` and
  `remove` decisions, staged packs, agent removal, tests warn-only, CI depth
  and the Dependabot block. Explore, `test-author` and `code-implementer` are
  never removable: asking to drop one is exit 2. Everything that needs judgment
  (merges, wiring merges, retargeting prose, the `kind` other than library
  `check:exports` change, plugins) becomes a `handoff` entry for the skill's
  headless branch.
- **No YAML parsing, so tests warn-only and CI depth live in JSON.**
  `templates/core` gains a policy JSON that the emitted `bin/verify.mjs`
  reads, the pattern of `verify-steps.packs.json`; `ci.yml` and `lefthook.yml`
  stay as they are. `dependabot.yml` is a whole-file swap, allowed only when
  its hash still matches what the baseline emitted; any other state is a
  handoff. A change to `templates/core` also needs the harness and toolchain
  graders to agree (`.claude/rules/harness-graders.md`).
- **Apply is a journal, not a promise of atomicity.** Stage under
  `.groundwork/headless/txn/`, back up, rename, roll back on failure, write
  `applied.json` last, and recover a leftover `txn/` on the next run. An
  O_EXCL lock at `.groundwork/headless/lock` keeps parallel fleet runs apart.
- **PR files only.** `--apply` writes `.groundwork/headless/commit-msg.txt`, a
  Conventional Commit that passes the emitted `bin/lint-commit.mjs`, and
  `pr-body.md`. The caller does the branch, commit, push and `gh pr create`.
- **The skills' headless branch is explicit.** `/customize --headless <file>`
  (later `/upgrade --headless <file>`) and never because a file exists. It
  never calls `AskUserQuestion`, refuses a schema or CLI version mismatch,
  does only the report's `handoff` entries, writes anything undecidable to
  `pending` and stops, and ends by calling the CLI to stamp (the skill never
  hashes). Round 2 runs only when `guidance.enabled`, and in headless it only
  reports: every finding is deferred. The documented `claude -p` recipe never
  uses `--dangerously-skip-permissions` and adds `WebFetch` and `WebSearch`
  only when guidance is on.
- **The CLI and the plugin share no import.** Plugin `src` is copied verbatim
  into the skill (`vendor-assets.mjs`), and the CLI has no dependencies.
  The canonical types and validators are in
  `packages/cli/src/headless/contract.ts`; a parity test in
  `packages/plugin/tests/` imports both dynamically and compares the
  `ProjectKind`, `RuntimeTarget` and `CiDepth` tuples.
- **Inventory schema v7** adds `conflicts[].targetSha256` and stages divergent
  baseline files, not only absent ones. Without it adopt cannot detect drift
  and has no verified bytes to `take`. `/customize` Step 0.1 must accept 7 in
  the same change.
- **Version.** The CLI's own version decides the release: a new flag or output
  format is `feat`, and the whole series targets the next minor.

When the series ships, `adopt-mode.md` and `package-cli.md` change from "adopt
mode never writes a project file" to "the survey never writes one; only
`--apply` does", and `docs/assurance-case.md` records the new write path, in
the change that adds `--apply`.
