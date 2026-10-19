---
"@monte3l/groundwork": patch
---

pack(licensing): the SPDX/REUSE license-header gate (`check-license-headers.mjs`, its `license-headers` verify step and the `REUSE.toml` template) moves out of the `publishing` pack into a new fresh-only `licensing` pack, so a project can take the header gate without the npm release pipeline and the other way round. `--pack publishing` no longer emits the gate or `REUSE.toml`, and its one-time setup shrinks to `pnpm add -D @changesets/cli`; pass `--pack publishing --pack licensing` for the previous set, and run licensing's `git add -A` / `--fix` backfill. `/customize` recommends `licensing` for `library` and `cli` projects, like `publishing`. A project that already installed `publishing` keeps its files untouched.
