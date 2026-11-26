# m3l-groundwork

[![CI](https://github.com/monte3l/m3l-groundwork/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/monte3l/m3l-groundwork/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/monte3l/m3l-groundwork/badge)](https://securityscorecards.dev/viewer/?uri=github.com/monte3l/m3l-groundwork)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14937/badge)](https://www.bestpractices.dev/projects/14937)
[![OpenSSF Baseline](https://www.bestpractices.dev/projects/14937/baseline)](https://www.bestpractices.dev/projects/14937)
[![Socket](https://badge.socket.dev/npm/package/@monte3l/groundwork)](https://socket.dev/npm/package/@monte3l/groundwork/overview)
[![REUSE status](https://api.reuse.software/badge/github.com/monte3l/m3l-groundwork)](https://api.reuse.software/info/github.com/monte3l/m3l-groundwork)

m3l-groundwork is a command-line tool that sets up (or reports on) a
TypeScript project's toolchain and [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
setup, then keeps that setup current with live upstream guidance.

Read this project's rendered docs site at
[groundwork.monte3l.com](https://groundwork.monte3l.com).

## Who is this for

- Someone starting a **new TypeScript project** who wants a strict
  toolchain and a working Claude Code setup from the first commit, instead
  of assembling both by hand.
- A team with an **existing TypeScript project** who wants an honest,
  read-only report on how it compares to that same baseline, with no risk
  of an automated tool rewriting their repo.
- Anyone who wants their project's Claude Code configuration and
  TypeScript toolchain to stay aligned with current official guidance,
  rather than frozen at whatever was true the day it was set up.

## New to Claude Code or TypeScript?

- [Claude Code documentation](https://docs.claude.com/en/docs/claude-code/overview)
  -- what it is and how to install it.
- [`docs/glossary.md`](docs/glossary.md) -- plain-English definitions of the
  terms used throughout this repo's docs (harness, skill, pack, gate, and
  so on).
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
  -- if TypeScript itself is new to you.

## Quickstart

Install [Node 24+](https://nodejs.org/), [pnpm](https://pnpm.io/installation)
and [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) first
(see ["Requirements"](#requirements) below for exact versions). Nothing is
installed globally: `npx` and `pnpm dlx` fetch the CLI, run it once and leave
only a download cache behind.

**A new project.** Point the CLI at an empty or missing directory:

```bash
# with npx
npx @monte3l/groundwork my-app

# or with pnpm
pnpm dlx @monte3l/groundwork my-app
```

It writes the baseline, runs `git init` and `pnpm install`, and installs the
`/customize` skill. Add `--pack <name>` to install an optional
[pack](#packs) at the same time (`--list-packs` shows them).

**An existing project.** Run the CLI from the project's root, or pass its path.
It detects that the directory already looks like a project and switches to
adopt mode, which surveys it read-only and never overwrites a project file:

```bash
cd path/to/your-project

# with npx
npx @monte3l/groundwork .

# or with pnpm
pnpm dlx @monte3l/groundwork .
```

It writes a report and staged copies of what it would add under
`.groundwork/`, plus one guarded copy of the `/customize` skill.

**Then, in either case:**

```bash
cd my-app        # or stay in your existing project
claude           # open the project in Claude Code
```

Run `/customize` inside Claude Code. For a new project it interviews you and
tailors the baseline. For an existing one it first reconciles the survey
against your repo and confirms each change with you before editing anything.

> [!NOTE]
> Earlier releases shipped on other [dist-tags](docs/glossary.md#dist-tag).
> If you installed a `0.x` release from `next` or a `1.0.0-rc` release from
> `rc`, switch to the default `latest` tag: a prerelease version range never
> crosses to `1.0.0` on its own. See
> ["Versioning policy"](#versioning-policy) below for what counts as the
> CLI's public API, frozen since 1.0.

## What it is

A two-phase bootstrapper. Point it at a directory and it leaves you with a
strict TypeScript toolchain, a Claude Code [harness](docs/glossary.md#harness),
and CI wired to the same gates you run locally.

**Phase A** (`packages/cli`) is deterministic: an offline Node CLI with no
runtime dependencies that writes the baseline. It makes no network call
beyond the final package install, and the same input always produces the
same output.

**Phase B** (`packages/plugin`) is adaptive: the [`/customize`](docs/glossary.md#customize)
skill, which interviews you (or, for an existing project, reconciles the
CLI's survey against the real repo) and then sweeps current official
TypeScript and Anthropic sources, so the result reflects upstream guidance
today rather than whenever this repo last shipped.

They stay two separate phases on purpose, rather than one -- see
[`docs/architecture.md`](docs/architecture.md#the-two-phase-split) for why.

## Two modes

The mode is auto-detected from the target directory; `--fresh` and `--adopt`
override it. `--add-pack` and `--update` skip detection: they stage into a project
that one of the two modes already set up.

| Mode         | When                                                     | What it does                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fresh**    | The target is empty or missing                           | Writes the full baseline, installs any `--pack`, installs the `/customize` skill, records what it wrote in `.groundwork/` (a lock, a base snapshot and a pack ledger), runs `git init`, then `pnpm install`.                                                                                                                    |
| **Adopt**    | The target already looks like a project                  | Surveys it read-only and writes `.groundwork/`: an inventory, a report, inert `.staged` copies of the baseline files it would add (`.groundwork/baseline/`) and of the packs (`.groundwork/packs/`). It writes only under `.groundwork/`, plus one guarded copy of the `/customize` skill, and never overwrites a project file. |
| **Add-pack** | `--add-pack <name>` on a bootstrapped or adopted project | Stages each named pack as inert `.staged` copies plus a `plan.json` survey under `.groundwork/add-pack/<name>/`, for `/customize add-pack` to install. Beyond `add-pack/<name>/` it creates only `.groundwork/` and `.groundwork/add-pack/` when they are absent, and writes nothing else.                                      |
| **Update**   | `--update` on a bootstrapped or adopted project          | Stages new files, three-way merges, the new lock and a `plan.json` under `.groundwork/update/`, for `/customize update` to apply. It writes nothing outside `.groundwork/update/`.                                                                                                                                              |

That copy lands at `.claude/skills/customize/`, or at `.groundwork/customize/`
when something already there blocks it. It is where the real work happens: it reads the survey, confirms
each change with you, and only then edits your project.

## Packs

A [pack](docs/glossary.md#pack) is an optional bundle of extra files -- an
agent, a hook, a gate -- installed on top of the baseline for projects that
want more than the capped default. A pack never edits YAML or JavaScript;
it only adds files and extends three JSON files the baseline already
reads. See [`templates/packs/README.md`](templates/packs/README.md) for
the wiring contract.

| Pack             | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-extras` | The compaction-handoff hook pair and a read-only Bash guard.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `statusline`     | A five-row Claude Code status line plus a `subagent-rows` mod for the agent panel (Claude Code 2.1.326+), width-fit to the terminal. Sets the `statusLine` key. Optional m3l-design colors, offered by `/customize` and never on by default ([preview](https://groundwork.monte3l.com/docs/statusline.html)).                                                                                                                                                          |
| `quality`        | A per-file size ratchet gate over `src/` and `tests/`, and a read-only `type-design-analyzer` review agent. Adopt-capable, recommended for every project kind.                                                                                                                                                                                                                                                                                                         |
| `frontend`       | A read-only `ui-reviewer` accessibility agent (static WCAG 2.2 review) and a `new-component` skill that mirrors a sibling component. Recommended for the `frontend` kind only.                                                                                                                                                                                                                                                                                         |
| `service`        | A read-only `performance-analyzer` agent (static review for blocking calls and unbounded work; profiling is reported as `NOT CHECKED`) and an `api-doc` skill that writes an OpenAPI description from the routes the code defines. Recommended for the `service` kind only.                                                                                                                                                                                            |
| `claude-github`  | Anthropic's official Claude Code GitHub Action as two workflows: `@claude` mention-mode and an automated PR-review comment on every pull request -- no hooks, no gate. Needs an auth secret the pack cannot create, and the review spends API credits per PR.                                                                                                                                                                                                          |
| `github`         | Three `gh`-CLI skills (Dependabot PR triage, scan-alert triage, PR-check watching) -- no hooks, no gate, no workflows.                                                                                                                                                                                                                                                                                                                                                 |
| `publishing`     | A release pipeline (changesets version-PR / staged, provenance-attested npm publish via trusted publishing). Fresh mode only.                                                                                                                                                                                                                                                                                                                                          |
| `licensing`      | An SPDX/REUSE license-header gate (`check-license-headers.mjs`, a `lint`-group verify step) and a `REUSE.toml` template. Fresh mode only, because the one-time backfill fails an established project's `pnpm verify`.                                                                                                                                                                                                                                                  |
| `supply-chain`   | Secret scanning (`gitleaks.yml`) and an OpenSSF Scorecard run (`scorecard.yml`) for any GitHub project, published or not. Two workflows (read-only apart from the Scorecard job's `security-events` and `id-token` write), adopt-capable, recommended for every project kind.                                                                                                                                                                                          |
| `worktrees`      | Enforces that all src/tests development happens inside an isolated git worktree, on any branch, for any caller: a `working-in-worktrees` skill (start/status/sync/finish/fan-out), a dependency-install backstop hook, a guard stricter than the baseline's own branch/hub guards, and a `.worktreeinclude` copying `.env`/`.env.local`/`.env.*.local` into every worktree Claude Code creates. Changes the day-to-day workflow -- opt-in, not recommended by default. |

In fresh mode `--pack` installs a pack directly and records it in the ledger. In adopt mode the CLI only
surveys which packs apply and stages them under `.groundwork/packs/` (and
the baseline files it would add under `.groundwork/baseline/`);
`/customize` installs from there after you confirm.

To add a pack to a project that is already set up, run
`npx @monte3l/groundwork . --add-pack <name>`, then `/customize add-pack <name>`
in Claude Code. The CLI only stages the pack. `/customize add-pack` shows its
plan, asks before writing anything, installs it, and records it in
`.groundwork/installed-packs.json`, a ledger to commit so every clone knows
which packs the project has.

`--list-packs <dir>` marks a pack **outdated** when the ledger says it was
installed by an older release and the pack has changed since. The check is
offline: the CLI ships a history of every release's pack files. To refresh an
outdated pack, stage it again with `npx @monte3l/groundwork . --add-pack <name>
--reinstall` and run `/customize add-pack <name>`. A pack the ledger does not
list, such as one installed at bootstrap with `--pack`, is never reported as
outdated.

## Updating a project

When a new release ships, a project that is already set up updates in three steps:
check, stage, apply. Nothing touches your files until you confirm in Claude Code.

To see whether the whole project is behind, run
`npx @monte3l/groundwork <dir> --check-update`. It compares the template files
of the release your project was installed from (the base, read from
`.groundwork/groundwork.lock.json`; a project with no lock is matched to the
closest release, or you pass `--base-version`) with the ones the running CLI
ships, and counts what changed, was added or was removed upstream, plus any
outdated packs. A project installed by the running release reads as up to date.
It writes nothing to your project and needs no network. When your project is
behind, it also says what an update would do to your own files, for example
`if you update: 4 update cleanly, 2 need a merge, 1 conflict`: files you never
touched update cleanly, files you changed and groundwork changed too need a
merge, a `package.json` or settings file that both sides changed is merged key
by key (a dependency bump no longer conflicts with the rest of
`devDependencies`) and only conflicts on a key both sides changed, and files you
changed but groundwork did not are left alone. Files that `/customize` tailored
for you, such as a `pnpm` command rewritten to `npm`, stay yours unless groundwork
also changed them. It prints a `note:` line whenever a comparison could not run
(including the preview of what an update would do), and says how many were
skipped in the final line, so a bare "up to date" never hides a skipped check. In
the rare case where the templates are unchanged but your own files would still
change, the last line says so and the exit code stays `0`. Exit `0` means up to
date and exit `3` means an update is available, so a CI job or a hook can act on
it. Run it with `@latest` to compare against the newest release.

To stage the update, run `npx @monte3l/groundwork <dir> --update`, the same
two-step shape as adding a pack: the CLI stages and `/customize update` applies.
The CLI writes only under `.groundwork/update/` (the emitted project's
`.gitignore` ignores it) and never changes your files. For each file it stages
the new version, the three-way result where both sides changed it (text files go
through `git merge-file`, JSON files merge key by key), the new lock, the
current `/customize` skill files and a `plan.json` listing every file, what
would happen to it and the hash of everything staged, written last. A file with
conflicting changes is staged with conflict markers for you to resolve, and is
never applied with markers in it. Running it twice on an unchanged project gives
the same plan, so a teammate can re-run it and compare. When nothing would
change, it prints `already up to date` and writes nothing.

Then run `/customize update` in Claude Code. If your project's copy of the skill
predates `update`, refresh it first from `.groundwork/update/customize/`; the
CLI's `next:` line says so. `/customize update` checks the plan and the hash of
every staged file, shows you the plan, and refuses to go on when any file it
would touch has uncommitted changes (unrelated dirty files are fine). It then
creates a branch `groundwork/update-<from>-to-<to>`, asks once for the
defaults and once more for each conflict, review or rename (keep yours, take
groundwork's, resolve together, or skip), applies the files and any outdated
packs, refreshes its own skill copy last, runs your project's gate, and records
the new lock and base snapshot. It offers a commit but never pushes. Commit
`.groundwork/groundwork.lock.json`, `.groundwork/base/` and
`.groundwork/installed-packs.json`, so teammates share the same update state.
Choices you made earlier (kept or declined files) are remembered and are not
asked again unless groundwork changed that file since.

## Flags

| Flag                     | Effect                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <project-name>`  | Override the project name (default: the target directory's basename).                                                                                                                                                                     |
| `--skip-install`         | Skip the final `pnpm install` (fresh mode only).                                                                                                                                                                                          |
| `--force`                | Overwrite a non-empty target directory (fresh mode only).                                                                                                                                                                                 |
| `--adopt`                | Force adopt mode, even if the target looks empty.                                                                                                                                                                                         |
| `--fresh`                | Force fresh mode, even if the target looks like an existing project.                                                                                                                                                                      |
| `--pack <name>`          | Install an opt-in pack from `templates/packs/` (fresh mode only; repeatable).                                                                                                                                                             |
| `--add-pack <name>`      | Stage a pack into an already bootstrapped or adopted project, under `.groundwork/add-pack/<name>/`, for `/customize add-pack` to install (repeatable). Creates `.groundwork/` and `.groundwork/add-pack/` if absent; writes nothing else. |
| `--reinstall`            | With `--add-pack`: stage a pack the project already has installed.                                                                                                                                                                        |
| `--list-packs [<dir>]`   | Print every available pack and exit. With a directory, also report which packs that project already has (installed, outdated, partial, not installed or undetermined), without writing anything.                                          |
| `--check-update`         | Report whether the running CLI's templates differ from the release this project was installed from, without writing anything. Exit `0` when up to date, `3` when an update is available. Needs a directory. Works offline.                |
| `--base-version <x.y.z>` | With `--check-update` or `--update`: use this release as the base instead of the one the lock records (or the closest match, when the project has no lock).                                                                               |
| `--update`               | Stage an update for a project that is already set up, under `.groundwork/update/`: the new files, three-way merge results, the new lock and a plan. Writes nothing else; `/customize update` applies it. Needs a directory.               |
| `--help`, `--version`    | Print usage, or the CLI's version.                                                                                                                                                                                                        |

An unexpected failure (anything that is not a bad invocation) prints its
error name before the message, for example `TypeError: ...`. Set `M3L_DEBUG`
to any non-empty value to also print its stack trace.

## Requirements

- **Node 24+**. `.node-version` is the authority.
- **pnpm**. Fresh mode ends with a `pnpm install` in the new project (skip it
  with `--skip-install`), and this repo pins 12.8.1 through `packageManager`.
- **git**.
- **Claude Code**, for Phase B only. The CLI itself does not need it.

## Install and run

The Quickstart above covers the common case. Here are two other ways to
run this project.

To run it from a checkout instead (or to work on it), build it and call the
built entry point directly:

```bash
git clone https://github.com/monte3l/m3l-groundwork.git
cd m3l-groundwork
pnpm install
pnpm build

node packages/cli/bin/m3l-groundwork.mjs ../my-new-project
```

The `/customize` skill is also available as a Claude Code plugin, for use in
a project that was not bootstrapped by this CLI:

```bash
claude plugin marketplace add monte3l/m3l-plugins
claude plugin install m3l-groundwork-customize@monte3l
```

```text
/plugin marketplace add monte3l/m3l-plugins
/plugin install m3l-groundwork-customize@monte3l
```

The first pair runs in your shell, the second inside a Claude Code session.
Settings and management are in the
[plugin README](packages/plugin/README.md).

`npx` leaves nothing installed globally -- it only populates its own
download cache (`npm cache clean` clears it, if you want that back too).

## What a fresh bootstrap gives you

```
my-new-project/
├── src/, tests/           # placeholder entry point and test
├── tsconfig*.json         # strict flags, split into base / tooling / build
├── eslint.config.js       # typescript-eslint, flat config
├── vitest.config.ts       # v8 coverage with a per-file gate
├── lefthook.yml           # pre-commit, commit-msg and pre-push hooks
├── bin/verify.mjs         # runs the same five gate groups CI runs
├── .github/workflows/     # ci, dependency-review, security-audit
├── .claude/               # agents, skills, hooks, rules, settings.json
├── CLAUDE.md              # the agent-facing project guide
├── docs/research/         # living trackers for the guidance sweeps
└── .groundwork/           # what was installed: lock, base snapshot, pack ledger
```

`.groundwork/` is what a later update measures against, so commit it:
`groundwork.lock.json` lists every file groundwork wrote with the release it
came from and the hash of its pristine bytes, `base/<path>.base` holds those
pristine bytes (the `.base` suffix keeps every tool and Claude Code from
reading them as live files), and `installed-packs.json` records each `--pack`
you chose. The lock also names `README.md` in a `skip` list, because it is
yours to rewrite. Nothing in `.groundwork/` is loaded as code or context.

`pnpm verify` runs the same five [groups](docs/glossary.md#verify-group)
(`format`, `lint`, `typecheck`, `build`, `test`) that the pre-push hook and
CI run, all read from one list in `bin/lib/verify-steps.mjs`. The baseline
is also graded by two offline checks, one for the harness and one for the
toolchain, that run as part of `pnpm verify`.

The baseline is deliberately [capped](docs/glossary.md#cap): at most 5
agents, 8 skills, 10 hooks, 3 CI workflows and 12 root scripts. Anything
useful beyond that ships as a pack instead.

## Then run /customize

The skill lands at `.claude/skills/customize/` in the target project. Open it
in Claude Code and run `/customize`.

In adopt mode the CLI never removes or overwrites anything the project owns
there. A `.claude/skills/customize/` that holds only files with none of the
skill's names is used as is, and the skill is added beside them. If the
project already owns an entry under one of the skill's names, the CLI writes
the skill to `.groundwork/customize/` instead and says so; Claude Code does
not load that copy, so run the plugin's `/customize` or replace the project's
copy yourself. If `.claude`, `.claude/skills` or `.claude/skills/customize` is
a symlink or not a directory, no project copy exists: fix that path, copy the
staged skill into place, or run the plugin's `/customize`. Fresh mode with
`--force` does replace an existing skill copy. Fresh mode also checks, before
it writes anything, that no directory component of a destination below the target directory and no existing
file the baseline or a `--pack` would write is a symlink (or a non-directory
where a directory is needed); the same check covers the `/customize` skill copy's destination. If one fails, it refuses and writes nothing. The
target directory itself and its ancestors are not checked, and neither are
the `.git` directory `git init` creates and the `node_modules` the install step
fills: a symlink there is followed.

- **Fresh project:** a short interview (project kind, runtime target, test
  strictness, CI depth) tailors the baseline, then a guidance sweep checks the
  result against current upstream sources.
- **Adopted project:** Step 0 reconciles the survey against the real repo and
  confirms each change before anything is written, then the same guidance
  sweep runs.

## Working on this repo

`pnpm verify` runs every gate. The pre-push hook and CI run the same five
groups by name, so anything `pnpm verify` catches, CI catches too. CI adds
the end-to-end jobs on top (`pnpm test:e2e` on Linux and macOS), a Node-current
verify run and a DCO check, all rolled up by the `verify` job. `pnpm test:e2e`
is the real acceptance test: it
bootstraps throwaway projects with the built CLI and runs their own
`pnpm verify`. It is slow and touches the network, so it is not part of
`pnpm verify`; run it yourself after any change to `packages/cli/src/`,
`templates/core/` or the `/customize` skill. `pnpm eval` makes paid model
calls and never runs in CI.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full setup and PR workflow.

### Releasing

See [`CONTRIBUTING.md`](CONTRIBUTING.md#releasing) for how
`@monte3l/groundwork` is released, published, and verified, and
[`CLAUDE.md`](CLAUDE.md#releases) for the full design.

The `/customize` plugin has no release of its own. The central
`monte3l/m3l-plugins` marketplace lists it pinned to a CLI release tag
(`@monte3l/groundwork@X.Y.Z`), so a plugin change reaches marketplace users
only after the next CLI release **and** a pin-bump PR in `monte3l/m3l-plugins`.

[`CLAUDE.md`](CLAUDE.md) is the full reference: architecture, the command
table, conventions, and known gaps.

### Project docs

- [`CONTRIBUTING.md`](CONTRIBUTING.md) -- how to contribute.
- [`GOVERNANCE.md`](GOVERNANCE.md) -- decision-making, roles, and access
  continuity.
- [`ROADMAP.md`](ROADMAP.md) -- what's planned, and what isn't.
- [`SECURITY.md`](SECURITY.md) -- reporting a vulnerability, and how to
  verify a release.
- [`docs/architecture.md`](docs/architecture.md) -- a high-level map of the
  two phases.
- [`docs/assurance-case.md`](docs/assurance-case.md) -- the threat model and
  security design argument.
- [`docs/glossary.md`](docs/glossary.md) -- plain-English definitions of
  this repo's jargon.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

### Exit codes and failure behaviour

Exit `2` is a bad invocation, raised before anything is written. Exit `1` is
everything else that goes wrong at run time. Exit `3` is only ever returned by
`--check-update`, and means an update is available; it is not a failure.

| Situation                                                                                                                                                                                                                                                                                 | Exit | What happens / what to do                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unrecognized flag, missing flag value, repeated `--name`, missing or extra target argument                                                                                                                                                                                                | 2    | Prints the error and the usage text.                                                                                                                                                              |
| `--adopt` with `--fresh`                                                                                                                                                                                                                                                                  | 2    | The two are mutually exclusive.                                                                                                                                                                   |
| `--name` is not a valid npm package name, or a `--pack` value is not a valid pack name                                                                                                                                                                                                    | 2    | Prints the rule it broke and the usage text.                                                                                                                                                      |
| Unknown `--pack`                                                                                                                                                                                                                                                                          | 2    | Lists the available packs.                                                                                                                                                                        |
| `--pack` for a pack without fresh mode                                                                                                                                                                                                                                                    | 2    | Says the pack does not support fresh mode and lists its modes.                                                                                                                                    |
| Adopt mode with `--adopt` and a missing target directory, `--force` or `--pack`                                                                                                                                                                                                           | 2    | Adopt never writes project files and surveys every pack itself; run `/customize` to install a pack.                                                                                               |
| Windows, fresh mode                                                                                                                                                                                                                                                                       | 1    | Refuses before writing anything: Linux and macOS only. Adopt mode, `--help`, `--version` and `--list-packs` still run.                                                                            |
| Fresh target is not empty and `--force` is absent                                                                                                                                                                                                                                         | 1    | Refuses; pass `--force` to overwrite, or `--adopt` to survey it.                                                                                                                                  |
| Fresh mode, `/customize` skill install fails                                                                                                                                                                                                                                              | 1    | The project is already written and `git init` and `pnpm install` did not run. Re-run with `--fresh --force` plus your original `--name`, `--pack` and `--skip-install`; a plain re-run adopts it. |
| Fresh mode, `git init` fails                                                                                                                                                                                                                                                              | 1    | The project is left written. Run `git init` (and `pnpm install` unless `--skip-install`) yourself.                                                                                                |
| Fresh mode, `pnpm install` fails                                                                                                                                                                                                                                                          | 1    | The project is left written without dependencies. Run `pnpm install` there yourself.                                                                                                              |
| Adopt mode fails after it starts deleting the previous run's files                                                                                                                                                                                                                        | 1    | The message names which of `inventory.json`, `adoption-report.md` and `adoption-decisions.json` were removed; fix the cause and re-run. A removed `adoption-decisions.json` is not recreated.     |
| `--add-pack` with `--pack`, `--adopt`, `--fresh`, `--force` or `--skip-install`, or `--reinstall` without `--add-pack`                                                                                                                                                                    | 2    | Names the conflicting flags.                                                                                                                                                                      |
| `--add-pack` on a missing, empty, unrecognised or half-adopted directory                                                                                                                                                                                                                  | 2    | Says what to run first: bootstrap with `--pack`, or `m3l-groundwork <dir>` to adopt.                                                                                                              |
| `--add-pack` for an unknown pack, a fresh-only pack on an adopted project, an installed pack without `--reinstall`, or a pack whose required path is missing from a bootstrapped project                                                                                                  | 2    | Nothing is staged, for any of the named packs.                                                                                                                                                    |
| `--add-pack` fails while staging                                                                                                                                                                                                                                                          | 1    | Packs staged before the failure stay staged; the message names which were staged and which were not. Re-run for the rest.                                                                         |
| A pack's manifest fails to load                                                                                                                                                                                                                                                           | 1    | A broken install, not a bad invocation.                                                                                                                                                           |
| `--check-update` with `--pack`, `--add-pack`, `--reinstall`, `--adopt`, `--fresh`, `--force`, `--skip-install` or `--list-packs`; `--base-version` without `--check-update`; a `--base-version` that is not `x.y.z`                                                                       | 2    | Names the conflicting flags.                                                                                                                                                                      |
| `--check-update` on a missing or non-directory target, a half-adopted project, a project that is neither adopted nor bootstrapped, an unreadable lock or one newer than the CLI, or a base release it cannot find                                                                         | 2    | Nothing is written. The message says what to do: re-run adopt, pass `--base-version`, or run a newer CLI.                                                                                         |
| `--check-update` cannot read the CLI's own template history                                                                                                                                                                                                                               | 1    | A broken install, not a bad invocation.                                                                                                                                                           |
| `--update` with `--check-update`, `--pack`, `--add-pack`, `--reinstall`, `--adopt`, `--fresh`, `--force`, `--skip-install`, `--list-packs` or `--name`; `--base-version` without `--check-update` or `--update`                                                                           | 2    | Names the conflicting flags.                                                                                                                                                                      |
| `--update` on a missing or non-directory target, a half-adopted project, a project that is neither adopted nor bootstrapped, an unreadable lock or one newer than the CLI, a base release it cannot find, or a `.groundwork` or `.groundwork/update` that is a symlink or not a directory | 2    | Nothing is written. The message says what to do.                                                                                                                                                  |
| `--update` fails while staging                                                                                                                                                                                                                                                            | 1    | The previous `.groundwork/update/`, if any, is left exactly as it was; the message names the cause.                                                                                               |

A flag value that starts with `-` counts as missing, and `--pack` and `--add-pack`
are the only value flags you can repeat. `--help`, `--version`, `--list-packs` and `--update` exit `0` (and `--check-update` exits `0` or `3`), but an
unrecognized or malformed flag anywhere on the command line still exits `2` first.

### Mode signals

In adopt mode the signal that chose the mode is printed as
`adopt mode: <signal>` and recorded in the report's `**Mode:**` line. The
fresh-mode signals only explain the detection: nothing prints them.

| Signal                                                 | Mode  | When                                                  |
| ------------------------------------------------------ | ----- | ----------------------------------------------------- |
| `<dir> does not exist yet`                             | Fresh | The target is missing.                                |
| `<dir> is empty`                                       | Fresh | The target is an empty directory.                     |
| `<dir> exists but has no recognizable project markers` | Fresh | None of the adopt signals below match.                |
| `found package.json`                                   | Adopt | A `package.json` is in the target.                    |
| `found a .git directory`                               | Adopt | A `.git` directory is in the target.                  |
| `found a .git file (a worktree or submodule)`          | Adopt | `.git` is a file.                                     |
| `found <name>`                                         | Adopt | A loose `.ts`, `.tsx` or `.js` file is in the target. |
| `--adopt forced`                                       | Adopt | `--adopt` was passed.                                 |
| `--fresh forced`                                       | Fresh | `--fresh` was passed.                                 |

### Report headings

`.groundwork/adoption-report.md` is written in this order. Headings are
exact strings.

| Heading                                        | Present                                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `# Adoption report`                            | Always, followed by a `Generated ...` line and the `**Mode:**` line                                                                                                                                                           |
| `## Codebase shape`                            | Always                                                                                                                                                                                                                        |
| `## Toolchain enforcement in effect`           | Always                                                                                                                                                                                                                        |
| `## Toolchain grade`                           | Always; says there is nothing to grade when no toolchain files exist. Has `### Toolchain wiring findings` and `### Toolchain quality findings (advisory)` when there is something to grade                                    |
| `## Existing Claude Code harness`              | Always; short when there is no `.claude/` directory                                                                                                                                                                           |
| `## Harness grade`                             | Always; says there is nothing to grade when neither `.claude/` nor `CLAUDE.md` exists. Has `### Wiring findings`, `### Quality findings (advisory)` and `### Baseline harness files this project has changed` when applicable |
| `## Human-facing docs & guidelines`            | Always                                                                                                                                                                                                                        |
| `## Baseline caps after a merge (approximate)` | Always                                                                                                                                                                                                                        |
| `## Available packs`                           | Always, with one `### <pack name>` per pack when any packs exist                                                                                                                                                              |
| `## What groundwork would change`              | Always                                                                                                                                                                                                                        |
| `## Could not be determined`                   | Always                                                                                                                                                                                                                        |
| `## Next step`                                 | Always, followed by a staged-files note (when anything was staged) and a note that `.groundwork/` was not added to `.gitignore`                                                                                               |

The CLI never edits your `.gitignore`: the closing note says so and leaves
the choice to you.

## Versioning policy

`@monte3l/groundwork` follows [Semantic Versioning](https://semver.org/).
Until 1.0.0, breaking changes ship in a `minor` release, as SemVer allows
for major version zero -- see the changelog for
examples. From 1.0.0, the public API is:

1. **CLI flags, modes, and exit codes** -- `--help` lists every flag; exit
   `0` is success, `1` is a runtime failure, `2` is a bad invocation, `3` is
   "an update is available" from `--check-update` (see
   [Exit codes and failure behaviour](#exit-codes-and-failure-behaviour)).
   The mode is announced on stdout as `adopt mode: <signal>` (adopt only)
   and in the report as `**Mode:** adopt -- <signal>`; the signals are
   listed under [Mode signals](#mode-signals).
2. **`.groundwork/inventory.json`** -- a `schemaVersion` bump that
   `/customize` can't read is a breaking change.
3. **`.groundwork/adoption-report.md`'s section headings**, listed under
   [Report headings](#report-headings).
4. **`.groundwork/packs/` and `.groundwork/baseline/` staging layouts**, and
   pack names. Baseline files are staged as inert copies with a `.staged`
   suffix appended to each name (so no project tool discovers them), listed
   with their original path and a `sha256` in `inventory.json`'s
   `stagedBaseline`. Packs follow the same convention:
   `.groundwork/packs/<name>/pack.json.staged` and
   `.groundwork/packs/<name>/files/<path>.staged`, listed with their original
   path and a `sha256` in `inventory.json`'s `stagedPacks`. All packs are
   staged together: written to a temp sibling directory and swapped in by
   rename, never half-written.
5. **`.groundwork/groundwork.lock.json` and the `.groundwork/base/` layout**
   written at bootstrap: the lock's `schemaVersion` (a bump that changes a
   field's meaning is breaking), its field names, and the `<path>.base` naming
   of the pristine snapshots. The CLI's adopt mode never writes, rewrites or
   deletes them.
6. **The `engines.node` floor** -- narrowing it is breaking; widening it
   isn't.
7. **`/customize`'s invocation name**, and the promise that it reads every
   inventory `schemaVersion` the CLI has ever emitted since 1.0.

**Not covered by this policy:** the **contents** of the baseline the CLI
emits (`templates/core/`, `templates/packs/`). What a fresh bootstrap
writes into your project follows current upstream TypeScript and Anthropic
guidance and can change in a minor release -- that's the whole point of
`/customize`'s live guidance sweep. Also not covered: internal modules
(anything under `packages/*/src/` not listed above) and the exact prose of
`adoption-report.md`'s body.

**Deprecation:** anything on this list gets at least one minor release with
a visible warning before it's removed in a major release.

## License

[MIT](LICENSE). The license covers the bootstrapper itself, not what it
writes: the code the CLI emits into your project is yours to use and
relicense as you see fit.
