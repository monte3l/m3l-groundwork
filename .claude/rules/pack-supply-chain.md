---
paths:
  - "templates/packs/supply-chain/**"
---

# Pack rules: `supply-chain` (`templates/packs/supply-chain/**`)

> This file is the terse checklist that auto-loads when you edit the
> `supply-chain` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** `gitleaks.yml` with a `.gitleaks.toml`, and `scorecard.yml`,
for any GitHub-hosted project, published or not. A pure file drop: no hooks,
settings, scripts or verify step. Modes: fresh and adopt. Budget: 2
workflows.

- **Both workflows are read-only and not required checks by default.** Keep
  `permissions` minimal and the shipped defaults unchanged.
- **They ship without an SPDX header on purpose:** a header would carry a
  project-name token that stays literal in an adopt-mode install. The
  license-header gate belongs to the fresh-only `publishing` pack. Do not
  move it here.
- **`gitleaks.yml` needs a `GITLEAKS_LICENSE` secret for an org-owned repo,**
  and `scorecard.yml` assumes a public repository. Both are in `adoptNotes`.
- **This repo has its own copies** (`.github/workflows/gitleaks.yml`,
  `scorecard.yml`). They are separate files with separate pins, and
  `ci.md` governs the root ones. Decide per PR whether a fix applies to both.
- **Actions are SHA-pinned with a `# vX.Y.Z` comment.**
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                 | Where                                               |
| --------------------- | --------------------------------------------------- |
| Installs and verifies | `packages/cli/tests/packs-supply-chain.e2e.test.ts` |
| With `publishing`     | `packs-publishing-supply-chain.e2e.test.ts`         |
| Combined              | `packs-combined.e2e.test.ts`                        |

A change to this pack alone takes a changeset whose summary starts with
`pack(supply-chain):`.
