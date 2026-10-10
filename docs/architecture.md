# Architecture

A high-level map of how m3l-groundwork is put together, for anyone reading
the project rather than editing it. [`CLAUDE.md`](../CLAUDE.md) is the
detailed, agent-facing reference this document distills from -- follow its
links for anything not covered here.

**In plain terms:** this repository builds two things that work together.
Phase A is a small, offline command-line tool that writes (or reports on)
a project's TypeScript setup and Claude Code configuration. Phase B is a
Claude Code skill, `/customize`, that a person runs afterward inside their
own project to tailor what Phase A wrote and check it against current
upstream advice. The two stay separate on purpose: one has to be
predictable every time it runs, the other has to be free to go look things
up. The sections below walk through each phase's internals in more detail.

## The two-phase split

```
                 ┌─────────────────────────────────────────────────┐
                 │  Phase A -- packages/cli  (deterministic, offline) │
                 └─────────────────────────────────────────────────┘
  target dir ──▶  mode.ts (auto-detect)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   FRESH mode               ADOPT mode
   (empty/missing dir)      (existing project dir)
        │                       │
   emit.ts writes           survey/*.ts reads the
   templates/core/          project READ-ONLY, never
   + any --pack             writes it
        │                       │
   git init, pnpm            conflicts.ts diffs the
   install                   baseline against reality
        │                       │
        ▼                       ▼
   a working project      .groundwork/inventory.json
   with the harness        + adoption-report.md
   already installed        + inert .staged copies of baseline
                              additions + staged packs
                            + guarded /customize copy

                 ┌─────────────────────────────────────────────────┐
                 │  Phase B -- packages/plugin  (adaptive, in Claude)│
                 └─────────────────────────────────────────────────┘
   /customize skill, run inside the bootstrapped or adopted project:
     - fresh: interviews the owner, tailors the baseline deterministically
     - adopted: Step 0 reconciles the survey against the real repo first
     - either way: a live guidance sweep over current TypeScript and
       Anthropic sources (typescript-guidance / harness-guidance skills)
```

The split exists because determinism and freshness can't live in one
artifact. Phase A has to be reproducible: same input, same output, no
network call beyond the final install, no LLM in the loop. Phase B has to
go and look at what TypeScript and Anthropic currently recommend, which by
definition can't be baked into a deterministic CLI shipped on some past
date.

## Phase A internals

- **`mode.ts`** decides fresh vs. adopt from the target directory's
  contents; `--fresh`/`--adopt` override it.
- **`emit.ts`** walks a template tree and writes it into the target,
  applying `tokens.ts`'s plain `__KEY__` string substitution -- not a
  templating engine, deliberately (see [`CLAUDE.md`](../CLAUDE.md)).
- `survey/*.ts` (adopt mode) is an index, not an interpretation: each
  collector records verifiable facts (which files exist, their content,
  which keys are set) and never infers a verdict. Anything a collector
  can't parse goes into `ProjectSurvey.undetermined` rather than being
  silently dropped.
- **The harness and toolchain graders** (`src/harness/`, `src/toolchain/`)
  each have two implementations that must stay identical: the TypeScript
  version that feeds the adoption report, and an emitted ESM **twin** --
  a second, separately maintained copy, not a shared library -- that every
  bootstrapped project runs as its own `pnpm verify` step. A
  [parity test](glossary.md#parity-test) runs both against the same
  fixtures and fails if they disagree.
- **`packs.ts`** loads and installs optional bundles from
  `templates/packs/`. A pack only ever adds files and extends three JSON
  files the baseline already reads (`merge-json.ts`) -- never YAML, never
  JavaScript. Fresh mode installs a requested pack directly; adopt mode
  only surveys and stages it under `.groundwork/packs/` for `/customize` to
  install after confirmation. Every staged pack file, and each `pack.json`,
  carries a `.staged` suffix (so no project tool discovers it), and all packs
  are staged together into a temp sibling directory and swapped in by rename (never half-written)
  (`pack-stage.ts`, built on the swap/sweep helpers in `staging.ts` that
  `baseline-stage.ts` shares). `inventory.stagedPacks` records each file's
  original path and `sha256`.
- **`assets.ts`** is the one place that locates `templates/` and the plugin
  payload, whether running from the source checkout or a published npm
  tarball -- see its own header comment for why the probe order matters.

## Phase B internals

`packages/plugin/skills/customize/SKILL.md` drives the interview (fresh) or
reconciliation (adopted), then hands off to two guidance skills that each
have full authority over their entire domain (`typescript-guidance`,
`harness-guidance`), not just the facets an interview answer happened to
emphasize. `packages/plugin/src/domain-map.ts` is the structural guarantee
that every file `templates/core/` ships is claimed by exactly one of those
two domains or an explicit **neutral allowlist** -- a list of files (such
as this one) that belong to neither guidance skill's domain and so need no
sweep -- checked by a test that walks the real template tree on every run.

## Single source of truth for gates

`bin/lib/verify-steps.mjs` is what `pnpm verify`, `lefthook`'s `pre-push`,
and every CI lane job read, keyed by group (`format`/`lint`/`typecheck`/
`build`/`test`) rather than by individual step. The emitted baseline
(`templates/core/bin/lib/verify-steps.mjs`) has the identical shape, plus
`CORE_STEPS` (the array of extra gates only the baseline itself needs, on
top of what every bootstrapped project gets) and pack-contributed steps.
Neither YAML file (`ci.yml`, `lefthook.yml`) ever names an individual step
id -- that's what lets a new gate join every lane at once without touching
either file, and it's also what a structural check (`gate-lane-parity`,
part of the toolchain grader, which scrapes both YAML files as text and
fails if either names a step directly or matrices the lanes) verifies.

## Design system

This repo's own root -- not `templates/core`, which stays brand-neutral for
whatever project adopts it -- uses **m3l-design**, vendored under
`design/`. `design/source/` is a verbatim copy of that design system's DTCG
2025.10 tokens, component CSS and brand book (see
[`design/README.md`](../design/README.md) for provenance); `design/tokens.css`
and `packages/cli/src/palette.ts` are generated from it by
`bin/build-design-tokens.mjs`, checked for drift by `pnpm verify`'s
`design-tokens` step. The governance model is copy-based, the same
philosophy as Phase A itself: a design system is copied into a project once
rather than imported live, so it can diverge deliberately without that
being a "drift bug."

The CLI's own terminal output (`packages/cli/src/term.ts`) and this repo's
root tooling (`bin/lib/term.mjs`) paint console output in the same palette --
color only on a real TTY, honoring `NO_COLOR`/`FORCE_COLOR`, truecolor or the
nearest ANSI-16 color depending on `COLORTERM`. Piped output stays plain
text either way.

This repo's own docs site (published to
[`https://groundwork.monte3l.com`](https://groundwork.monte3l.com) by
`.github/workflows/docs.yml`, on Cloudflare Workers Static Assets -- see
[`docs/cloudflare-docs.md`](cloudflare-docs.md)) is built by a small,
restricted, zero-dependency markdown-to-HTML renderer
(`bin/lib/markdown.mjs`) and site builder (`bin/build-docs.mjs`), styled
with the same generated `design/tokens.css` plus the vendored component CSS
and one repo-specific addition, `design/local/site.css`, for the page-shell
layout no single vendored component covers. `bin/build-docs.mjs --check`
builds to a throwaway directory and fails, without writing the site, on any
of the following:

- an internal link whose target path does not exist in the repository, or
  escapes it
- a broken same-page anchor, or a cross-page anchor with no matching heading,
  including an anchor into a non-page repo file such as
  `CLAUDE.md#some-heading` (an anchor into a non-markdown file cannot be
  verified, so it fails too)
- a link scheme other than `http:`, `https:` or `mailto:`
- an italic `_x_` or `*x*` emphasis span in any page source (use bold)
- markdown outside the renderer's supported subset, which it throws on
  rather than guessing at
- a generated `_headers` file (`bin/lib/site-headers.mjs`) that exceeds
  Cloudflare's limits of 100 rule blocks or 2,000 characters on any line

See [`CLAUDE.md`](../CLAUDE.md#architecture-notes) for the full renderer
contract.

## Inventory schema

Adopt mode writes `.groundwork/inventory.json`, the machine-readable handoff
`/customize`'s Step 0 reads. The current `schemaVersion` is **6**
(`INVENTORY_SCHEMA_VERSION` in `packages/cli/src/inventory.ts`). The survey is
an index, not an interpretation: it records facts the CLI can establish
offline and never a verdict. Anything it could not parse goes into
`survey.undetermined`. `/customize` tolerates an older inventory: below 3 there
is no harness grade, below 4 no toolchain grade, below 5 no `stagedBaseline`,
and below 6 no `survey.harness.pluginLayout`. The file is written atomically,
so its presence means the run completed.

### Top level

| Field                  | Type   | Meaning                                                                            |
| ---------------------- | ------ | ---------------------------------------------------------------------------------- |
| `schemaVersion`        | number | The schema version, currently 6.                                                   |
| `cliVersion`           | string | The CLI's own `package.json` version, or `"unknown"` when it cannot be read.       |
| `generatedAt`          | string | ISO 8601 timestamp of when the inventory was built.                                |
| `modeSignal`           | string | The fact that selected the mode, such as `found package.json` or `--adopt forced`. |
| `templateRoot`         | string | Absolute path of the template tree, in the platform's native form.                 |
| `targetDir`            | string | Absolute path of the adopted project, in the platform's native form.               |
| `survey`               | object | The project survey, described below. Its paths are native, not normalized.         |
| `conflicts`            | array  | Baseline-versus-project file collisions, one entry per baseline file.              |
| `packs`                | array  | One survey per pack, described below.                                              |
| `harnessGrade`         | object | Wiring integrity and rubric quality of the existing harness.                       |
| `harnessConformance`   | object | How far the harness has drifted from the baseline's.                               |
| `toolchainGrade`       | object | Wiring integrity and rubric quality of the TypeScript toolchain.                   |
| `toolchainConformance` | object | How far the toolchain files have drifted from the baseline's.                      |
| `stagedBaseline`       | object | The absent baseline files, staged as inert copies.                                 |
| `stagedPacks`          | array  | Every pack, staged as inert copies.                                                |

Every `relPath` in `conflicts` and `packs[].fileConflicts`, and every path in
`stagedBaseline` and `stagedPacks`, uses `/` on every platform.

### Conflicts, grades and staging

| Field                                        | Type     | Meaning                                                                                                            |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `conflicts[].relPath`                        | string   | The baseline file's path relative to the project root.                                                             |
| `conflicts[].status`                         | string   | `absent`, `identical` or `divergent`.                                                                              |
| `conflicts[].keyDiffs`                       | string[] | For `package.json` and `tsconfig*.json` only, the top-level keys that differ.                                      |
| `harnessGrade`, `toolchainGrade`             | object   | `findings`, `structural` and `rubric` tallies, and `rubricScore` (1 minus failed over checked).                    |
| `harnessConformance`, `toolchainConformance` | object   | `identical`, `divergent` and `absent` counts plus `divergentFiles` and `absentFiles`. Information, never a defect. |
| `stagedBaseline.dir`                         | string   | Project-relative staging directory, `.groundwork/baseline`.                                                        |
| `stagedBaseline.suffix`                      | string   | The suffix every staged file carries, `.staged`.                                                                   |
| `stagedBaseline.files[]`                     | array    | Each file's `path` (install path), `staged` (name inside `dir`) and `sha256` of the staged bytes.                  |
| `stagedPacks[].name`, `dir`, `suffix`        | string   | A pack's manifest name, its staging directory `.groundwork/packs/<name>`, and `.staged`.                           |
| `stagedPacks[].manifest`, `files[]`          | object   | The staged `pack.json` and the pack's `files/` tree, each as `path`, `staged` and `sha256`.                        |

### Survey

| Field                 | Type     | Meaning                                                                                     |
| --------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `survey.shape`        | object   | Codebase-shape facts, listed below.                                                         |
| `survey.toolchain`    | object   | Toolchain enforcement in effect, listed below.                                              |
| `survey.harness`      | object   | The existing Claude Code harness, listed below.                                             |
| `survey.docs.files[]` | array    | Indexed human-facing docs: `path`, `sizeBytes` and the level 1-3 `headings`, never content. |
| `survey.undetermined` | string[] | Things the survey tried and could not parse or classify.                                    |

| Field                      | Type                | Meaning                                                                                         |
| -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `shape.packageManager`     | string              | `npm`, `pnpm`, `yarn`, `bun` or `unknown`, from the lockfile.                                   |
| `shape.monorepoTool`       | string              | `pnpm-workspaces`, `turbo`, `nx`, `lerna`, `npm-workspaces` or `none`.                          |
| `shape.workspaceGlobs`     | string[]            | Workspace package globs the monorepo tool declares.                                             |
| `shape.moduleType`         | string              | `module`, `commonjs` or `unspecified`.                                                          |
| `shape.typescriptVersion`  | string or undefined | The `typescript` version range, verbatim.                                                       |
| `shape.nodeVersionPin`     | object or undefined | The first Node pin found: `source` and verbatim `value`.                                        |
| `shape.sourceLayout`       | string              | `src`, `lib`, `root` or `unknown`.                                                              |
| `shape.testPlacement`      | string              | `tests-dir`, `colocated` or `unknown`.                                                          |
| `shape.kindEvidence`       | object              | `hasExportsMap`, `hasBinField`, `hasMainField` and `frameworkDeps`.                             |
| `toolchain.tsconfig`       | object              | `files` (the extends chain, child first), `effectiveFlags` and `parsed`.                        |
| `toolchain.eslint`         | object              | `configFile`, `flat` and `referencedPlugins`, scraped from source text.                         |
| `toolchain.testRunner`     | object              | `tool` (`vitest`, `jest`, `mocha`, `node-test` or `unknown`) and `configFile`.                  |
| `toolchain.formatter`      | object              | `tool` (`prettier`, `biome` or `unknown`) and `configFile`.                                     |
| `toolchain.gitHooks`       | object              | `manager` (`lefthook`, `husky`, `simple-git-hooks` or `none`), `configFile` and `needsReading`. |
| `toolchain.workflows`      | object              | CI workflow `files` and `needsReading`.                                                         |
| `toolchain.scripts`        | object              | `package.json` scripts, name to command, verbatim.                                              |
| `harness.present`          | boolean             | Whether a `.claude/` directory exists.                                                          |
| `harness.settingsFile`     | string or undefined | `settings.json` when present.                                                                   |
| `harness.agents[]`         | array               | Each agent's `name` and frontmatter `model`.                                                    |
| `harness.skills[]`         | array               | Each skill's `name` and `description`.                                                          |
| `harness.hooks`            | string[]            | Hook script file names under `.claude/hooks/`.                                                  |
| `harness.rules[]`          | array               | Each rule's `name` and `paths` scope text.                                                      |
| `harness.commands`         | string[]            | Command file names under `.claude/commands/`.                                                   |
| `harness.hasSettingsLocal` | boolean             | Whether `.claude/settings.local.json` exists.                                                   |
| `harness.hasClaudeMd`      | boolean             | Whether a root `CLAUDE.md` exists.                                                              |
| `harness.claudeMdHeadings` | string[]            | `CLAUDE.md`'s level 1-3 headings in order.                                                      |
| `harness.pluginLayout`     | object or null      | `null` unless `.claude-plugin/plugin.json` is a regular file; then `manifest` and `components`. |

Fields typed "or undefined" are omitted from the JSON when unset, since
`JSON.stringify` drops them.

### Packs

Each `packs[]` entry is one pack's survey. Adopt mode records the wiring and
never applies it.

| Field                | Type                | Meaning                                                                                                            |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `name`               | string              | The pack's name, matching its directory.                                                                           |
| `modes`              | string[]            | The CLI modes the pack supports, one or both of `fresh` and `adopt`.                                               |
| `budget`             | object              | The cap delta: `agents`, `skills`, `hooks`, `workflows` and `scripts`.                                             |
| `fileConflicts[]`    | array               | Collisions of the pack's `files/` tree with the target, shaped like `conflicts`.                                   |
| `wiring`             | object              | The pack's declared wiring, verbatim: `settings`, optional `settingsTopLevel`, `packageScripts` and `verifySteps`. |
| `wiringObservations` | string[]            | Index-level facts about how the wiring would land, never a verdict.                                                |
| `adoptNotes`         | string or undefined | The pack's notes for `/customize`.                                                                                 |

## pack.json

Each `templates/packs/<name>/pack.json` is validated by `loadPack` before any
pack is installed or staged. A pack that fails validation is neither.

| Field           | Type     | Rule                                                                                                                                                                                                                                                       |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | number   | Must be 1.                                                                                                                                                                                                                                                 |
| `name`          | string   | A bare lowercase identifier matching `^[a-z][a-z0-9-]*$`, and equal to the pack's directory name.                                                                                                                                                          |
| `description`   | string   | What the pack ships. Declared by the manifest type, not validated beyond that.                                                                                                                                                                             |
| `modes`         | string[] | Non-empty, each `fresh` or `adopt`.                                                                                                                                                                                                                        |
| `budget`        | object   | Non-negative integers for `agents`, `skills`, `hooks`, `workflows` and `scripts`.                                                                                                                                                                          |
| `requires`      | object   | Optional. `paths` lists files the baseline must already provide.                                                                                                                                                                                           |
| `wiring`        | object   | Required. `settings` and `packageScripts` must be objects, `verifySteps` an array of `id`, `name`, `group` (`format`, `lint`, `typecheck`, `build` or `test`) and a non-empty `cmd`. `settingsTopLevel` is optional. Prototype-sensitive keys are refused. |
| `adoptNotes`    | string   | Optional guidance for `/customize` in adopt mode.                                                                                                                                                                                                          |
| `setupSteps`    | string[] | Optional. Non-empty single-line shell commands a fresh install needs before its first `pnpm verify`.                                                                                                                                                       |

## Trust boundaries and threat model

See [`docs/assurance-case.md`](assurance-case.md) for the security-focused
view of this same architecture: what's trusted, what's untrusted input, and
how each boundary is enforced.

## GitHub setup

See [`docs/github-blueprint.md`](github-blueprint.md) for how this repository
is configured on GitHub's side (rulesets, environments, Actions policy,
security features), what a template repository cannot carry over, and the
checklist for reproducing the setup in a new repository.
