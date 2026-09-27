---
paths:
  - "design/**"
  - "bin/build-design-tokens.mjs"
  - "bin/lib/design-tokens.mjs"
  - "bin/lib/term.mjs"
  - "packages/cli/src/palette.ts"
  - "packages/cli/src/term.ts"
---

# Design system rules (`design/**`, the token generator, terminal painting)

> This file is the terse checklist that auto-loads when you touch the
> vendored design system or either of its generated code targets. See
> `design/README.md` for provenance and the full re-sync procedure.

**`design/` is this repo's own vendored copy of m3l-design, this repo only --
`templates/**` stays brand-neutral.** `design/source/` is a verbatim copy of
the m3l-design Claude Design artifact (DTCG 2025.10 tokens, component CSS,
brand book, fonts) -- see `design/README.md` for provenance and the re-sync
rule (**never hand-edit `source/`**). `design/tokens.css` is generated from
it by `bin/build-design-tokens.mjs`, whose resolver
(`bin/lib/design-tokens.mjs`) is a small, zero-dependency DTCG resolver: it
follows `m3l.resolver.json`'s own `resolutionOrder` (primitives -> semantic
-> theme -> motion -> components) -- checked, not just assumed:
`loadDesignSystem` asserts the manifest still declares that exact
set/modifier/context shape and order before any theme resolves, so a
re-sync that reorders or renames one of them fails loudly instead of
silently merging in the wrong precedence -- resolves `{alias}` references
with cycle/missing-alias errors, and flattens the resolved tree into the
same dashed-name convention m3l-design's own flattened `tokens.json` uses
(`color-surface-default`, `button-primary-bg`, ...) -- that vendored
`tokens.json` is kept only as a parity oracle
(`packages/cli/tests/design-tokens.test.ts`), never read by the build
itself; the DTCG files are canonical, per `design/README.md`. Every
formatter (`formatColor`, `formatDimension`, `formatEasing`, `formatShadow`)
validates its input's shape and throws `DesignTokenError` rather than
interpolating `undefined` into the generated CSS -- see `deriveTypeTreatment`,
the typography distillation, for the same fail-loud rule applied to
letter-spacing/word-spacing/shared-flag agreement across styles.

`node bin/build-design-tokens.mjs --check` is the `design-tokens` step in
`bin/lib/verify-steps.mjs`'s `lint` group (a `CORE_STEPS`-shaped entry with
no `package.json` script, same pattern as the harness/toolchain gates) --
it fails on drift rather than writing, so **a change to `design/source/dtcg/`
must be followed by re-running the plain (no-flag) command and committing
`design/tokens.css` in the same change.** It is run through this repo's own
Prettier config before being written, so `pnpm format:check` and this step
never disagree about its formatting.

The same generator also emits `packages/cli/src/palette.ts` -- the six
terminal status/text colors, light and dark, `packages/cli/src/term.ts`
paints console output with (`paint()`, `supportsColor()`): color only when
the stream is a TTY, never when `NO_COLOR` is set, always when `FORCE_COLOR`
is; truecolor SGR when `COLORTERM` is `truecolor`/`24bit`, else the nearest
of the 16 standard ANSI colors by RGB distance; theme follows `COLORFGBG`
when present, defaults to dark otherwise. Piped/non-TTY output is
byte-identical to plain text -- every string-matched test keeps passing
without needing to know about color at all. `bin/lib/term.mjs` is the
root-tooling twin (`bin/verify.mjs`, `bin/lib/report.mjs`,
`bin/lint-commit.mjs`, `bin/eval.mjs`, `.claude/hooks/statusline-layout.mjs`):
it resolves its own palette straight from `design/source/dtcg/` rather than
importing a generated file, since root tooling has no build step to emit
one into -- not compared against `term.ts` by a parity test, unlike the
harness/toolchain grader twins, since a drift here is cosmetic (two
terminals' output), not a behavioral contract.
