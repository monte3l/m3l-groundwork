# Cloudflare docs site: pointer

This project's docs site deploys to Cloudflare Workers Static Assets at
[`groundwork.monte3l.com`](https://groundwork.monte3l.com). The standard, the
one-time setup, the zone settings and the runbook are the same for every
monte3l project and live in the org runbook:
[blueprint/docs-site.md](https://github.com/monte3l/.github/blob/main/blueprint/docs-site.md).
Read that first. This page keeps only what is specific to m3l-groundwork. It
is not a page of the site itself (`docs.config.mjs` excludes it), so it is read
on GitHub.

## Groundwork-specific facts

| Item               | Value                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder            | The vendored docs kit, `design/source/docs-kit/`, configured by `docs.config.mjs`                                                                                                      |
| Workflows          | `.github/workflows/docs.yml` (build, deploy, smoke) and `.github/workflows/docs-live.yml` (daily)                                                                                      |
| Deploy tools       | `tools/deploy/` (`package.json`, `package-lock.json`, `wrangler.jsonc`). It is under `tools/`, not `.github/`, because Dependabot cannot open a PR that changes files under `.github/` |
| Worker and domain  | Worker `m3l-groundwork-docs`, Custom Domain `groundwork.monte3l.com`                                                                                                                   |
| GitHub environment | `docs-cloudflare`, restricted to `main`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`                                                                                       |
| Token              | `gh-m3l-groundwork-docs`. Its expiry is recorded in `SECURITY.md`'s secrets table                                                                                                      |
| Metadata parity    | `docs.config.mjs`'s `manifest` is `packages/cli/package.json`, and `docs-live.yml` passes `--metadata`                                                                                 |

## Dependency overrides

`tools/deploy/package.json` carries an `overrides` floor for two packages.

- `undici: ^7.29.1`, because wrangler 4.141.0's miniflare resolves an undici
  with open advisories. Drop it once miniflare itself requires undici 7.29.1
  or later.
- `sharp: ^0.35.5`, because miniflare pins sharp 0.35.4 exactly, which carries
  GHSA-wq5f-xc86-pv6w (fixed in 0.35.5). Drop it once miniflare itself
  requires sharp 0.35.5 or later.

`.github/workflows/dependency-review.yml` allows the LGPL libvips binaries
that `sharp` pulls in, by package name rather than by license.

## Accepted trade-off: the `.html` redirect hop

`tools/deploy/wrangler.jsonc` sets `html_handling: "auto-trailing-slash"`
(Cloudflare's default) rather than `"none"`, because `"none"` breaks `/` (no
automatic `index.html` at the root path, confirmed with a local `wrangler dev`
run). Every link the kit generates points at an explicit `.html` file, and
`auto-trailing-slash` 307-redirects each one to the extensionless path before
serving it. That is one extra edge-served hop per navigation, accepted on
purpose.
