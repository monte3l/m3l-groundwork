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
- **A DCO sign-off trailer** on every commit -- `git commit -s`, or add
  `Signed-off-by: Your Name <you@example.com>` yourself. The `commit-msg`
  hook rejects a commit without one; see "Developer Certificate of Origin"
  below.
- **A changeset** (`pnpm changeset`) for any user-visible change to
  `@monte3l/groundwork` (the CLI). The plugin never takes one -- it has no
  release of its own; see [`CLAUDE.md`](CLAUDE.md#releases).
- **Add a `Co-Authored-By:` trailer** if an AI assistant substantially
  helped write the commit.

## Developer Certificate of Origin

By signing off a commit (`git commit -s`), you certify the
[Developer Certificate of Origin](https://developercertificate.org/): that
you wrote the change, or otherwise have the right to submit it under this
project's license. This is enforced locally by `commitlint.config.js`'s
`trailer-exists` rule; it isn't re-checked on a squash merge or the release
bot's own commits, which is why the PR checklist below also asks for it.

## Coding standards

- **TypeScript**: `strict` plus the extra flags in `tsconfig.base.json`
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, and others -- see the file's own comments).
- **ESLint**: `eslint.config.js`'s flat config, built on
  `typescript-eslint`'s `recommendedTypeChecked` plus this repo's own rules
  (no `any`, no floating promises, exhaustive `switch`, `.js` extensions on
  relative imports, named exports only). `pnpm lint` runs with
  `--max-warnings 0` -- a warning fails the gate the same as an error.
- **Prettier**, for everything, including Markdown and JSON.
- **Conventional Commits** for every commit message (see above).

All four are enforced by `pnpm verify`, the pre-commit/pre-push hooks, and
CI -- there's no separate style review, the tooling is the standard.

## Workflow

Every change lands through a pull request -- nobody, maintainer included,
can push directly to `main` (see [`CLAUDE.md`](CLAUDE.md#git-workflow)).
Branch off `main`, keep the PR focused, and make sure CI's `verify`
aggregator, Dependency Review, and CodeQL are all green before asking for a
merge.

## Scope of a PR

- **New functionality MUST come with tests.** A change to
  `packages/cli/src/` or `packages/plugin/src/` that adds behavior needs
  tests covering it (see `CLAUDE.md`'s "Testing" and coverage-gate notes).
- **A bug fix MUST add a regression test** that fails against the old code
  and passes against the fix -- not just a fix with no test proving the bug
  is gone.
- A change to `templates/core/` is a change to what every future
  bootstrapped project gets -- it needs `pnpm test:e2e` and must keep the
  baseline's caps (`pnpm check:harness`, `pnpm check:toolchain`) green.
- A new file under `templates/core/` must be claimed by
  `packages/plugin/src/domain-map.ts`'s glob lists, or
  `domain-map.test.ts` fails on purpose.

## Project docs

- [`GOVERNANCE.md`](GOVERNANCE.md) -- how decisions are made and who holds
  which role.
- [`ROADMAP.md`](ROADMAP.md) -- what's planned, and what's explicitly out
  of scope.
- [`docs/architecture.md`](docs/architecture.md) -- a high-level map of how
  the two phases fit together.
- [`docs/assurance-case.md`](docs/assurance-case.md) -- the threat model
  and security design argument.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Reporting a security issue

Don't open a public issue -- see [`SECURITY.md`](SECURITY.md).
