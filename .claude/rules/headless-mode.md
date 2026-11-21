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
adopt survey's pending document under `--json` (`headless/pending.ts`); and
the pure adopt apply planner (`headless/actions.ts`, not wired into any CLI
path yet; see "Adopt apply planner"); and its transactional executor and
apply lock (`headless/apply.ts`, `headless/lock.ts`, `headless/errors.ts`,
also not wired; see "Apply is a journal"). Each
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
  The validator protects only the first segment: a nested
  `sub/.git/hooks/...` passes it, and the adopt apply planner rejects it
  instead (a `.git` or `git~1` segment at any depth, folded, is exit 2). Paths
  are unique per array after NFC normalization, upper-casing and then
  lower-casing (so `ſ`, `ı` and the Kelvin sign fold to `s`, `i`, `k`);
  uniqueness is per collection, so the same path may appear in both
  `additions` and `conflicts` and still validate; the adopt apply planner
  rejects it (exit 2, naming both pointers).
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
  disk; the error message names what exists. Decided, to come in the
  `--apply` PR: a partial apply failure throws a typed error that carries the
  artifacts already written), `pending` empty, `error.chain` the
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
- **Adopt apply planner (shipped, not wired).** `planAdoptActions(inventory,
answers, io)` in `headless/actions.ts` is pure: it writes nothing, mutates
  neither input, never throws on a validated answers document (even for an
  older inventory), and its only I/O is `io.sha256OfTarget(path)`, which
  returns a `TargetState` (`absent` only for `ENOENT`, `file` with its
  sha256, or `unreadable` with a code: a directory, a symlink, a permission
  error), called only for an `add`, `take` or `merge-keys` and only after
  every usage check passed. No CLI path calls it yet; `--apply` will. It
  returns actions sorted by path in code-point order (`install-staged`,
  `take-divergent`, `merge-keys` with `stagedPath`, the staged `sha256` and,
  for `merge-keys`, `takeKeys`; `keep`, `skip`, `delegate` with only `path`)
  and handoff entries (one per `delegate`, plus non-empty `missedNotes`
  verbatim), or every usage error (exit 2: a `mode` other than `adopt`, at
  `/mode`; a pack in `packs.install` the inventory did not survey, or two
  installed packs shipping the same folded path; an exact path answered
  twice in one collection; a path the inventory does not list as absent or
  divergent, an inventory path left undecided, a missing staged copy,
  including an inventory too old to carry `stagedDivergent`; `merge-keys` on
  a whole-file difference or with a key the survey did not find different, a
  `.git`/`git~1` segment at any depth, a path in both `additions` and
  `conflicts`, or colliding with a file of an installed pack, after folding),
  or, only when there is no usage error, every drifted path in path order
  (exit 4). Bytes come only from `inventory.stagedBaseline` (`add`) and
  `inventory.stagedDivergent` (`take`, `merge-keys`), never from the
  template. An `add` is drift unless the target is `absent`; a `take` or
  `merge-keys` is drift unless the target is a regular file with the
  survey's hash, so a divergent conflict with `targetSha256: null` is always
  drift with `expected: null`, while `keep` and `delegate` plan normally.
  `actual` in a drift entry is the file's hash, or `null` for anything else.
  Recorded for the `--apply` PR that wires it: reject an inventory with
  `schemaVersion` below 7 at load; containment-check every `stagedPath`
  inside its staging directory and re-verify the staged copy's sha256 before
  writing it; create a new file with exclusive create (`wx`), never a
  truncating open; and wrap a throw from `io` in a typed error that names the
  path.
- **Apply is a journal, not a promise of atomicity.** Stage under
  `.groundwork/headless/txn/`, back up, rename, roll back on failure, write
  `applied.json` last, and recover a leftover `txn/` on the next run. An
  O_EXCL lock at `.groundwork/headless/lock` keeps parallel fleet runs apart.
  **Shipped, not wired:** `applyAdoptActions({ root, actions, dryRun?, io? })`
  (`headless/apply.ts`) resolves to `{ changes, warnings }`, `changes` sorted
  by path, one per written file (`install-staged` an `addition`,
  `take-divergent` and `merge-keys` a `conflict`, with `sha256Before` and
  `sha256After`). It runs under `withApplyLock` (`headless/lock.ts`:
  `.groundwork/headless/lock`, created `wx` with the pid, an ISO time and a
  per-run nonce (the pid plus a random part), a symlinked `.groundwork` or
  `headless/` refused, never stolen, released when the run settles but only
  while it still holds this run's nonce -- a lock removed or replaced
  meanwhile is another run's and is left alone without failing the run; a
  failed create removes nothing, and a release failure
  after a failed run keeps that run's error primary, attaching
  `releaseError`). It rolls back a leftover journal first (one warning;
  a journal that is not exactly the shape it writes is refused, naming the
  journal), then verifies every action before the first write: the staged
  copy is a relative path inside `.groundwork/baseline/` (`install-staged`)
  or `.groundwork/baseline-divergent/` (the other two), a real directory at
  every component, a regular file read with `O_NOFOLLOW`, and its raw bytes
  match the action's sha256; no target breaks the answers validator's
  segment rules (`contract.ts`'s `segmentProblem`: no trailing dot or space,
  no colon), has a first segment that folds (`foldPath`: NFC, upper, lower
  case) to `.groundwork`, or has a `.git`/`git~1` segment at any depth
  (`isGitSegment`, plus `.git~1`, which the executor refuses on top of the
  validator's set), and no path is listed twice after folding (a journal
  step naming such a path, or a journal listing one path twice, is refused
  as tampered); every existing ancestor of the target is a real
  directory; an `install-staged` target is absent; a `take-divergent` or
  `merge-keys` target is a regular file; `merge-keys` refuses a target that
  starts with a UTF-8 byte order mark (its own refusal), one that is not
  strict JSON (a JSONC one would lose its comments), a
  prototype-sensitive key, a key the staged copy lacks and a target whose
  unmodified parse does not re-serialise (in its indent, line ending and
  trailing newline) to exactly its original text ("delegate it instead"). It
  then writes `txn/backup/<n>` (mode 0600) for each replaced file and
  `txn/journal.json`, fsyncs them, `txn/` and `headless/`, and runs
  each write after `io.beforeStep`: `install-staged` creates missing
  parents, then opens the file with `wx` and writes and fsyncs it through
  that descriptor; the other two re-read the target without following a
  symlink, refuse it if its hash moved, and replace it through a
  same-directory temp file (fsynced) and a rename, keeping its mode
  (permission bits only, in the file and in the journal: a setuid, setgid or
  sticky bit is never kept or restored, and a journal recording one is
  refused as tampered) (`merge-keys` keeps the target's indentation, line ending and trailing
  newline). Before the commit point it fsyncs the directory each file landed
  in, every directory it created and each one's parent. Deleting the journal
  is the commit point; `txn/` is fsynced, then removed (a failure is only a
  warning) and `applied.json` (`schema` `groundwork.applied`,
  `schemaVersion` 1, `changes`) is written last, and not at all when nothing
  was written; if that write fails the `ApplyError` has `rolledBack: false`,
  no leftovers, and says the changes landed and must be recorded by hand.
  Removing `txn/` always deletes `journal.json` first, so a half-removed
  `txn/` holds no journal, and the next run removes it with a warning that
  the previous run's changes may have landed without `applied.json` and
  should be checked and recorded by hand. Undo decides by hashes, so the next
  run can recover a journal without knowing which steps landed: a target
  already holding the original is left (no backup needed), a target holding
  the step's bytes is restored from its verified backup (or removed, with
  the directories the step created; one no longer empty is kept with a
  warning), anything else is a leftover. Ownership of an installed file is
  by hash too, in-process as well: once its write completed it is removed
  only while it still holds the staged bytes (an edit made since is a
  leftover, reason "changed", and the file is kept); only a write that
  stopped part-way after this run's exclusive open removes the file whatever
  it holds; a failed open created nothing and is not in `written`. A
  replaced target deleted since is a leftover (reason "deleted"), never
  recreated from its backup, in-process or in recovery. The recovery warning
  lists the restored and already-original paths; a failed recovery's error
  names what it did restore next to the leftover reasons; if the same run's
  plan then fails, its error names the restored paths too (the original
  error chained as `cause`); a cleanup failure after a successful recovery
  is its own `ApplyError`.
  Every failure is an `ApplyError` (`headless/errors.ts`) with `written`
  (paths this run touched, in write order), `rolledBack`, `leftovers`,
  `leftoverReasons` (one per leftover, naming the path and why; a failed
  recovery's `cause` is an `AggregateError` of them) and the original
  failure as `cause`; a rollback with leftovers keeps `txn/` for recovery.
  `dryRun` verifies and returns the same `changes` with no lock, no recovery
  and no write. **Limits:** a directory swapped for a symlink between the
  check and the write cannot be fully prevented without `openat`, which Node
  lacks; durability is fsync best effort (a directory fsync is skipped where
  the platform cannot do it); the rename-replace breaks hard links and drops
  the owner and extended attributes; `merge-keys` only rewrites text it can
  reproduce exactly, though the survey may still offer it for a JSONC target
  (7c aligns the two); a dry run ignores a pending `txn/`; and a stale `txn/`
  that was committed to git could be recovered by a later run, so never
  commit `.groundwork/headless/txn`.
- **PR files only.** `--apply` writes `.groundwork/headless/commit-msg.txt`, a
  Conventional Commit that passes the emitted `bin/lint-commit.mjs`, and
  `pr-body.md`. The caller does the branch, commit, push and `gh pr create`.
- **The skills' headless branch is explicit.** `/customize --headless <file>`
  (later `/upgrade --headless <file>`) and never because a file exists. It
  never calls `AskUserQuestion`, refuses a schema or CLI version mismatch,
  does only the report's `handoff` entries, writes anything undecidable to
  `pending` and stops, and ends by calling the CLI to stamp (the CLI records every hash
  and writes the manifest; the skill never records a hash, though it may run a
  read-only `shasum -a 256` to check a file still matches the plan). Round 2 runs only when `guidance.enabled`, and in headless it only
  reports: every finding is deferred. The documented `claude -p` recipe never
  uses `--dangerously-skip-permissions` and adds `WebFetch` and `WebSearch`
  only when guidance is on.
- **The CLI and the plugin share no import.** Plugin `src` is copied verbatim
  into the skill (`vendor-assets.mjs`), and the CLI has no dependencies.
  The canonical types and validators are in
  `packages/cli/src/headless/contract.ts`; a parity test in
  `packages/plugin/tests/` imports both dynamically and compares the
  `ProjectKind`, `RuntimeTarget` and `CiDepth` tuples.
- **Inventory schema v7** (shipped) adds `conflicts[].targetSha256` and
  stages divergent baseline files, not only absent ones: token-substituted,
  as `inventory.stagedDivergent`, in their own directory
  `.groundwork/baseline-divergent/`, so `stagedBaseline` stays absent-only
  and `/customize`'s handling of it is unchanged. Without them adopt cannot
  detect drift and has no verified bytes to `take`. `/customize` Step 0.1
  accepts 7.
  Consumer contract: `targetSha256: null` on an `absent` conflict means
  nothing is there (a write is safe), but on a `divergent` conflict it means
  the file could not be read -- the drift is undetermined, so `--apply` must
  refuse to `take` it and never treat `null` as "no drift" (decided: drift,
  exit 4, `expected: null`; the planner above implements it). `--apply` trusts
  only `inventory.stagedDivergent` and ignores any leftover
  `.groundwork/baseline-divergent/` directory (an older CLI run after a v7
  run leaves one behind). Staged divergent copies are the UTF-8 decode and
  re-encode of the token-substituted template, which would change a binary
  template's bytes: none exist in `templates/core` today, but `--apply take`
  must keep that in mind.
- **Version.** The CLI's own version decides the release: a new flag or output
  format is `feat`, and the whole series targets the next minor.

When the series ships, `adopt-mode.md` and `package-cli.md` change from "adopt
mode never writes a project file" to "the survey never writes one; only
`--apply` does", and `docs/assurance-case.md` records the new write path, in
the change that adds `--apply`.
