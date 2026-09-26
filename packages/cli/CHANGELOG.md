# @monte3l/groundwork

## 1.0.0-rc.3

### Patch Changes

- [#33](https://github.com/monte3l/m3l-groundwork/pull/33) [`7aa6665`](https://github.com/monte3l/m3l-groundwork/commit/7aa6665e8d04ea5eb22e8e11d15b87cc0f46296c) Thanks [@enri3l](https://github.com/enri3l)! - The emitted baseline's CI workflows now pin every `uses:` by commit SHA (with a `# vX` comment naming the tag) instead of a floating major tag, matching this repo's own SHA-pinning discipline: `actions/checkout` (v6 -> v7), `pnpm/action-setup` (v4 -> v6), `actions/setup-node`, `actions/dependency-review-action` (v4 -> v5), and `actions/github-script`. A new `.github/dependabot.yml` (github-actions ecosystem) keeps those pins from going stale. The `claude-action` pack's workflow gets the same treatment (`actions/checkout` v6 -> v7, `anthropics/claude-code-action` v1 -> the exact patch this repo pins).

- [#30](https://github.com/monte3l/m3l-groundwork/pull/30) [`4592b61`](https://github.com/monte3l/m3l-groundwork/commit/4592b61db30ab2e22cc23ffcc9f3f46ac2093294) Thanks [@enri3l](https://github.com/enri3l)! - The CLI's invocation contract now rejects several previously-silent or wrongly-coded invocations as usage errors (exit code 2), matching the frozen "invalid or contradictory invocations fail fast" policy:
  
  - Adopt mode now rejects `--force` and `--pack` outright with `CliUsageError`, instead of throwing a plain runtime error (`--force`, exit 1) or silently ignoring the flag entirely (`--pack`).
  - `--adopt` against a target directory that doesn't exist now fails with a clear usage error, instead of an uncaught filesystem exception.
  - A repeated `--name` (or any future single-value flag) now fails fast, instead of silently keeping the last value.
  - `.groundwork/adoption-report.md` now detects a git worktree or submodule (`.git` as a file, not a directory) as an existing project to adopt, instead of misdetecting it as empty.
  - A malformed `package.json` is now recorded once in the adoption report's undetermined list, instead of being silently dropped (or, in one intermediate state, reported twice).
  - The adoption report's caps table now shows Workflows and Scripts rows, and folds every listed pack's budget into the displayed post-merge total and over-cap warning, instead of omitting two of the five caps and excluding pack budgets from the total it displays.
  - A pack whose `pack.json` has an internal `name` not matching its own directory, or a malformed `budget`, now fails to load with a clear error instead of risking a staging collision or propagating `NaN` into the caps table.
  - Several smaller robustness fixes: a non-object `tsconfig.json`/`package.json` (e.g. literally `null`) no longer crashes conflict detection; the `/customize` skill's staleness check now compares all four of its files, not just `SKILL.md`; a settings-merge collision check no longer misfires on two semantically-identical values that merely have their keys in a different order; re-staging a pack now clears files a newer version dropped.

- [#28](https://github.com/monte3l/m3l-groundwork/pull/28) [`1842bf1`](https://github.com/monte3l/m3l-groundwork/commit/1842bf191882583800472cb5e3c4ec2fe10c23ef) Thanks [@enri3l](https://github.com/enri3l)! - `templates/core/CLAUDE.md` and `templates/core/.claude/rules/agent-dispatch.md` -- content the CLI emits into every bootstrapped project -- now document that a Claude Code Enterprise/managed-settings deployment can silently disable hub-and-spoke enforcement (`allowManagedHooksOnly`/`allowManagedPermissionRulesOnly`), and point at `/status` to confirm the guard hooks are actually active. This shipped in this repo's own `CLAUDE.md` and `.claude/rules/agent-dispatch.md` without a changeset; this records the same change for the emitted baseline.

- [#29](https://github.com/monte3l/m3l-groundwork/pull/29) [`0fe6ffb`](https://github.com/monte3l/m3l-groundwork/commit/0fe6ffbcf0dcc5fe44ce510f7fa3326829aa0df7) Thanks [@enri3l](https://github.com/enri3l)! - Fixes several accuracy bugs in adopt mode's harness and toolchain grading (`.groundwork/adoption-report.md`'s "Harness grade" and "Toolchain grade" sections, and the inventory's `harnessGrade`/`toolchainGrade`):
  
  - The toolchain grader no longer misreads a single-quoted string in `eslint.config.js`/`vitest.config.ts`/`bin/lib/verify-steps.mjs` as opening a comment, which previously corrupted everything after it and produced spurious rubric findings.
  - `gate-lane-parity` no longer silently skips judgment of an entire CI/lefthook surface because of a quoted `--group`/`--step` value, a shell line-continuation splitting one invocation across two lines, or an unrelated `echo`/`name:` field elsewhere on the same line.
  - The harness grader's `hook-entrypoint` rule now also flags a hook comparing `realpathSync(process.argv[1])` to `new URL(import.meta.url).pathname` -- a form that looks correct but never compares equal at runtime, so the hook fails open just like the two forms already caught.
  - A malformed `.claude/settings.local.json` is no longer silently treated as absent: a new `settings-local-parses` finding reports it, and `hook-dangling`/`hook-orphan` now skip judgment (rather than misreporting) while it can't be read.

- [#32](https://github.com/monte3l/m3l-groundwork/pull/32) [`a3e0e36`](https://github.com/monte3l/m3l-groundwork/commit/a3e0e363af0c09f5d5e9a35d21dd3a595151cb8f) Thanks [@enri3l](https://github.com/enri3l)! - Hardens the emitted baseline's hub-and-spoke enforcement hooks (`guard-branch-isolation.mjs`, `guard-hub-src-writes.mjs`) and the `harness-extras` pack's `guard-readonly-bash.mjs`:
  
  - `isProtectedPath` no longer matches `/src/`/`/tests/` anywhere in an absolute path's raw text -- scoped to the project directory (or a file's real git worktree root), it no longer wrongly protects a checkout whose own path happens to contain the substring `/src/` (e.g. a clone at `~/src/some-project`), and its comparison is case-insensitive so a differently-cased spelling of the identical file (macOS's default case-insensitive filesystem) is still caught correctly.
  - `guard-branch-isolation.mjs` now binds its git branch check to the nearest existing ancestor of a write's target directory, so creating a file in a brand-new nested directory (which doesn't exist yet) no longer silently breaks branch detection and lets the write through unblocked on `main`.
  - `guard-readonly-bash.mjs`'s mutating-command denylist now also catches `git rm/mv/pull`, `pnpm`/`npm install`/`update`, `sed --in-place`, a mutating command hidden behind a `sudo`/`env`/`xargs`/`command` prefix or a nested `bash -c`/`sh -c` shell, and `find -delete`/`-exec <mutating command>`. A malformed agent frontmatter block (CRLF line endings, a quoted `name:` value) no longer silently produces an empty read-only-agent roster, which previously disabled the guard for every subagent.
  - `bin/verify.mjs`'s `--group`/`--step` with no value now fails with a clear error instead of silently running every step.

- [#56](https://github.com/monte3l/m3l-groundwork/pull/56) [`4f11c23`](https://github.com/monte3l/m3l-groundwork/commit/4f11c23d969a8d2c6eb7cfb7116855ff70f6c1af) Thanks [@enri3l](https://github.com/enri3l)! - Console output now paints a handful of status lines (`✓ ... is ready`, the adoption report's `✓` line, and an over-cap warning) in m3l-design's terminal palette, when color is supported: never when `NO_COLOR` is set, always when `FORCE_COLOR` is set to anything but `"0"`, and otherwise only on a real TTY. Non-interactive output (the common case for CI and for every existing test in this repo) is byte-identical to before this change -- nothing in the CLI's documented public API (flags, modes, exit codes, `.groundwork/` file contents) changed.

- [#42](https://github.com/monte3l/m3l-groundwork/pull/42) [`205560e`](https://github.com/monte3l/m3l-groundwork/commit/205560e2064bfd28de9b72cc488e6dea7c986929) Thanks [@enri3l](https://github.com/enri3l)! - `--pack <name>` and an explicit `--name <project-name>` are now validated by shape before any filesystem access. `--pack` must be a bare lowercase directory-name (rejecting a path traversal segment, an absolute path, a path separator, or uppercase characters); `--name` must be a syntactically valid npm package name. Both throw a usage error (exit 2) naming the offending value, the same way an unrecognized flag already does.

- [#42](https://github.com/monte3l/m3l-groundwork/pull/42) [`226af60`](https://github.com/monte3l/m3l-groundwork/commit/226af600d70d606f8f6484e045c3c8d4134be521) Thanks [@enri3l](https://github.com/enri3l)! - The published tarball now includes the repository's `LICENSE` file (`prepack` vendors it in, `postpack` removes it again -- the same pattern already used for `templates/` and the plugin payload). Previously the package shipped with no license file at all.

## 1.0.0-rc.2

### Major Changes

- [#22](https://github.com/monte3l/m3l-groundwork/pull/22) [`7afec0e`](https://github.com/monte3l/m3l-groundwork/commit/7afec0e84a279565933e9d6f2648e3914b937d2b) Thanks [@enri3l](https://github.com/enri3l)! - First 1.0 release candidate. The public API is frozen as of this release: CLI flags, modes, and exit codes; the `.groundwork/inventory.json` and `adoption-report.md` file formats; the `.groundwork/packs/` staging layout and pack names; the `engines.node` floor; and `/customize`'s invocation name. See the README's "Versioning policy" section for the full list and what's explicitly excluded (the baseline's emitted contents, which follow current upstream guidance and can still change in a minor release).
  
  Only fixes land for the rest of the `rc` series -- any further API change waits for 1.1. `@next` users must explicitly switch to `@rc` (or wait for `@latest`); SemVer prerelease ranges don't cross from `0.1.0-next.N` to `1.0.0-rc.N` automatically.

## 0.1.0-next.1

### Minor Changes

- [#16](https://github.com/monte3l/m3l-groundwork/pull/16) [`7095714`](https://github.com/monte3l/m3l-groundwork/commit/70957145a27a1f43c1aed5dd0f6b6410aef1edf6) Thanks [@enri3l](https://github.com/enri3l)! - **Breaking** (allowed pre-1.0; see the upcoming versioning policy): the CLI's argument parsing is now strict. An unrecognized flag, a `--name`/`--pack` given with no value (or a value that looks like another flag), more than one positional argument, or `--adopt` together with `--fresh` now fail fast with a usage error and exit code `2`, instead of being silently accepted or ignored. A genuine runtime error still exits `1`. `--help`/`-h` and `--version`/`-v` are now both documented in the usage text.
  
  The published package's `exports` map no longer advertises a `"."` entry (nor `main`/`types`) -- `@monte3l/groundwork` is a CLI, not a library, and its only supported entry point is the `m3l-groundwork` binary. Importing it as a JS module was never documented and is no longer possible.
  
  `.groundwork/adoption-report.md`'s header now also states the inventory's `schemaVersion` alongside the CLI version that generated it.

## 0.1.0-next.0

### Minor Changes

- [#11](https://github.com/monte3l/m3l-groundwork/pull/11) [`5c56af2`](https://github.com/monte3l/m3l-groundwork/commit/5c56af231b0ef2c77a82d08b96356901a0dbdc0f) Thanks [@enri3l](https://github.com/enri3l)! - First public release. `@monte3l/groundwork` bootstraps a TypeScript + Claude Code project (fresh mode) or surveys an existing one read-only (adopt mode). It installs the `/customize` skill (`@monte3l/groundwork-plugin`, distributed via the `monte3l` Claude Code plugin marketplace, not npm) into every project it touches.
