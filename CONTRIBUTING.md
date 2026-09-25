# Contributing

This is a single-maintainer project. External contributions are welcome as
issues and pull requests; read [`CLAUDE.md`](CLAUDE.md) first, it's the
canonical reference for architecture, conventions, and the agent operating
model this repo builds against.

## Setup

```bash
git clone https://github.com/monte3l/m3l-groundwork.git
cd m3l-groundwork
pnpm install
pnpm prepare   # installs lefthook git hooks
```

Node version comes from `.node-version` (`check:node-version` gates any
drift). pnpm is pinned via `packageManager` in `package.json`.

## Before opening a PR

Run `pnpm verify` -- it's the same aggregator `lefthook`'s `pre-push` hook
and every CI lane run, keyed by group (`format`/`lint`/`typecheck`/`build`/
`test`). If your change touches `packages/cli/src/`, `templates/core/`, or
`packages/plugin/skills/customize/`, also run `pnpm test:e2e` -- it's the
real acceptance test and has caught real bugs unit tests missed (see
[`CLAUDE.md`](CLAUDE.md#testing)).

- **Conventional Commits**, enforced by the `commit-msg` hook. This is the
  same convention `templates/core` emits into every bootstrapped project.
- **Signed commits** -- `main`'s branch ruleset requires them. Configure a
  GPG key before your first commit here.
- **A changeset** (`pnpm changeset`) for any user-visible change to
  `@monte3l/groundwork` (the CLI). The plugin never takes one -- it has no
  release of its own; see [`CLAUDE.md`](CLAUDE.md#releases).
- **Add a `Co-Authored-By:` trailer** if an AI assistant substantially
  helped write the commit.

## Workflow

Every change lands through a pull request -- nobody, maintainer included,
can push directly to `main` (see [`CLAUDE.md`](CLAUDE.md#git-workflow)).
Branch off `main`, keep the PR focused, and make sure CI's `verify`
aggregator, Dependency Review, and CodeQL are all green before asking for a
merge.

## Scope of a PR

- A change to `packages/cli/src/` or `packages/plugin/src/` needs tests
  (see `CLAUDE.md`'s "Testing" and coverage-gate notes).
- A change to `templates/core/` is a change to what every future
  bootstrapped project gets -- it needs `pnpm test:e2e` and must keep the
  baseline's caps (`pnpm check:harness`, `pnpm check:toolchain`) green.
- A new file under `templates/core/` must be claimed by
  `packages/plugin/src/domain-map.ts`'s glob lists, or
  `domain-map.test.ts` fails on purpose.

## Reporting a security issue

Don't open a public issue -- see [`SECURITY.md`](SECURITY.md).
