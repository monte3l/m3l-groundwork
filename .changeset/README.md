# Changesets

A change to `@monte3l/groundwork`'s user-visible behavior lands with a
changeset: run `pnpm changeset`, pick the bump, and commit the generated file
with the PR. Merging to `main` opens (or updates) a
`chore(release): version packages` PR; merging that publishes to npm.
See `.github/workflows/release.yml`.

`@monte3l/groundwork-plugin` (the `/customize` skill) never takes a changeset
-- it has no npm release. It is listed by the central `monte3l/m3l-plugins`
marketplace, pinned to a CLI release tag, so a change to it reaches
marketplace users only after the next CLI release and a pin-bump PR in that
repo. Its `plugin.json` version just tracks the CLI's,
for display (`bin/sync-plugin-version.mjs`).
