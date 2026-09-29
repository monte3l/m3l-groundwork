---
"@monte3l/groundwork": patch
---

Adds a `ts-advisor` pack (`--pack ts-advisor`): a read-only
`recommending-ts-tooling` skill that profiles a project's TypeScript
toolchain offline, then fans out live research over official upstream
tooling sources before recommending what's missing.

- Profiles scripts/dependencies, the resolved tsconfig chain, eslint/vitest/knip
  config, cap counts, and verify-step wiring, then researches tsconfig flags,
  module resolution, typed linting, testing, packaging validation, dependency
  hygiene, pnpm supply-chain settings, scripts/verify gates, monorepo/catalogs,
  Node pinning, and release automation against a fixed allowlist of official
  sources.
- Every recommendation carries a source URL fetched in that run; an
  unverifiable claim is reported as such, never recommended anyway.
- Reuses `typescript-guidance`'s own TypeScript-owner allowlist for that tier
  instead of duplicating it, and ships a sibling allowlist for the rest of
  the ecosystem (pnpm, knip, vitest, eslint, prettier, npm, Node releases).
- Never rules on TypeScript-facing config that already exists -- that stays
  `typescript-guidance`'s authority; this pack covers only what's absent.
- Recommended for every project kind in `/customize`'s pack recommendations
  (read-only, no hooks, no settings, no scripts, no gate).

No public API change beyond the new pack name being installable; this only
affects a project that opts in.
