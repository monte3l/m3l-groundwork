# m3l-groundwork

[![CI](https://github.com/monte3l/m3l-groundwork/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/monte3l/m3l-groundwork/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/monte3l/m3l-groundwork/badge)](https://securityscorecards.dev/viewer/?uri=github.com/monte3l/m3l-groundwork)
[![Socket](https://badge.socket.dev/npm/package/@monte3l/groundwork)](https://socket.dev/npm/package/@monte3l/groundwork/overview)

m3l-groundwork is a command-line tool that sets up (or reports on) a
TypeScript project's toolchain and [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
setup, then keeps that setup current with live upstream guidance.

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

1. Install [Node 24+](https://nodejs.org/) and [pnpm](https://pnpm.io/installation)
   (see ["Requirements"](#requirements) below for exact versions).
2. Run `npx @monte3l/groundwork@rc my-app` to bootstrap a new project
   named `my-app`.
3. `cd my-app`.
4. Open the `my-app` folder in Claude Code.
5. Run `/customize` -- it interviews you and tailors the baseline to your
   project.

> **Why `@rc`?** `@monte3l/groundwork` is currently a `1.0.0` release
> candidate, shipped on the [`rc` dist-tag](docs/glossary.md#dist-tag) --
> name it explicitly, as the Quickstart above does. Drop `@rc` once a
> stable `1.0.0` release exists. If you installed an earlier `0.x` release
> from the `next` tag, switch explicitly: a prerelease version range never
> crosses from `0.1.0-next.N` to `1.0.0-rc.N` on its own. See
> ["Versioning policy"](#versioning-policy) below for what counts as the
> CLI's public API, frozen as of the first RC.

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
override it.

| Mode      | When                                    | What it does                                                                                                 |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Fresh** | The target is empty or missing          | Writes the full baseline, runs `git init`, installs any `--pack`, then `pnpm install`.                       |
| **Adopt** | The target already looks like a project | Surveys it read-only and writes `.groundwork/` (an inventory and a report). It never touches a project file. |

Adopt mode also drops a guarded, purely additive copy of the `/customize`
skill, which is where the real work happens: it reads the survey, confirms
each change with you, and only then edits your project.

## Packs

A [pack](docs/glossary.md#pack) is an optional bundle of extra files -- an
agent, a hook, a gate -- installed on top of the baseline for projects that
want more than the capped default. A pack never edits YAML or JavaScript;
it only adds files and extends three JSON files the baseline already
reads. See [`templates/packs/README.md`](templates/packs/README.md) for
the wiring contract.

| Pack             | Contents                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-extras` | A type-design-analyzer agent, the compaction-handoff hook pair, a read-only Bash guard, and a per-file size ratchet gate.                                                   |
| `statusline`     | A five-row Claude Code status line plus a per-subagent row renderer, width-fit to the terminal.                                                                             |
| `claude-action`  | Anthropic's official Claude Code GitHub Action, wired for `@claude` mention-mode only -- one workflow file, no hooks, no gate. Needs an auth secret the pack cannot create. |

In fresh mode `--pack` installs a pack directly. In adopt mode the CLI only
surveys which packs apply and stages them under `.groundwork/packs/`;
`/customize` installs from there after you confirm.

## Flags

| Flag                    | Effect                                                                        |
| ----------------------- | ----------------------------------------------------------------------------- |
| `--name <project-name>` | Override the project name (default: the target directory's basename).         |
| `--skip-install`        | Skip the final `pnpm install` (fresh mode only).                              |
| `--force`               | Overwrite a non-empty target directory (fresh mode only).                     |
| `--adopt`               | Force adopt mode, even if the target looks empty.                             |
| `--fresh`               | Force fresh mode, even if the target looks like an existing project.          |
| `--pack <name>`         | Install an opt-in pack from `templates/packs/` (fresh mode only; repeatable). |
| `--list-packs`          | Print every available pack and exit.                                          |
| `--help`, `--version`   | Print usage, or the CLI's version.                                            |

## Requirements

- **Node 24+**. `.node-version` is the authority.
- **pnpm**. Fresh mode ends with a `pnpm install` in the new project (skip it
  with `--skip-install`), and this repo pins 12.4.0 through `packageManager`.
- **git**.
- **Claude Code**, for Phase B only. The CLI itself does not need it.

## Install and run

The Quickstart above covers the common case. Two other ways to run this
project:

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

```
/plugin marketplace add monte3l/m3l-groundwork
/plugin install m3l-groundwork-customize@monte3l
```

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
└── docs/research/         # living trackers for the guidance sweeps
```

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

- **Fresh project:** a short interview (project kind, runtime target, test
  strictness, CI depth) tailors the baseline, then a guidance sweep checks the
  result against current upstream sources.
- **Adopted project:** Step 0 reconciles the survey against the real repo and
  confirms each change before anything is written, then the same guidance
  sweep runs.

## Working on this repo

`pnpm verify` runs every gate. The pre-push hook and CI run the same five
groups by name, so anything `pnpm verify` catches, CI catches too. CI adds
one job on top, `pnpm test:e2e`, which is the real acceptance test: it
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

## Versioning policy

`@monte3l/groundwork` follows [Semantic Versioning](https://semver.org/).
Until 1.0.0, breaking changes ship in a `minor` release, as SemVer allows
for major version zero -- see the changesets in this repo's history for
examples. From 1.0.0, the public API is:

1. **CLI flags, modes, and exit codes** -- `--help` lists every flag; exit
   `0` is success, `1` is a runtime failure, `2` is a bad invocation
   (unrecognized flag, missing value, contradictory mode flags).
2. **`.groundwork/inventory.json`** -- a `schemaVersion` bump that
   `/customize` can't read is a breaking change.
3. **`.groundwork/adoption-report.md`'s section headings.**
4. **`.groundwork/packs/` staging layout**, and pack names.
5. **The `engines.node` floor** -- narrowing it is breaking; widening it
   isn't.
6. **`/customize`'s invocation name**, and the promise that it reads every
   inventory `schemaVersion` the CLI has ever emitted since 1.0.

**Not covered by this policy:** the _contents_ of the baseline the CLI
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
