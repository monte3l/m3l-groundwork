## What and why

<!-- What does this change, and what problem does it solve? -->

## Checklist

- [ ] `pnpm verify` passes
- [ ] `pnpm test:e2e` passes (required if this touches `packages/cli/src/`,
      `templates/core/`, or `packages/plugin/skills/customize/`)
- [ ] A changeset is included (`pnpm changeset`), if this is a user-visible
      change to `@monte3l/groundwork` -- the plugin never takes one
- [ ] Baseline caps still hold (`pnpm check:harness`, `pnpm check:toolchain`),
      if a `.claude/` file was added or removed under `templates/core/`
- [ ] A new file under `templates/core/` is claimed by
      `packages/plugin/src/domain-map.ts`
