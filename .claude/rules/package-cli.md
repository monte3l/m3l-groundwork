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
- **A new walker over `templates/` restores escaped dotfile names** via
  `restoreDotfilePath` (`_gitignore`, `_npmrc`, `_npmignore`), as `emit.ts`
  and `conflicts.ts` do. Skip it and a published install silently loses
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
- **Tests whose subject is a template file** belong in `tests/templates/`,
  not beside the tests of `src/` modules (see `tests.md`).

| Change                                         | Proof required                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Anything in `src/`                             | `pnpm verify`, then `pnpm test:e2e`                               |
| What the tarball ships, or how it locates data | `pack.e2e.test.ts`, never a run from the checkout                 |
| A user-visible change                          | A changeset: `pnpm changeset`, `patch` only while `rc` mode is on |
