---
"@monte3l/groundwork": patch
---

Adds a `publishing` pack: a release pipeline for a project that ships an npm package.

- `.github/workflows/release.yml`, generalized from this repo's own workflow: changesets version-PR / staged, provenance-attested npm publish via trusted publishing OIDC.
- `check-publish-version.mjs` and `check-dts-deps.mjs`: two new `build`-group verify steps, both no-oping cleanly on a `private: true` package (the baseline's own default).
- `check-license-headers.mjs` (generalized with a `__PROJECT_NAME__` token in place of a hardcoded copyright holder) and a `REUSE.toml` template, as a new `lint`-group verify step.
- `.changeset/config.json` + `README.md`, and the `changeset`/`version:packages` package scripts.

Fresh mode only: the release flow encodes decisions (registry access, npm trusted-publisher setup, a GitHub App for the version PR) too project-specific for an automated adopt-mode install; its `adoptNotes` cover the one-time setup this depends on, including that it cannot wire `@changesets/cli` itself (the pack wiring contract only extends `package.json`'s `scripts`, never its dependencies).
