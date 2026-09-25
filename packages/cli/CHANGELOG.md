# @monte3l/groundwork

## 0.1.0-next.1

### Minor Changes

- [#16](https://github.com/monte3l/m3l-groundwork/pull/16) [`7095714`](https://github.com/monte3l/m3l-groundwork/commit/70957145a27a1f43c1aed5dd0f6b6410aef1edf6) Thanks [@enri3l](https://github.com/enri3l)! - **Breaking** (allowed pre-1.0; see the upcoming versioning policy): the CLI's argument parsing is now strict. An unrecognized flag, a `--name`/`--pack` given with no value (or a value that looks like another flag), more than one positional argument, or `--adopt` together with `--fresh` now fail fast with a usage error and exit code `2`, instead of being silently accepted or ignored. A genuine runtime error still exits `1`. `--help`/`-h` and `--version`/`-v` are now both documented in the usage text.
  
  The published package's `exports` map no longer advertises a `"."` entry (nor `main`/`types`) -- `@monte3l/groundwork` is a CLI, not a library, and its only supported entry point is the `m3l-groundwork` binary. Importing it as a JS module was never documented and is no longer possible.
  
  `.groundwork/adoption-report.md`'s header now also states the inventory's `schemaVersion` alongside the CLI version that generated it.

## 0.1.0-next.0

### Minor Changes

- [#11](https://github.com/monte3l/m3l-groundwork/pull/11) [`5c56af2`](https://github.com/monte3l/m3l-groundwork/commit/5c56af231b0ef2c77a82d08b96356901a0dbdc0f) Thanks [@enri3l](https://github.com/enri3l)! - First public release. `@monte3l/groundwork` bootstraps a TypeScript + Claude Code project (fresh mode) or surveys an existing one read-only (adopt mode). It installs the `/customize` skill (`@monte3l/groundwork-plugin`, distributed via the `monte3l` Claude Code plugin marketplace, not npm) into every project it touches.
