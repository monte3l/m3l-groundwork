---
paths:
  - "docs.config.mjs"
  - "design/source/docs-kit/**"
  - ".github/workflows/docs-live.yml"
  - ".github/workflows/docs.yml"
  - "tools/deploy/**"
---

# Docs site rules (`docs.config.mjs`, the vendored docs kit, `docs.yml`)

> This file is the terse checklist that auto-loads when you touch the docs
> site config, the vendored kit or the deploy workflow. The standard and the
> Cloudflare runbook are org-wide:
> [blueprint/docs-site.md](https://github.com/monte3l/.github/blob/main/blueprint/docs-site.md).
> `docs/cloudflare-docs.md` keeps only what is specific to this repo.

**The docs site** (`.github/workflows/docs.yml`, deployed from `main` to
`https://groundwork.monte3l.com` on Cloudflare Workers Static Assets) is built
by the **docs kit**, which ships inside the m3l-design release and is vendored
at `design/source/docs-kit/`. The kit is a restricted, zero-dependency
Markdown-to-HTML renderer and site builder. Its contract (config keys, CLI,
exit codes, every gate) is `design/source/docs-kit/README.md`. This repo owns
only `docs.config.mjs`, the deploy wiring and the workflows.

**Never edit the kit here.** `design/source/` is verbatim and
`design/SHA256SUMS` proves it, so a local edit fails `--check`. A renderer,
headers or live-check change is made in m3l-design and arrives by
`bin/sync-design.sh`. A page-shell layout change goes in `design/local/`,
which does not exist today and is held to `var(--token)` values only.

**`docs.config.mjs` is where this site is defined:**

- `pages` are the ten rendered pages: README (as `index.html`), CONTRIBUTING,
  GOVERNANCE, ROADMAP, CODE_OF_CONDUCT, SECURITY, and four `docs/*.md` pages.
  `navGroups` order the sidebar, and `nav` holds the top links (Security,
  GitHub, npm).
- `exclude` lists every other tracked `*.md` file with a reason. A new
  Markdown file anywhere in the repo fails `--check` until it is added to
  `pages` or covered by an `exclude` entry, and a stale entry fails too.
- `manifest` is `packages/cli/package.json`. Its `homepage` must equal
  `siteUrl`, and `check-live.mjs --metadata` compares its description,
  homepage and keywords with the GitHub repository's.

**The renderer is restricted, not general CommonMark.** It throws rather than
guessing on anything outside its subset (an h4 or deeper, an unknown footnote
reference, raw HTML). A page that stops building is fixed in its source
Markdown, never in the renderer. Every internal link to a page becomes a
relative link to its output file, and a link to any other repo file becomes a
`github.com/.../blob/main/<path>` link.

**`node design/source/docs-kit/build.mjs --check`** is the `docs` step in
`bin/lib/verify-steps.mjs`'s `build` group. It builds to a throwaway
directory and fails on a broken link or anchor, an italic span (the same
bold-not-italic rule `.claude/rules/docs.md` states), a `_headers` file over
Cloudflare's limits, uncovered or stale Markdown, a `design/SHA256SUMS`
mismatch, a literal in `design/local/`, more than two alerts in a row, and a
manifest `homepage` that is not the site URL. `--out <dir>` writes the real
site. `docs.yml`'s `build` job runs it with no `pnpm install`, since the kit
uses Node builtins only.

**Deploy.** The `deploy` job runs `wrangler deploy` from `tools/deploy/` (a
pinned, lockfile-verified `wrangler`, installed with `--ignore-scripts`)
against `tools/deploy/wrangler.jsonc`, with a Cloudflare API token held in the
`docs-cloudflare` GitHub environment (`main`-only, no GitHub App). The `smoke`
job then runs `check-live.mjs --site _site` against the same artifact: every
page, the 404 page and every asset on the live site must equal the built
file, and each response must carry every `_headers` header at its exact
value. `docs-live.yml` repeats it daily against a fresh build of `main` with
`--metadata`.
