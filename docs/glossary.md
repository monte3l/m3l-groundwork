# Glossary

Plain-English definitions of the terms this repository's docs use most.
Each entry is one sentence; an optional "In this repo:" line points at
where the concept actually lives. Link to a specific entry with
`docs/glossary.md#term` (for example, `docs/glossary.md#hub-and-spoke`).

One canonical term is used per concept throughout these docs: "guidance
sweep" (not "guidance pass"), "gate" for one check, "group" for one of the
five `pnpm verify` buckets, and "lane" for the CI job that runs a group.

### Adopt mode

The CLI mode used when it's pointed at a directory that already looks like
an existing project: it only reads the project and writes a report, never
edits a project file.
In this repo: `packages/cli/src/mode.ts`; see [`README.md`](../README.md#two-modes).

### Agent (spoke)

A separate Claude Code agent dispatched to do one bounded piece of work --
writing tests, implementing code, reviewing a diff -- with its own tools and
context, reporting back to whoever launched it.
In this repo: `.claude/agents/`; see [`CLAUDE.md`](../CLAUDE.md#agent-operating-model).

### Baseline

Short for `templates/core`: the exact set of files -- toolchain config, CI
workflows, Claude Code harness -- that a fresh bootstrap writes into a new
project.
In this repo: `templates/core/`.

### Cap

A hard upper limit on how many of something (agents, skills, hooks, CI
workflows, root `package.json` scripts) the baseline may ship, so it stays
small enough for a person to actually read.
In this repo: `packages/cli/src/caps.ts`.

### Changeset

A small file describing a user-visible change and its semver bump, added to
a pull request and later consumed to write the changelog and bump the
version.
In this repo: `.changeset/`; run with `pnpm changeset`.

### Claude Code

Anthropic's command-line coding agent: it runs Claude in your terminal or
editor, with tools to read files, edit them, and run commands on your
behalf.
See: [Claude Code documentation](https://docs.claude.com/en/docs/claude-code/overview).

### Claude Code plugin / marketplace

A plugin is a packaged bundle of skills and commands that Claude Code can
install; a marketplace is a registry (here, a relative-path entry in a
`marketplace.json` file) that Claude Code installs a plugin from.
In this repo: `.claude-plugin/marketplace.json`, `packages/plugin/`.

### /customize

The Claude Code skill this project ships as its adaptive phase: for a fresh
bootstrap it interviews you, for an adopted project it first reconciles a
survey against your real repo, and either way it then runs a live guidance
sweep.
In this repo: `packages/plugin/skills/customize/`.

### DCO

Short for Developer Certificate of Origin: a sign-off line
(`Signed-off-by: ...`, added automatically by `git commit -s`) that
certifies you wrote the change, or otherwise have the right to submit it
under the project's license.
See: [developercertificate.org](https://developercertificate.org/).

### dist-tag

An npm label (such as `latest`, `rc`, or `next`) that points at one
specific published version, so `npx package@tag` resolves to that version
without naming it explicitly.
In this repo: the CLI currently ships on the `rc` dist-tag.

### Fresh mode

The CLI mode used when the target directory is empty or missing: it writes
the full baseline, runs `git init`, installs any requested pack, and ends
with `pnpm install`.
In this repo: `packages/cli/src/mode.ts`.

### Gate

One individual check that can pass or fail -- for example, a single ESLint
run, or the harness grader -- as opposed to a whole verify group.
In this repo: `bin/lib/verify-steps.mjs`.

### Guidance sweep

A live pass, run by `/customize`, over current official TypeScript and
Anthropic sources, that checks a bootstrapped or adopted project against
upstream recommendations as they stand today rather than when this repo
last shipped.
In this repo: the `typescript-guidance` and `harness-guidance` skills.

### Harness

The Claude Code configuration installed into a project: its agents,
skills, hooks, rules, and `settings.json`.
In this repo: `templates/core/.claude/`.

### Hook

A script Claude Code runs automatically around a tool call or event --
for example, blocking a disallowed file write -- rather than something
Claude decides to run on its own.
In this repo: `templates/core/.claude/hooks/`.

### Hub-and-spoke

An operating model where one "hub" agent plans and delegates, and separate
"spoke" agents each do one bounded task and hand their results back, rather
than one agent doing everything itself.
In this repo: [`CLAUDE.md`](../CLAUDE.md#agent-operating-model).

### Inventory

The JSON file adopt mode writes recording what its survey found, plus the
harness and toolchain grades, so `/customize` can act on it later.
In this repo: `.groundwork/inventory.json`.

### OIDC

Short for OpenID Connect: a protocol that lets a GitHub Actions job prove
its identity to another service (such as npm) without a stored, long-lived
secret.
In this repo: used for npm trusted publishing in `release.yml`.

### Pack

An optional bundle of extra files -- an agent, a hook, a gate -- installed
on top of the baseline, for projects that want more than the capped
default.
In this repo: `templates/packs/`.

### Parity test

A test that runs two supposedly-identical implementations against the same
input and asserts they agree, so the two copies can never silently drift
apart.
In this repo: `tests/harness/harness-parity.test.ts`,
`tests/toolchain/toolchain-parity.test.ts`.

### Provenance

A cryptographically verifiable record of exactly which build -- which
workflow run, which commit -- produced a published artifact.
In this repo: npm provenance plus a Sigstore build-provenance attestation on
every release; see [`SECURITY.md`](../SECURITY.md#verifying-releases).

### rc

Short for release candidate: a prerelease version believed ready for a
stable release but not yet declared stable.
In this repo: the CLI's `1.0.0-rc.N` versions, shipped on the `rc`
dist-tag until GA.

### Rubric finding

A grader result that reflects a stylistic or best-practice judgment call
rather than an objective defect; it warns but never fails the gate.
In this repo: the harness and toolchain graders.

### Skill

A packaged set of instructions Claude Code can load for a particular task
-- for example, `/customize` or `typescript-guidance` -- invoked by name or
by a matching trigger.
In this repo: `templates/core/.claude/skills/`.

### Staged publish

An npm publish mode where a version is uploaded but held back, requiring a
separate, manually approved step (`npm stage approve`) before it becomes
installable.
In this repo: see [`CLAUDE.md`](../CLAUDE.md#releases), "Staged, not
direct."

### Structural finding

A grader result describing an objective defect -- a missing required file,
a broken reference -- as opposed to a rubric finding; it fails the gate.
In this repo: the harness and toolchain graders.

### Subagent

See [Agent (spoke)](#agent-spoke) above -- the two terms name the same
thing in this project's docs.

### Survey

Adopt mode's read-only pass over an existing project: it records
verifiable facts (which files exist, their content, which keys are set)
without judging what they mean.
In this repo: `packages/cli/src/survey/`.

### Trusted publishing

An npm feature that lets one specific CI workflow publish a package via
OIDC, with no npm token stored anywhere.
In this repo: `release.yml`'s `publish` job.

### Verify group

One of the five fixed buckets (`format`, `lint`, `typecheck`, `build`,
`test`) that `pnpm verify` runs, each made up of one or more gates.
In this repo: `bin/lib/verify-steps.mjs`.

### Verify lane

A CI job that runs exactly one verify group -- for example, the `lint`
lane runs `node bin/verify.mjs --group lint`.
In this repo: `.github/workflows/ci.yml`.
