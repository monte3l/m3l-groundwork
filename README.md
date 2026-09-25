# m3l-groundwork

[![CI](https://github.com/monte3l/m3l-groundwork/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/monte3l/m3l-groundwork/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/monte3l/m3l-groundwork/badge)](https://securityscorecards.dev/viewer/?uri=github.com/monte3l/m3l-groundwork)

Deterministic TypeScript + Claude Code project bootstrapper, with an
adaptive `/customize` pass over live TypeScript and Anthropic guidance.

## What it is

A two-phase bootstrapper. Point it at a directory and it leaves you with a
strict TypeScript toolchain, a Claude Code harness, and CI wired to the same
gates you run locally.

**Phase A** (`packages/cli`) is deterministic: an offline Node CLI with no
runtime dependencies that writes the baseline. It makes no network call
beyond the final package install, and the same input always produces the
same output.

**Phase B** (`packages/plugin`) is adaptive: the `/customize` skill, which
interviews you (or, for an existing project, reconciles the CLI's survey
against the real repo) and then sweeps current official TypeScript and
Anthropic sources, so the result reflects upstream guidance today rather
than whenever this repo last shipped.

They are separate phases because determinism and freshness cannot live in one
artifact: the first has to be reproducible, the second has to go and look.

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

## Requirements

- **Node 24+**. `.node-version` is the authority.
- **pnpm**. Fresh mode ends with a `pnpm install` in the new project (skip it
  with `--skip-install`), and this repo pins 12.4.0 through `packageManager`.
- **git**.
- **Claude Code**, for Phase B only. The CLI itself does not need it.

## Install and run

The CLI is published to npm as [`@monte3l/groundwork`](https://www.npmjs.com/package/@monte3l/groundwork).
It is currently a `1.0.0` release candidate: releases ship on the `rc`
dist-tag, so name the tag explicitly. See
["Versioning policy"](#versioning-policy) below for what counts as the
CLI's public API -- frozen as of the first RC -- and drop `@rc` once a
stable `1.0.0` release exists. If you installed an earlier `0.x` release
from the `next` tag, switch explicitly: prerelease version ranges don't
cross from `0.1.0-next.N` to `1.0.0-rc.N` on their own.

```bash
# a new project
npx @monte3l/groundwork@rc my-new-project

# a new project with an optional pack
npx @monte3l/groundwork@rc my-new-project --pack statusline

# an existing project (adopt mode is auto-detected)
npx @monte3l/groundwork@rc ../existing-project
```

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

`pnpm verify` runs the same five groups (`format`, `lint`, `typecheck`,
`build`, `test`) that the pre-push hook and CI run, all read from one list in
`bin/lib/verify-steps.mjs`. The baseline is also graded by two offline
checks, one for the harness and one for the toolchain, that run as part of
`pnpm verify`.

The baseline is deliberately capped: at most 5 agents, 8 skills, 10 hooks,
3 CI workflows and 12 root scripts. Anything useful beyond that ships as a
pack instead.

## Packs

Optional bundles installed on top of the baseline. A pack never edits YAML
or JavaScript; it only adds files and extends three JSON files the baseline
already reads. See [`templates/packs/README.md`](templates/packs/README.md)
for the wiring contract.

| Pack             | Contents                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `harness-extras` | A type-design-analyzer agent, the compaction-handoff hook pair, a read-only Bash guard, and a per-file size ratchet gate. |
| `statusline`     | A five-row Claude Code status line plus a per-subagent row renderer, width-fit to the terminal.                           |

In fresh mode `--pack` installs a pack directly. In adopt mode the CLI only
surveys which packs apply and stages them under `.groundwork/packs/`;
`/customize` installs from there after you confirm.

## Then run /customize

The skill lands at `.claude/skills/customize/` in the target project. Open it
in Claude Code and run `/customize`.

- **Fresh project:** a short interview (project kind, runtime target, test
  strictness, CI depth) tailors the baseline, then a guidance pass checks the
  result against current upstream sources.
- **Adopted project:** Step 0 reconciles the survey against the real repo and
  confirms each change before anything is written, then the same guidance
  pass runs.

## Working on this repo

`pnpm verify` runs every gate. The pre-push hook and CI run the same five
groups by name, so anything `pnpm verify` catches, CI catches too. CI adds
one job on top, `pnpm test:e2e`, which is the real acceptance test: it
bootstraps throwaway projects with the built CLI and runs their own
`pnpm verify`. It is slow and touches the network, so it is not part of
`pnpm verify`; run it yourself after any change to `packages/cli/src/`,
`templates/core/` or the `/customize` skill. `pnpm eval` makes paid model
calls and never runs in CI.

### Releasing

`@monte3l/groundwork` is released with [Changesets](https://github.com/changesets/changesets)
and published to npm through trusted publishing (no stored token). A PR that
changes the CLI's user-visible behavior adds a changeset with `pnpm changeset`.
Merging to `main` opens a "Version Packages" PR; merging that runs the full
gate, stages the package with provenance, and creates a git tag and a GitHub
Release -- a maintainer still has to approve the staged version (2FA) before
it's actually installable, npm's own recommended flow for trusted publishers.
`@monte3l/groundwork-plugin` is never published to npm -- it ships only
through the marketplace above, so a change to it is live the moment it lands
on `main`; its `plugin.json` version just tracks the CLI's, for display. The
design, and the one-time setup it depends on, are in
[`CLAUDE.md`](CLAUDE.md#releases).

[`CLAUDE.md`](CLAUDE.md) is the full reference: architecture, the command
table, conventions, and known gaps.

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
`/customize`'s live guidance pass. Also not covered: internal modules
(anything under `packages/*/src/` not listed above) and the exact prose of
`adoption-report.md`'s body.

**Deprecation:** anything on this list gets at least one minor release with
a visible warning before it's removed in a major release.

## License

[MIT](LICENSE). The license covers the bootstrapper itself, not what it
writes: the code the CLI emits into your project is yours to use and
relicense as you see fit.
