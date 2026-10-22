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
publish through trusted publishing, the pnpm-to-staged-publish shim (libnpmpublish), and one
gate (`check-dts-deps.mjs`). Modes: **fresh only**. Budget: 1 workflow, 2
scripts. The SPDX header gate and `REUSE.toml` used to ship here and are
now the `licensing` pack (`pack-licensing.md`); do not add them back.

- **Fresh mode only, on purpose.** It encodes registry, trusted-publisher
  and GitHub App decisions too project-specific to automate in adopt mode.
  Do not add `adopt` to `modes`.
- **It is the Changesets flow this repo used before release-please.** The root
  `.github/workflows/release.yml` now calls the organisation's shared release
  workflows (see `releases.md`), and the pack deliberately keeps the Changesets
  version PR, because a pack cannot wire release-please's config into someone
  else's repository. When the root flow changes, decide explicitly whether the
  pack's copy follows, and say so in the PR (convention only; no gate diffs
  them).
- **It cannot wire `@changesets/cli`,** because a pack never edits
  dependencies. `adoptNotes` and `setupSteps` carry the one-time
  `pnpm add -D @changesets/cli`. Keep them true.
- **`check-publish-version.mjs` is deliberately not a verify step.** It runs
  inside `release.yml`'s pack job only, because on a release branch the
  version always equals the one just published.
- **The shipped `tools/release/` lockfile pins `libnpmpublish` and
  `npm-registry-fetch`**, which `bin/npm-stage-publish.mjs` stages through
  instead of the npm CLI (whose bundled dependencies no override can patch).
  Keep it audit-clean: `npm audit --package-lock-only` in that directory.
  The scripts in `files/bin/` are token-substituted copies of this repo's own
  `bin/` ones; change both together.
- **The workflow file must stay named `release.yml`** in an emitted project:
  the trusted publisher is bound to that filename.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                 | Where                                             |
| --------------------- | ------------------------------------------------- |
| Installs and verifies | `packages/cli/tests/packs-publishing.e2e.test.ts` |
| With `supply-chain`   | `packs-publishing-supply-chain.e2e.test.ts`       |

A change to this pack alone takes a changeset whose summary starts with
`pack(publishing):`.
