---
paths:
  - "templates/packs/publishing/**"
---

# Pack rules: `publishing` (`templates/packs/publishing/**`)

> This file is the terse checklist that auto-loads when you edit the
> `publishing` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The release pipeline, adapted from this repo's own
`release.yml`: changesets version-PR and staged, provenance-attested npm
publish through trusted publishing, the pnpm-to-`npm stage` shim, and two
gates (`check-dts-deps.mjs`, `check-license-headers.mjs`) plus a
`REUSE.toml` template. Modes: **fresh only**. Budget: 1 workflow, 2 scripts.

- **Fresh mode only, on purpose.** It encodes registry, trusted-publisher
  and GitHub App decisions too project-specific to automate in adopt mode.
  Do not add `adopt` to `modes`.
- **It drifts from `.github/workflows/release.yml` by construction.** When
  the root release flow changes (see `releases.md`), decide explicitly
  whether the pack's copy follows, and say so in the PR.
- **It cannot wire `@changesets/cli`,** because a pack never edits
  dependencies. `adoptNotes` and `setupSteps` carry the one-time
  `pnpm add -D @changesets/cli`. Keep them true.
- **`check-publish-version.mjs` is deliberately not a verify step.** It runs
  inside `release.yml`'s pack job only, because on a release branch the
  version always equals the one just published.
- **The shipped `.github/release-tools/` lockfile pins npm.** The security
  note in `adoptNotes` carries a dated advisory analysis: re-check it, and
  update the date, whenever the pin moves.
- **The workflow file must stay named `release.yml`** in an emitted project:
  the trusted publisher is bound to that filename.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                 | Where                                             |
| --------------------- | ------------------------------------------------- |
| Installs and verifies | `packages/cli/tests/packs-publishing.e2e.test.ts` |
| With `supply-chain`   | `packs-publishing-supply-chain.e2e.test.ts`       |
| Combined              | `packs-combined.e2e.test.ts`                      |

A change to this pack alone takes a changeset whose summary starts with
`pack(publishing):`.
