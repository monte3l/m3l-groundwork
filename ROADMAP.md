# Roadmap

What this project intends to do, and not do, over roughly the next year.
Kept in one file rather than GitHub Issues/Projects so it survives outside
any one tool -- see `documentation_roadmap` in the
[OpenSSF Best Practices badge](https://www.bestpractices.dev/) criteria.

## Now: GA

The public API has been frozen since the first `1.0.0-rc`
(see the README's ["Versioning policy"](README.md#versioning-policy)): only
`patch` [changesets](docs/glossary.md#changeset) land for the rest of the
[`rc`](docs/glossary.md#rc) series, and any further API change waits for a
`1.1` release after GA (see [`CLAUDE.md`](CLAUDE.md#releases)'s "Releases"
section, which this paraphrases). Leaving the `rc` prerelease series for a
stable `1.0.0` is the immediate goal, once the promotion checklist in
[`CLAUDE.md`](CLAUDE.md#releases) is met.

## Next 12 months

- **A standalone "add a pack" mode.** Today, adding an optional pack to an
  already-bootstrapped project means re-running the CLI (auto-detected as
  adopt mode) and then `/customize`. A dedicated additive-install flag is
  real, planned work -- see [`CLAUDE.md`](CLAUDE.md#known-gaps-deliberately-out-of-scope-so-far).
- **Two more optional packs**, deferred from the original build for cap
  reasons rather than a generalization failure (see
  [`CLAUDE.md`](CLAUDE.md#known-gaps-deliberately-out-of-scope-so-far)):
  - a `github-ops` pack -- GitHub-repository-maintenance skills
    (`reviewing-dependabot-prs`, `triaging-scan-alerts`), named for the kind
    of ongoing repo upkeep it covers rather than a release concern;
  - a `publishing` pack (a release workflow, `check-publish-version`,
    `check-dts-deps`) -- this repo's own `release.yml` is now a copyable
    reference for the registry/scope/`publishConfig` story that pack needs.
    `publishConfig` is the `package.json` field that overrides how `npm
publish` behaves for a given package (registry, access level, and so
    on); the baseline doesn't have one yet because it emits an application,
    not a published package.
- **Growing the bus factor past 1.** See [`GOVERNANCE.md`](GOVERNANCE.md#bus-factor).
  No committed timeline -- this depends on finding a second maintainer
  willing to take on release and security-response duties, not on writing
  code.
- **`pnpm/setup` in CI**, once it supports reading Node's version from
  `.node-version` (or an equivalent single-source-of-truth mechanism)
  rather than only `package.json`'s `devEngines.runtime` (a field that
  declares which JavaScript runtime and version a package expects,
  separate from `.node-version`) -- see
  [`CLAUDE.md`](CLAUDE.md#known-gaps-deliberately-out-of-scope-so-far).
- Keeping `templates/core` and `templates/packs/` current against upstream
  TypeScript and Anthropic guidance is ongoing, ordinary maintenance, not a
  one-time milestone -- see `docs/research/*.md` and the `typescript-guidance`
  / `harness-guidance` skills.

## What this project will not do

- **Add a runtime dependency to `packages/cli`** without a very strong
  reason (see [`CLAUDE.md`](CLAUDE.md#architecture-notes)). The CLI's zero-
  dependency, offline-except-for-`pnpm install` design is a hard constraint,
  not a style preference, and every roadmap item above is expected to
  respect it.
- **Add a templating engine.** Token substitution stays a plain, auditable
  string replace (`packages/cli/src/tokens.ts`) -- see `CLAUDE.md`'s
  "Architecture notes" and `tokens.ts`'s own header comment.
- **Publish `@monte3l/groundwork-plugin` to npm.** It ships only through the
  Claude Code marketplace; see the README's ["Releasing"](README.md#releasing)
  section for why.
- **Let adopt mode write project files directly.** Its contract --
  survey-only, `.groundwork/` plus a guarded copy of `/customize` -- is
  load-bearing and asserted by `adopt.e2e.test.ts`; every future adopt-mode
  feature (including the additive-pack-install mode above) extends that
  contract rather than weakening it.
- **Chase a generic npm-package-quality heuristic that doesn't fit a CLI**
  (a fake `types`/`exports["."]` entry, for example) -- see `SECURITY.md`'s
  note on the Socket score for the reasoning already applied once.
