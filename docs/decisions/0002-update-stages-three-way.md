# Update stages a three-way merge; a tracked lock and base record what was installed

- **Status:** accepted
- **Date:** 2026-11-25

## Context

A project that already adopted groundwork, or was bootstrapped by it, had no
supported way to move to a newer release. The only path was to re-run adopt and
then `/customize`, and that path loses information at every step:

- `planConflicts` compares the new baseline with the project file and nothing
  else, so an upstream change and a local edit both read as `divergent`. Files
  that `/customize` itself retargeted (`pnpm` to `npm`, new paths) stay
  `divergent` forever, and `package.json` is compared per top-level key, so
  `devDependencies` is one block.
- A file the baseline removed or renamed is never reported, because the walk
  starts from the current template. A pack reinstall only adds wiring.
- A pack in the ledger counts as `installed` whatever its files say. The
  ledger's `cliVersion`, `manifestSha256` and per-file hashes are written and
  never read.
- Every adopt re-run deletes `adoption-decisions.json` and
  `customization-report.md`, so each "keep yours" answer is asked again.
- A differing `/customize` copy in `.claude/skills/customize/` is never
  refreshed, and the skill checks `schemaVersion` only, never the CLI version.
- The inventory, staging and decisions are untracked, so a teammate's clone
  cannot continue or verify an update.
- A fresh bootstrap writes no `.groundwork/` at all and never saves its
  interview answers. Re-running the CLI on it auto-detects adopt mode, and the
  tailoring then looks like drift.

## Options

- **The CLI applies the update.** Copier and Cruft work this way. It is the
  fastest, but the CLI would write project files in a project it did not just
  create, against the rule ADR 0001 kept: the CLI never overwrites a project
  file once the project exists.
- **Regenerate and diff, as Copier does.** Regenerate the old baseline from
  recorded answers, then diff. This needs the old templates at update time,
  which the offline CLI does not have.
- **The CLI stages a three-way merge, `/customize update` applies it.** A
  tracked lock and base snapshot record what was installed. The CLI computes
  base, ours and theirs per file and stages the results. `/customize` confirms
  and writes.

## Decision

The third option, in the same two-step shape as add-pack:

- `npx @monte3l/groundwork . --update` writes only `.groundwork/update/`
  (inert `.staged` copies, merged results, then a `plan.json` written last).
  `--check-update` reports without staging and exits 3 when an update is
  available, since 1 and 2 are already taken.
- A **lock** (`.groundwork/groundwork.lock.json`), a **base snapshot**
  (`.groundwork/base/<path>.base`) and an **answers file**
  (`.groundwork/answers.json`) are tracked in git. They record the installed
  version, each file's pristine hash and status, and the interview answers and
  retargets. Fresh mode writes the lock and base; `/customize` writes the
  answers and keeps the lock current. The CLI's adopt mode never writes or
  deletes them.
- A project with no lock gets its base from a **template history** shipped in
  the tarball (per-release hashes of every template file). `--fetch-base` is
  the one opt-in network path and rebuilds the exact base from npm.
- Text merges use `git merge-file -p --diff3`, whose exit status is the conflict
  count. JSON merges (`package.json`, `tsconfig*.json`, `settings.json`) are
  three-way per nested key, so a dependency bump no longer conflicts with the
  rest of `devDependencies`. A file is never written with conflict markers.
- Renames and dropped wiring are declared in a shipped, version-gated
  migrations file (applied when the base is older than `since` and the CLI is
  at or past it), as Copier's `_migrations` does.
- Applying refuses when any path it would touch has uncommitted changes, and
  runs on its own branch so the update is a reviewable change.
- Packs update through the same plan and `pack-install.md`. `--list-packs` gains
  an `outdated` status. The ledger stays at schema 1 with additive changes.

It mirrors the official tools without copying their weak points: a recorded
base and answers (Copier, Cruft), a three-way merge (`git merge-file`), a check
command with its own exit code (`copier check-update`, `cruft check`),
version-gated migrations (Copier), and a clean-tree precondition (`ng update`).
Staging first keeps the CLI's one rule for existing projects and keeps the
confirmation in the step that can ask.

## Consequences

An update takes two steps, the CLI run and `/customize update`, and a project
with an old `/customize` copy must refresh it first; the CLI's closing `next:`
line says so. The first update of a project with no lock depends on the shipped
history, so each release needs a history entry committed before the next
release PR can pass, and a verify gate enforces it. The base snapshot adds up to
about 2 MB of tracked files, which git stores as the same blobs as the live
files.

The same interim hazard as ADR 0001 applies. Writing `.groundwork/` at
bootstrap would make the current `/customize` Step 0.1 read it as an
interrupted adopt run, so the Step 0.1 exemption for the lock, `base/`,
`answers.json` and `update/` must ship in the same release as the first
bootstrap that writes them.

Revisit if `git merge-file` output varies enough between git versions to cause
review noise (the plan records the git version), or if hook arrays in
`settings.json` need a merge by `command` rather than as whole values.

The work lands in seven pull requests, in the order set out in
[`docs/architecture.md`](../architecture.md#update-flow).
