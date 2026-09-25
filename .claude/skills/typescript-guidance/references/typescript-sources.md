# Upstream TypeScript sources — the allowlist

The single source list consulted by `typescript-guidance` in both modes.
Editing this file is the one edit site when the tiering changes.

## Domain allowlist

Pass verbatim as `WebSearch`'s `allowed_domains`:

```
typescriptlang.org, www.typescriptlang.org, devblogs.microsoft.com,
nodejs.org, typescript-eslint.io, arethetypeswrong.github.io, publint.dev
```

Plus **the official docs of a tool the project's interview actually
selected** for testing/bundling (e.g. `vitest.dev`, a chosen bundler's
docs) — this is what gives the `testing-language-features` facet a source
family, since none of the domains above owns a test runner's own docs.

Two of the fixed domains are **path-scoped within an otherwise broader
domain**:

- `devblogs.microsoft.com` hosts every Microsoft product's blog. Only
  `/typescript/` paths are in scope here.
- `nodejs.org` hosts the whole Node.js documentation site. Only `/api/`
  paths — principally `/api/typescript.html` — are in scope here.

## The two tiers

**T1 — owner-normative.** A claim from here can be cited as-is.

- `typescriptlang.org` — the Handbook, the tsconfig reference, the Modules
  reference.
- `devblogs.microsoft.com/typescript` — release announcements, the
  authoritative record of breaking changes.
- `github.com/microsoft/TypeScript` — releases, milestones, wiki Design
  Notes.
- `nodejs.org/api/typescript.html` — co-normative T1 for the
  Node↔TypeScript runtime boundary (type stripping, `erasableSyntaxOnly`).
  A disagreement across that seam is a genuine two-owner conflict to
  surface, not a T1-vs-T2 subordination to resolve silently.

**T2 — owner-adjacent / executable spec.** Citable, but state the scope
limit.

- `typescript-eslint.io` — rule semantics, and the exact composition of the
  `recommendedTypeChecked`/`strictTypeChecked`/`stylisticTypeChecked`
  presets.
- `arethetypeswrong.github.io` — packaging correctness rules (dual-format
  resolution, `exports`-map type resolution failure modes).
- `publint.dev` — package-publishing correctness rules.
- The selected test/bundler tool's own docs — behavior and current
  recommendation for that tool specifically.

**Explicitly out of scope.** Named here so an agent that finds one of these
drops it and says so, rather than quietly substituting it for missing T1/T2
coverage:

- `github.com/tsconfig/bases` — actively maintained ecosystem consensus,
  but consensus, not the owner's word.
- Individual authors and their published material — no normative standing.

## GitHub caveat

`allowed_domains` filters by domain, not path, so a bare `github.com`
allowance would let through any repo. Agents may include `github.com` and
`raw.githubusercontent.com` in their search domains, but must **only cite or
fetch URLs under `microsoft/TypeScript`, `microsoft/TypeScript-Website`, or
`arethetypeswrong/arethetypeswrong.github.io`** — and drop any other GitHub
result, however highly ranked.

## First-class sources to enumerate directly

Search ranking is not exhaustive — a recent devblog post or an individual
tsconfig option page can rank poorly and simply not surface. Enumerate these
directly rather than relying on search alone:

- `https://devblogs.microsoft.com/typescript/` — the release-announcement
  index; read as a **delta** from a known prior version in refresh mode.
- `https://github.com/microsoft/TypeScript/releases` — the machine-readable
  version list; cross-check the devblog against it.
- `https://www.typescriptlang.org/tsconfig/` — the per-option compiler-flag
  reference.
- `https://www.typescriptlang.org/docs/handbook/modules/reference.html` —
  the Modules reference (`nodenext`/`bundler` resolution modes, ESM/CJS
  interop).
- `https://nodejs.org/api/typescript.html` — Node's type-stripping page.
- `https://typescript-eslint.io/users/configs/` — preset composition.

## Coverage discipline

Reject any non-allowlisted domain outright and say so in the report, rather
than substituting a community blog, an individual author's material, or a
Stack Overflow answer for missing T1/T2 coverage. If a facet turns up no
qualifying source, that is itself a reportable finding (a coverage gap), not
a reason to lower the bar.

## Current-date anchor

Every agent brief must state today's date explicitly — a `retrieved <date>`
stamp otherwise depends on the spoke inferring the date itself, which is
unreliable.
