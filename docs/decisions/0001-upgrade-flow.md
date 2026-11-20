# A three-way upgrade flow driven by a committed manifest

- **Status:** proposed
- **Date:** 2026-11-20

## Context

A project that has already run groundwork has no way to take a newer baseline.
Re-running the CLI works only by accident: it is auto-detected as adopt mode,
which compares two things, the project and the new baseline, so it cannot tell
a file you edited from a file upstream changed. Both look divergent. Fresh mode
leaves no record of which baseline or packs produced the project, and adopt
mode deletes its own `inventory.json` and `adoption-decisions.json` on every
run, so nothing survives to compare against.

## Options

- **Keep re-running adopt mode.** No new code. Every changed file is a
  conflict, packs are never recorded, and decisions are asked again each time.
- **A CLI that applies changes itself.** Fast for untouched files, but the
  deterministic CLI would write project files in an established repo, which
  adopt mode deliberately never does.
- **A committed manifest, a CLI that stages a plan, and a skill that applies
  it.** One new record, one new CLI mode, one new skill. Matches the Phase A
  and Phase B split.

## Decision

The third option.

- **Manifest.** `.groundwork/manifest.json`, tracked in git, written by fresh
  mode and by `/customize` after an adopt. It holds the CLI version, the
  tokens, the pack names and a sha256 per emitted file and per JSON key. It
  stores hashes, not file copies. The old content is rebuilt on demand by
  running the old CLI version through `npx`.
- **`--upgrade` mode.** A third mode beside `--adopt` and `--fresh`. Offline
  and deterministic. It writes only under `.groundwork/upgrade/`: a `plan.json`
  commit marker, a report and staged `.staged` copies. It never writes a
  project file. `--upgrade --stamp` re-hashes the project and rewrites the
  manifest after the skill has applied the plan.
- **`/upgrade` skill.** Applies the safe set in one confirmation, then walks
  through each conflict with a proposed merge. The CLI copies it into the
  project with the same guarded, never-overwrite install that `/customize`
  uses, so it works without the marketplace plugin.
- **Classification.** Each path is compared as manifest hash, current hash and
  new hash. The table is in
  [`.claude/rules/upgrade-mode.md`](../../.claude/rules/upgrade-mode.md).
- **Legacy projects.** With no manifest, the first `--upgrade` is a two-way
  reconciliation that ends by writing one. Later upgrades are three-way.
- **Discovery.** On request only. No network check, no hook, no scheduled PR.

## Consequences

- An untouched file updates without a prompt, and a file only you edited is
  left alone. A conflict is shown as the upstream change next to your change.
- Packs are recorded by name for the first time. `--upgrade` takes no `--pack`:
  its pack list comes from the manifest. Adding a pack to an existing project
  stays with the standalone mode tracked in
  [#318](https://github.com/monte3l/m3l-groundwork/issues/318). That issue's
  done-when needs no manifest, because adopt mode already stages every pack and
  only rejects the flag, so it ships first and independently. The two touch the
  same code (`assertAdoptUsage` and the pack staging) but not each other's
  contract. Folding them together would hold a small, ready change behind the
  larger one.
- A new CLI mode is a `feat`, so it ships as a minor release.
- A file the user or skill merged by hand has a base that cannot be rebuilt,
  so it falls back to a two-way compare on the next upgrade.
- Rebuilding an old base needs the network and the old version still on npm.
  An unpublished version degrades to a two-way compare.
- Revisit this if the manifest drifts from reality often enough that the
  three-way result is wrong more than it is right.
