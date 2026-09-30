# Area catalog -- signals to detect, questions to research

For each area: what to look for in `gaps` mode's step 1 (the signal), and what to ask a
step 2 research agent (the question). **This file holds no answers** --
an answer here would be exactly the kind of baked-in claim that goes stale
within months. Pick the areas step 1's signals make relevant; don't
research every area unconditionally on every run.

## tsconfig flags and deprecations

- **Signal**: the resolved tsconfig chain (step 1) is missing a
  strict-family flag entirely, or sets no `target`/`lib` at all for the
  project's actual runtime.
- **Research**: what compiler options does the current TypeScript release
  recommend adding for this project's runtime target (Node-only, browser,
  both), for a tsconfig that doesn't set them yet? (Whether an option the
  project already sets has since been deprecated, or an already-set
  `target`/`lib` is now outdated, is drift in existing config --
  `research`/`refresh`'s question, not `gaps` mode's; hand it off rather
  than research it here.)

## module resolution by project kind

- **Signal**: no `moduleResolution` set anywhere in the resolved tsconfig
  chain at all.
- **Research**: what does the current TypeScript Modules reference recommend
  for this project's actual shipping shape (published package vs. bundled
  app vs. both), for a tsconfig that doesn't set one yet? (An already-set
  `moduleResolution` that doesn't match what the project actually ships --
  a package with an `exports` map on `node16`/`nodenext` that should be on
  `bundler`, say -- is drift in existing config, `research`/`refresh`'s
  question, not `gaps` mode's.)

## typed linting

- **Signal**: `eslint.config.js` has no `typescript-eslint` typed-linting
  preset (`recommendedTypeChecked`/`strictTypeChecked`/`stylisticTypeChecked`)
  configured at all.
- **Research**: what does typescript-eslint's current documentation recommend
  for a project with no typed linting yet -- and, since a recommendation to
  add it must actually be installable, does the version that would be added
  support the project's current TypeScript version? This is exactly the kind
  of cross-project compatibility gap a stale skill answer would miss (a new
  TypeScript major that `typescript-eslint` doesn't support yet, say).
  (Whether an _already-pinned_
  `typescript-eslint` version is stale or incompatible is drift in existing
  config -- `research`/`refresh`'s question, not `gaps` mode's.)

## testing

- **Signal**: no test runner configured at all.
- **Research**: what does the current official docs of a reasonable default
  test runner recommend for a TypeScript project with none configured yet --
  config shape, coverage tooling, and any TypeScript-specific caveat
  (type-checking test files, `expectTypeOf`-style assertions)? (A runner that
  already exists but has no coverage gate, or whose config no longer matches
  its own current docs, is drift in existing config -- `research`/`refresh`'s
  question via its `testing-language-features` facet, not `gaps` mode's.)

## packaging and export validation

- **Signal**: a published package (has a `bin` or `exports` field, isn't
  `private: true`) with no `publint`/`arethetypeswrong` check wired into its
  verify gate.
- **Research**: what do `publint.dev` and `arethetypeswrong.github.io`
  currently flag as common packaging mistakes, and is either tool's current
  recommended invocation different from a bare CLI call (e.g. a config
  flag this project should pass)?

## dependency hygiene

- **Signal**: no `knip` (or equivalent unused-export/unused-dependency
  tool) configured at all.
- **Research**: what does `knip.dev`'s current documentation recommend for
  a project shaped like this one (workspaces, multiple entry points, a CLI
  `bin`) that has no such tool yet? (An existing `knip.json` that looks stale
  against the project's actual entry points is drift in existing config, not
  absence -- `knip.json` is a `research`/`refresh` domain file; switch mode
  rather than researching a fix here.)

## pnpm supply-chain settings

- **Signal**: `pnpm-workspace.yaml`/`.npmrc` has no supply-chain-hardening
  setting configured at all -- no lifecycle-script allowlist, no
  `packageManager` corepack pin in `package.json`, no audit setting.
- **Research**: what supply-chain-hardening settings does the project's
  actual pnpm major currently document (lifecycle-script allowlisting,
  `minimumReleaseAge`, audit settings), for a project that has none
  configured yet? (Whether an existing setting has since been renamed or
  removed by a newer pnpm major -- a lifecycle-script allowlist key moving
  to a different file, for example -- is drift in something already
  configured, not absence; hand it to `research`/`refresh` rather than
  research it here, since `pnpm-workspace.yaml` is one of its own domain
  files.)

## scripts and verify gates

- **Signal**: a check this project runs by hand (or not at all) that a
  comparable project would gate in CI -- a missing `check:exports`-equivalent
  on a published package, no `pnpm verify`-shaped aggregator at all.
- **Research**: n/a in the live-fetch sense (this is a project-structure
  question, not an upstream-guidance one) -- but check whether the project's
  gate runner shape (a package script vs. a dedicated
  `bin/verify.mjs`-style aggregator) matches current tooling convention for
  its ecosystem before recommending which shape to add.

## monorepo and catalogs

- **Signal**: multiple `package.json` files under one root with no
  `pnpm-workspace.yaml`, or a workspace with repeated identical dependency
  version pins across packages that pnpm's `catalog`/`catalogs` feature
  exists to deduplicate.
- **Research**: what does pnpm's current workspace/catalog documentation
  recommend for this shape, and does the pinned pnpm major actually support
  the catalog syntax being recommended?

## Node version pinning

- **Signal**: no Node version pin anywhere at all -- no `.node-version`, no
  `.nvmrc`, no `engines.node`.
- **Research**: what does `nodejs.org`'s current release schedule recommend
  pinning to for a new project? (A disagreement between multiple existing
  pins, or a pin that's already past its documented end-of-life, is drift in
  something already configured -- `research`/`refresh`'s question, not
  `gaps` mode's.)

## release automation

- **Signal**: a package that's published (not `private: true`) with no
  automated release pipeline (no changesets, no equivalent version-bump
  automation).
- **Research**: what does `changesets/changesets`'s current documentation
  recommend for this project's publishing shape (single package vs.
  workspace)? If the project already has a release workflow, that is drift
  in existing config, not a gap -- hand it to `research`/`refresh`.
