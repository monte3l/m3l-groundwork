# Changesets

A change to this package's user-visible behavior lands with a changeset: run
`pnpm changeset`, pick the bump, and commit the generated file with the PR.
Merging to the release branch opens (or updates) a
`chore(release): version packages` PR; merging that publishes to npm. See
`.github/workflows/release.yml`.

This pack ships the `changeset`/`version:packages` scripts and the release
workflow, but not the `@changesets/cli` package itself -- the wiring
contract a pack installs through never edits `package.json`'s
`dependencies`/`devDependencies` (see `templates/packs/README.md`). Add it
by hand once, **before the first `pnpm verify`, not just before the first
real release** -- both scripts reference the `changeset` binary, and
`knip`'s unlisted-binaries check correctly fails until it actually resolves:

```
pnpm add -D @changesets/cli
```

`config.json`'s `changelog` is the plain built-in generator
(`@changesets/cli/changelog`), which needs no further setup. Swap in
`@changesets/changelog-github` (and its `repo` option) once this project's
GitHub repository is known, for changelog entries that link back to the
originating PR/commit.
