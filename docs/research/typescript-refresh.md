# TypeScript refresh tracker

<!-- typescript-refresh: last-verified=2026-09-24 typescript-version=7.0.2 -->

Living record of `typescript-guidance` (refresh mode) sweeps — the
per-facet, per-source state a run diffs against, so each sweep reports what
**changed** since the last one instead of rediscovering the whole toolchain
from scratch. Updated **in place** on every run, never as a new dated file.

`typescript-version` in the header records the newest **upstream**
TypeScript release the last sweep verified against — deliberately distinct
from `package.json`'s own `typescript` devDependency pin, which this
tracker exists to check against, not restate. The two numbers disagreeing
is not a bug in the tracker; it's the finding.

**2026-09-24 sweep** — first sweep. This repo's own toolchain (root
`tsconfig.base.json`, `packages/*/tsconfig*.json`, root `eslint.config.js`,
`vitest.config.ts`, `package.json`) is the domain graded here, not
`templates/core`'s baseline copy (which has its own `templates/core:typescript-guidance`
variant and is currently content-identical to root's `tsconfig.base.json`).
Upstream headline: TypeScript shipped a full native Go rewrite as 7.0 (stable
2026-07-08, latest patch 7.0.2 on 2026-08-20) — this repo is pinned to
`^6.0.3`, the last JS-codebase release line.

## Outstanding drift

| Item                                                                                                                                                                                                      | Facet                     | Status                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `vitest` pin is ~6 months behind (`^4.1.11` vs. current `5.0.1`, released 2026-09-03)                                                                                                                     | testing-language-features | remediation plan proposed this sweep                                           |
| `tsconfig.base.json` `target: es2023` vs. TypeScript 6.0+'s new default `es2025` (Node 24 supports it)                                                                                                    | compiler-config-flags     | remediation plan proposed this sweep (optional)                                |
| `typescript-eslint` v8's supported TypeScript range is `>=4.8.4 <6.1.0` — a future bump past `^6.0.3` needs typescript-eslint v9 (not yet released) or the `@typescript/typescript6` API-alias workaround | lint-typing-rules         | informational only — no action while pinned at `^6.0.3`, which is inside range |

## Facet state

| Facet                        | Last verified | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compiler-config-flags`      | 2026-09-24    | `strict`, `module: nodenext`, `moduleResolution: nodenext`, `types: ["node"]`, `verbatimModuleSyntax`, `noUncheckedSideEffectImports` all already match current upstream guidance; no deprecated/removed options (`baseUrl`, legacy `moduleResolution` values, `target: es5`) present. Only real gap: `target: es2023` vs. TS 6.0+'s new default `es2025`.                                                                                                                                                                                                                                                                                                  |
| `modules-esm-node-interop`   | 2026-09-24    | `nodenext` confirmed as the _only_ valid `moduleResolution` for Node under TS 7.0 (`node`/`node10` removed). `.js`-extension requirement on relative imports unchanged since TS 4.7 (`guard-js-extension.mjs`, `import-x/extensions` still correct). TS 6.0 forced `esModuleInterop` to always-true and TS 7.0 removed the `false` option entirely — TypeScript itself provides no native guard against a CJS import in a strict-ESM project, so `guard-no-commonjs.mjs` + ESLint remain the _only_ enforcement mechanism, unchanged in necessity.                                                                                                          |
| `packaging-declaration-emit` | 2026-09-24    | TS 7.0's native rewrite improves declaration-emit parallelism/consistency with no breaking change to packaging. `isolatedDeclarations` remains optional (not default), available for a future CI-speed pass. ATTW/publint failure-mode categories and bin/shebang packaging rules are unchanged; `check-exports.mjs` needs no update.                                                                                                                                                                                                                                                                                                                       |
| `lint-typing-rules`          | 2026-09-24    | `recommendedTypeChecked` remains the current typescript-eslint baseline (not superseded by `strictTypeChecked`). `no-explicit-any` and `no-floating-promises` are already included by that preset — the repo's hand-added copies are redundant but harmless (kept deliberately as explicit in-file documentation of the "no `any` in public API" rule; not a defect). `no-non-null-assertion` is correctly hand-added (only in `strict*`, not in `recommendedTypeChecked`). `switch-exhaustiveness-check`/`consistent-type-imports` are correctly hand-added (in no preset). Compatibility ceiling: typescript-eslint v8 only supports TypeScript `<6.1.0`. |
| `testing-language-features`  | 2026-09-24    | Coverage-gate shape (v8 provider, `perFile: true`, 80% all four metrics) matches current Vitest docs exactly — no change. The CLI-subprocess/stdio e2e pattern this repo already uses matches Vitest's documented `forks`-pool guidance — no change. Real drift: `vitest` pin `^4.1.11` vs. current stable `5.0.1` (released 2026-09-03, ~6 months of releases behind). Vitest 5.0's own release notes make no mention of TypeScript 7.0 compatibility either way.                                                                                                                                                                                          |
