Thank you for the change. A few lines here help the review go quickly.

## What and why

<!-- What does this change, and what problem does it solve? If it closes an issue, say so: "Closes #123". -->

## How you checked it

<!-- The commands you ran and what you saw. -->

## Checklist

- [ ] `pnpm verify` passes
- [ ] `pnpm test:e2e` passes (required if this touches `packages/cli/src/`,
      `templates/core/`, or `packages/plugin/skills/customize/`)
- [ ] Every commit is signed off (DCO, `git commit -s`) and GPG-signed
- [ ] New functionality has tests, and a bug fix has a regression test
      that fails without the fix
- [ ] The title and commits are Conventional Commits whose type matches the
      change (`feat`, `fix`, `!` for breaking). The release version and
      changelog come from them
- [ ] The baseline caps still hold, if a `.claude/` file, CI workflow or root
      script was added or removed under `templates/core/`. `pnpm test` checks
      this, through the tests around `packages/cli/src/caps.ts`;
      `pnpm check:harness` and `pnpm check:toolchain` do not, because they
      grade a rubric instead
- [ ] A new file under `templates/core/` is claimed by
      `packages/plugin/src/domain-map.ts`
- [ ] A new tracked file outside `templates/**` carries an SPDX header
      (`bin/check-license-headers.mjs --fix`), or is covered by a
      `REUSE.toml` glob instead
