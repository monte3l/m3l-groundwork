---
paths:
  - "packages/cli/**"
---

# CLI package rules (`packages/cli/**`)

> This file is the terse checklist that auto-loads when you edit the CLI,
> `@monte3l/groundwork`, the only package that ships to npm. It adds to
> `src.md` and `tests.md`; it does not repeat them.

- **`resolveAsset()` in `src/assets.ts` is the only place that locates
  `templates/` or the plugin payload.** Never write a `join(here, "..", ...)`
  walk to a sibling directory: in a published tarball it escapes the package.
- **A new walker over `templates/` restores escaped file names** via
  `restoreDotfilePath` (`_gitignore`, `_npmrc`, `_npmignore`,
  `_package-lock.json`), as `emit.ts`, `conflicts.ts` and `staging.ts` do. Skip it and a published install silently loses
  those files.
- **No new runtime dependency.** It is a hard constraint, not a style
  preference. Parse by hand, as `packages/cli/src/jsonc.ts` does.
- **The harness and toolchain graders have an emitted twin** in
  `templates/core/bin/lib/*-rules.mjs`. Change a rule in both in the same
  commit, or the parity tests under `tests/harness/` and `tests/toolchain/`
  fail.
- **Cap numbers live in `src/caps.ts` only.** `report.ts` and `main.ts` read
  them from there.
- **Adopt mode never writes a project file.** It writes under
  `.groundwork/` plus the guarded `/customize` copy. `adopt.e2e.test.ts` is
  the test of that guarantee: do not weaken it.
- **`--update` stages, it never applies.** It writes only under
  `.groundwork/update/`: every planned path passes `assertUpdateWriteScope`
  and `.groundwork` / `.groundwork/update` are `lstat`-refused before the first
  write, the directory is swapped in by rename with `plan.json` last, and a
  failed write leaves the previous copy exactly as it was. The text merge runs
  `git merge-file` on temporary files in the system temp directory, never in the
  project; a merge with conflicts is staged with markers and never applied.
  `/customize update` (`update.md`, listed in `CUSTOMIZE_SKILL_STEP_FILE_NAMES`)
  is what applies it, so any new file the skill reads from the staging
  directory must be in the plan's `staged.files` list with a hash, and a
  change to the plan's shape needs the same change in `update.md`.
  The plan must stay deterministic (only `generatedAt` varies), so nothing time-,
  order- or temp-dir-dependent may reach it.
- **`--check-update` reads and reports, it never writes.** It is the one mode
  whose exit code carries information: `0` up to date, `3` an update is
  available (`1` and `2` stay failure and bad invocation, so a CI step can tell
  "behind" from "broken"). `main()` returns the code and
  `bin/m3l-groundwork.mjs` sets `process.exitCode`; a new mode that wants its
  own code must be added to the README's exit-code section and the versioning
  policy. A base at or above the running version is "up to date" without a
  comparison, and a history that cannot be loaded is a plain error, never "up
  to date".
- **`--add-pack` stages, it never installs.** It writes only under
  `.groundwork/add-pack/<name>/`; every refusal is a `CliUsageError` raised
  before the first write. `CliUsageError` and `USAGE` live in `usage.ts` so
  `main.ts` can import `add-pack.ts` with no runtime cycle (`add-pack.ts`
  imports only the `CliOptions` type from `main.ts`). `/customize add-pack`
  is what installs, so every step file of the skill, `add-pack.md` and
  `pack-install.md` included, must be in `customize-paths.ts`'s
  `CUSTOMIZE_SKILL_STEP_FILE_NAMES`, or the CLI's copy of the skill ships
  without it.
- **`packages/cli/README.md` is generated from the root `README.md`.** Never
  hand-edit it: change the root README and run `node bin/build-npm-readme.mjs`
  (the `npm-readme` verify step fails on drift). Keep `package.json`'s
  `description`, `homepage` and `keywords` equal to the GitHub repo's.
- **Tests whose subject is a template file** belong in `tests/templates/`,
  not beside the tests of `src/` modules (see `tests.md`).

| Change                                         | Proof required                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Anything in `src/`                             | `pnpm verify`, then `pnpm test:e2e`                                                                                     |
| What the tarball ships, or how it locates data | `pack.e2e.test.ts`, never a run from the checkout                                                                       |
| A user-visible change                          | A `fix` commit for a fix or a change to existing behaviour, a `feat` for new public surface (a pack name, flag or mode) |

## Design record

> Moved verbatim from the root `CLAUDE.md` ("Architecture notes") so it loads only when you edit the files it governs.

- **Token substitution is a plain string replace, not a template engine**
  (`packages/cli/src/tokens.ts`). `applyTokens` swaps `__KEY__` literals in
  both file content and path segments.
- **Where `templates/` and the plugin payload live is decided in exactly one
  place: `resolveAsset()` in `packages/cli/src/assets.ts`.** Never write a
  `join(here, "..", "..", "..")` walk again -- in a published tarball that
  escapes the package. `templatesCoreDir()`, `packsRootDir()` and
  `pluginDir()` are one-liners over it. It probes the **source checkout first**
  (a positive marker: `pnpm-workspace.yaml` plus a `package.json` named
  `m3l-groundwork` three directories up) and only then the copy vendored
  beside `dist/`; the order is what stops a vendored copy left by a crashed
  `pnpm pack` from being read stale on a dev machine, and the marker is what
  stops an unscoped install from treating the consumer's own project root as
  ours. `scripts/vendor-assets.mjs` (`prepack`/`postpack`) does the copying.
- **`packages/cli/data/template-history.json` is generated, never hand-edited.**
  `node bin/build-template-history.mjs` rebuilds it from the local
  `@monte3l/groundwork@x.y.z` tags (fetch them first); `--check`, the
  `template-history` step in the `lint` group, validates the committed file and
  fails when a released version in `CHANGELOG.md` is missing. It records, per
  release, the sha256 of every template file and pack file, and keeps the text
  only of tokenized files, `pack.json`s and the JSON merge targets. It ships
  through `files` (`data`) and is located by `templateHistoryPath()` in
  `assets.ts`, the same way as `templates/`, so `pack.e2e.test.ts` proves it
  from the tarball. A pack's recorded manifest hash is compared in canonical
  form (`JSON.stringify(parsed, null, 2)` plus a newline), because the ledger
  hashes the bytes staging writes, not the raw `pack.json`.
- **npm-family tooling strips `.gitignore`, `.npmrc`, `.npmignore` and
  `package-lock.json` (at any depth) from a tarball whatever `files` says**
  (measured: `pnpm pack` keeps `.gitignore` but drops `.npmrc`; `npm pack`
  drops all three dotfiles; both drop the publishing pack's
  `tools/release/package-lock.json`). The vendored copy therefore stores them
  as `_gitignore`, `_npmrc`, `_npmignore`, `_package-lock.json`, and every
  walker over the template tree restores the real name via
  `restoreDotfilePath` (`emit.ts`, `conflicts.ts`, `staging.ts`). **A new walker over `templates/` must do the
  same**, or a published install silently loses those files. The name list and
  both directions of the mapping live in `assets.ts`; `vendor-assets.mjs`
  imports them from the build, so `pnpm build` must precede `pnpm pack`.
  `templates/core/package.json` is _not_ escaped -- `caps.ts` reads it
  directly -- so publint prints a known, harmless warning that its `exports`
  field is ignored.
- **The CLI has zero runtime dependencies it can avoid**, and makes no
  network call beyond the package install it runs at the end of fresh mode
  (`packages/cli/src/git.ts`'s `runInstall`; adopt mode makes none at all).
  If a change to `packages/cli` needs a new dependency, stop and
  reconsider -- this is a hard constraint, not a style preference. It's why
  `src/survey/` parses JSONC by hand (`jsonc.ts`) and never parses YAML at
  all -- `lefthook.yml`/workflow files are indexed by name, not excerpted, flagged
  `needsReading: true`, and left for `/customize`'s Step 0 to actually read.

- **A pack never edits YAML or JavaScript.** It extends three JSON files
  the baseline already reads at runtime (`.claude/settings.json`,
  `package.json`'s `scripts`, `bin/lib/verify-steps.packs.json` of the emitted
  project) via the pure
  merge functions in `packages/cli/src/merge-json.ts`. `.claude/settings.json`
  has two disjoint merges: `mergeSettingsHooks` owns the `hooks` block
  (entry-by-entry), and `mergeSettingsTopLevel` plants whole top-level keys
  such as `statusLine` (identical is a no-op, different is a hard collision --
  an adopted project's own `statusLine` is never overwritten). This is what keeps
  pack installation inside `packages/cli`'s zero-runtime-dependency,
  no-YAML-parsing constraints in both fresh mode (the CLI installs
  directly) and adopt mode (the CLI only surveys; `/customize` installs
  from the staged `.groundwork/packs/<name>/` copy after reading the
  project's real gate runner) -- see `templates/packs/README.md`.

- **`packages/cli/README.md` is generated, never hand-edited.** It is what npm
  shows for `@monte3l/groundwork`, and `bin/build-npm-readme.mjs` builds it from
  the root `README.md` (relative links rewritten to absolute
  `github.com/.../blob/main/` URLs by `bin/lib/npm-readme.mjs`), so npm and
  GitHub cannot describe different things. Edit the root README, then re-run
  `node bin/build-npm-readme.mjs` and commit both; `--check` is the `npm-readme`
  `lint`-group verify step. The package's `description`, `homepage` and
  `keywords` are kept equal to the GitHub repo's description, homepage and
  topics by hand: change both together. `docs-live.yml` compares them daily
  (`node design/source/docs-kit/check-live.mjs --metadata`) and fails when they differ.
