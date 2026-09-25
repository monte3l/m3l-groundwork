# Changesets

A change to `@monte3l/groundwork`'s user-visible behavior lands with a
changeset: run `pnpm changeset`, pick the bump, and commit the generated file
with the PR. Merging to `main` opens (or updates) a
`chore(release): version packages` PR; merging that publishes to npm.
See `.github/workflows/release.yml`.

`@monte3l/groundwork-plugin` (the `/customize` skill) never takes a changeset
-- it has no npm release. It ships through the Claude Code marketplace
(`.claude-plugin/marketplace.json`, a relative-path source into
`packages/plugin`), so a change to it is live for marketplace users the
moment it lands on `main`. Its `plugin.json` version just tracks the CLI's,
for display (`bin/sync-plugin-version.mjs`).
