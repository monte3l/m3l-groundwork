---
paths:
  - "templates/packs/licensing/**"
---

# Pack rules: `licensing` (`templates/packs/licensing/**`)

> This file is the terse checklist that auto-loads when you edit the
> `licensing` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The SPDX/REUSE license-header gate:
`bin/check-license-headers.mjs` (a `lint`-group verify step) and a
`REUSE.toml` template. Modes: **fresh only**. Budget: all zero (`scripts`
counts `package.json` scripts, not `bin/` files). It was split out of
`publishing` so a project can take the header gate without the npm release
pipeline, and the other way round. The two packs share no file and neither
imports the other.

- **Fresh mode only, on purpose.** The one-time backfill fails an established
  project's `pnpm verify` until it has touched every file. Do not add `adopt`
  to `modes`.
- **`setupSteps` and `adoptNotes` carry the backfill** (`git add -A`,
  `node bin/check-license-headers.mjs --fix`, `git add -A`). The gate only
  checks git-tracked files, so a fresh project with nothing staged passes it
  vacuously. Keep both true: `packs.test.ts` requires `adoptNotes` to contain
  every setup command verbatim.
- **The shipped files use `NOASSERTION`** as the license identifier, because
  the pack cannot know the project's license. This repo's root `REUSE.toml`
  overrides `templates/packs/licensing/files/**` to MIT so `reuse lint`
  passes here; keep that annotation when the path changes.
- **`REUSE.toml` carries globs for `.gitleaks.toml` and `.worktreeinclude`,**
  the files the `supply-chain` and `worktrees` packs add. Without them the
  gate's uncovered-file check fails once either pack is installed next to
  this one.
- **The script is a forked copy of this repo's own `bin/check-license-headers.mjs`,**
  not byte-identical (the root one is MIT and exempts `templates/`). Nothing
  diffs them, so decide per PR whether a fix applies to both.
- **`__PROJECT_NAME__` is substituted** in `REUSE.toml` and the header the
  script inserts; a hand-copied install must replace it.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                 | Where                                            |
| --------------------- | ------------------------------------------------ |
| Installs and verifies | `packages/cli/tests/packs-licensing.e2e.test.ts` |
| With `worktrees`      | `packs-combined.e2e.test.ts`                     |
| Setup-step order      | `main-setup-steps.test.ts`                       |
| Manifest contract     | `packs.test.ts`, `caps.test.ts`                  |

A change to this pack alone is released by its Conventional Commit type
(`fix(packs): ...` for a fix or a change to existing behaviour,
`feat(packs): ...` for new public surface),
because packs ship inside the CLI tarball and have no release of their own.
There is no changeset.
