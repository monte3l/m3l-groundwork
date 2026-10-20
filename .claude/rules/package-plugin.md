---
paths:
  - "packages/plugin/**"
---

# Plugin package rules (`packages/plugin/**`)

> This file is the terse checklist that auto-loads when you edit the
> `/customize` plugin. It is private and ships only through the central
> `monte3l/m3l-plugins` marketplace, never npm. It adds to `src.md` and `tests.md`.

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
- **A plugin-only change takes no changeset, and is not live on merge.** The
  central `monte3l/m3l-plugins` catalog pins a CLI release tag and commit, so
  it ships after the next CLI release and a pin-bump PR there (see
  `releases.md`). This repo carries no `marketplace.json`; develop locally
  with `claude --plugin-dir packages/plugin`.
- **`SKILL.md` edits change `/customize`'s behaviour,** so run
  `pnpm test:e2e`. The behavioural evals (`pnpm eval`) are paid and never
  part of `verify`; `evals.md` covers them.
- **Two guidance skills have full authority over their whole domain.** A
  change must never narrow a sweep to the facet an interview answer names.

## Design record

> Moved verbatim from the root `CLAUDE.md` ("Architecture notes") so it loads only when you edit the files it governs.

- **`/customize`'s two guidance skills (`typescript-guidance`,
  `harness-guidance`, both in `templates/core/.claude/skills/`) each have
  full authority over their entire domain**, not just the facets an
  interview answer happens to emphasize -- see both skills' own "Authority"
  section and `packages/plugin/skills/customize/SKILL.md`'s "Round 2". The
  interview scopes research _priority_, never _what a sweep is allowed to
  touch_. Don't narrow a sweep's scope to "just the facet the user asked
  about" when adjusting either skill. `typescript-guidance` also has a third
  mode, `gaps` (merged in from the retired `ts-advisor` pack): it recommends
  tooling the project does not have at all, every recommendation carrying a
  source fetched in that run, and never rules on config that already exists
  -- that stays `research`'s and `refresh`'s authority. Its
  `references/tooling-sources.md` is the ecosystem-tooling allowlist beside
  `typescript-sources.md`.
- **`packages/plugin/src/domain-map.ts` is a structural guarantee, not
  documentation.** `packages/plugin/tests/domain-map.test.ts` walks the
  _real_ `templates/core` tree on every test run and asserts every file is
  claimed by exactly one of `typescript-guidance`'s domain,
  `harness-guidance`'s domain, or an explicit neutral allowlist. Adding a
  new file under `templates/core/` that doesn't match any of the three glob
  lists in `domain-map.ts` fails this test -- that's the point: it's how a
  new template file gets caught before it becomes a silent blind spot for
  both guidance sweeps. Update the glob lists in the same commit that adds
  the file, not as a follow-up.
- **`pack-map.ts` and `plugin-map.ts` are the same "infer once, visibly,
  with reasoning attached" pattern applied to two different install
  surfaces.** `recommendPacks` (`pack-map.ts`) recommends which
  `templates/packs/*` bundle(s) to install; `recommendPlugins`
  (`plugin-map.ts`) recommends which locally-installed, built-in
  `claude-plugins-official` marketplace plugin(s) to enable -- both pure
  functions of the interview answers (plus, for `plugin-map.ts`, which
  packs were chosen, whether the project authors its own skills, which
  packages it depends on, and whether it already has a design system), each
  with its own unit-tested table so a recommendation's evidence is never
  invented fresh at `/customize` run time.
