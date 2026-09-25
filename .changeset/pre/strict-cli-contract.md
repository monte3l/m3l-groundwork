---
"@monte3l/groundwork": minor
---

**Breaking** (allowed pre-1.0; see the upcoming versioning policy): the CLI's argument parsing is now strict. An unrecognized flag, a `--name`/`--pack` given with no value (or a value that looks like another flag), more than one positional argument, or `--adopt` together with `--fresh` now fail fast with a usage error and exit code `2`, instead of being silently accepted or ignored. A genuine runtime error still exits `1`. `--help`/`-h` and `--version`/`-v` are now both documented in the usage text.

The published package's `exports` map no longer advertises a `"."` entry (nor `main`/`types`) -- `@monte3l/groundwork` is a CLI, not a library, and its only supported entry point is the `m3l-groundwork` binary. Importing it as a JS module was never documented and is no longer possible.

`.groundwork/adoption-report.md`'s header now also states the inventory's `schemaVersion` alongside the CLI version that generated it.
