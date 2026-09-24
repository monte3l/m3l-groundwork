# TypeScript refresh tracker

<!-- typescript-refresh: last-verified=unset typescript-version=unset -->

Living record of `typescript-guidance` (refresh mode) sweeps — the
per-facet, per-source state a run diffs against, so each sweep reports what
**changed** since the last one instead of rediscovering the whole toolchain
from scratch. Updated **in place** on every run, never as a new dated file.

`typescript-version` in the header records the newest **upstream**
TypeScript release the last sweep verified against — deliberately distinct
from `package.json`'s own `typescript` devDependency pin, which this
tracker exists to check against, not restate. The two numbers disagreeing
is not a bug in the tracker; it's the finding.

This tracker has not had its first sweep yet (`last-verified=unset`). Run
`typescript-guidance` in refresh mode — or let `/customize`'s guidance pass
seed it — to populate the sections below.

## Outstanding drift

_(none recorded yet — first sweep populates this section)_

## Facet state

| Facet                        | Last verified | Notes |
| ---------------------------- | ------------- | ----- |
| `compiler-config-flags`      | unset         |       |
| `modules-esm-node-interop`   | unset         |       |
| `packaging-declaration-emit` | unset         |       |
| `lint-typing-rules`          | unset         |       |
| `testing-language-features`  | unset         |       |
