---
paths:
  - "templates/packs/worktrees/**"
---

# Pack rules: `worktrees` (`templates/packs/worktrees/**`)

> This file is the terse checklist that auto-loads when you edit the
> `worktrees` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** Worktree-only development: `guard-worktree-only.mjs`, the
`working-in-worktrees` skill, `ensure-worktree-deps.mjs`,
`repair-core-bare.mjs` and a `.worktreeinclude`. Modes: fresh and adopt.
Budget: 1 skill, 3 hooks. Requires `bin/lib/protected-paths.mjs`.
`recommended: false` in `packages/plugin/src/pack-map.ts`, on purpose,
because it changes the day-to-day workflow.

- **The guard is stricter than the baseline's.** It blocks every
  `src`/`tests` write outside a linked worktree under `.claude/worktrees/`,
  on any branch, for any caller. Do not soften it, and do not make the pack
  recommended.
- **`ensure-worktree-deps.mjs` runs `pnpm install --frozen-lockfile`.** That
  runs lifecycle scripts, limited only by the project's own pnpm policy. It
  must skip when `node_modules` is a symlink, since installing there would
  mutate the main checkout.
- **`repair-core-bare.mjs` acts only on a provably non-bare repository:** its
  common git dir is named `.git` and holds an index. Never relax that
  check, and report a failed repair on stdout, never silently.
- **Policy goes in the skill body, not a rule.** A pack cannot ship a
  `.claude/rules` file (see `templates/packs/README.md`), so
  `working-in-worktrees` carries the policy.
- **`protected-paths.mjs` comes from the baseline.** Keep `requires.paths`
  honest if the import changes.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                 | Where                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| Guards and hooks      | `packages/cli/tests/templates/{worktree-guards,repair-core-bare}.test.ts` |
| Installs and verifies | `packages/cli/tests/packs-worktrees.e2e.test.ts`                          |
| Combined              | `packs-combined.e2e.test.ts`                                              |

A change to this pack alone takes a changeset whose summary starts with
`pack(worktrees):`.
