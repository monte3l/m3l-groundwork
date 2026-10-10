---
paths:
  - "packages/plugin/**"
---

# Plugin package rules (`packages/plugin/**`)

> This file is the terse checklist that auto-loads when you edit the
> `/customize` plugin. It is private and ships only through the Claude Code
> marketplace, never npm. It adds to `src.md` and `tests.md`.

- **`src/domain-map.ts` is a structural guarantee.** Its test walks the real
  `templates/core` tree and every `templates/packs/*/files` tree, and fails
  on any file that no guidance domain or neutral allowlist claims. Update
  the globs in the same commit that adds a template file.
- **`src/pack-map.ts` hard-codes the pack names, and `src/plugin-map.ts`
  hard-codes the plugin recommendations.** A pack added, renamed or
  re-scoped needs both tables and their tests updated, plus
  `packages/cli/src/packs.ts` if the contract moved.
- **The plugin version tracks the CLI's.** `bin/check-plugin-version.mjs`
  fails the `verify` run on drift, and `bin/sync-plugin-version.mjs` fixes
  it. `packages/plugin/package.json` stays `private`.
- **A plugin-only change takes no changeset and no release step.** The
  marketplace entry is a relative path into this directory.
- **`SKILL.md` edits change `/customize`'s behaviour,** so run
  `pnpm test:e2e`. The behavioural evals (`pnpm eval`) are paid and never
  part of `verify`; `evals.md` covers them.
- **Two guidance skills have full authority over their whole domain.** A
  change must never narrow a sweep to the facet an interview answer names.
